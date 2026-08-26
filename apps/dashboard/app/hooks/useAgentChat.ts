"use client";

/**
 * Streaming chat hook for testing a deployed agent via the core service API.
 * Uses AI SDK utilities to parse the UIMessage SSE stream.
 */
import {
  isStreamProtocolError,
  runtimeStreamErrorText,
} from "@/app/lib/chatErrors";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import type { UIMessage } from "ai";
import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
} from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

type ChatStatus = "ready" | "streaming" | "error";

/** What `useAgentChat` hands its caller: the transcript plus the two controls. */
export interface AgentChat {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | null;
  /** The conversation key the chat is on, once the server has assigned one. */
  sessionId: string | undefined;
  sendMessage: (text: string) => Promise<void>;
  resetChat: () => void;
}

const WEBSOCKET_CONNECT_TIMEOUT_MS = 2000;

type WsServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | { type: "sse"; chunk: string }
  | { type: "continuation_delta"; delta: string }
  | {
      type: "subagent_delta";
      sessionId: string;
      taskId: string;
      agentName?: string;
      delta: string;
    }
  | {
      type: "subagent_activity";
      sessionId: string;
      taskId: string;
      agentName?: string;
      phase: "started" | "tool_call" | "tool_result";
      toolNames?: string[];
    }
  | { type: "subagent_result"; output: string }
  /**
   * The runtime's resumable-stream frame: one AI-SDK stream part wrapped with
   * replay bookkeeping. `data` carries the same payload the HTTP/SSE path
   * emits after `data: `, and `data.type === "done"` is the terminal marker —
   * the socket itself is left open by the server.
   */
  | {
      type: "output";
      data: { type: string } & Record<string, unknown>;
      eventId?: string;
      cursor?: string;
      replay?: boolean;
    }
  | { type: "done" }
  | { type: "error"; error: string; status?: number };

/**
 * Re-shape a runtime stream part into the AI SDK's UI-message-chunk form.
 *
 * The runtime emits `streamText`'s text-stream parts, which carry the payload
 * as `text`, while `uiMessageChunkSchema` (used by `parseJsonEventStream`
 * below) requires `delta`. The names differ only for the *-delta parts, so
 * everything else passes through untouched. Without this the schema rejected
 * every delta, the transform silently dropped it, and the chat sat on
 * "Thinking …" forever while the agent was in fact answering correctly.
 *
 * Exported for the frame-translation tests, which replay live-captured
 * runtime frames through this exact function.
 */
export function toUiMessageChunk(
  part: { type: string } & Record<string, unknown>,
): { type: string } & Record<string, unknown> {
  // Same field mismatch for error frames: the runtime says `error`, the
  // schema requires `errorText`. Without this the failure frame is dropped
  // and the chat sits on "Thinking …" instead of showing the error card.
  if (
    part.type === "error" &&
    typeof part.error === "string" &&
    !("errorText" in part)
  ) {
    const { error, ...errorRest } = part;

    return { ...errorRest, type: part.type, errorText: error };
  }

  // Tool frames arrive as `streamText` full-stream parts, which the UI chunk
  // schema does not accept — without these mappings every one was silently
  // dropped and tool use was invisible in the chat. Shapes verified against
  // a live frame dump (see ticket 14):
  //   tool-input-start/-delta carry the call id as `id` (UI wants
  //   `toolCallId`) and the delta as `delta` (UI wants `inputTextDelta`);
  //   `tool-call` -> `tool-input-available`; `tool-result` ->
  //   `tool-output-available`; `tool-error` -> `tool-output-error` with a
  //   string `errorText`. `tool-input-end` has no UI equivalent (the
  //   tool-call frame that follows carries the final input) and is dropped
  //   by the schema, which is correct.
  if (part.type === "tool-input-start" && typeof part.id === "string") {
    const { id, ...rest } = part;

    return { ...rest, type: part.type, toolCallId: id };
  }
  if (
    part.type === "tool-input-delta" &&
    typeof part.id === "string" &&
    typeof part.delta === "string"
  ) {
    const { id, delta, ...rest } = part;

    return {
      ...rest,
      type: part.type,
      toolCallId: id,
      inputTextDelta: delta,
    };
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string") {
    return { ...part, type: "tool-input-available" };
  }
  if (part.type === "tool-result" && typeof part.toolCallId === "string") {
    return { ...part, type: "tool-output-available" };
  }
  if (part.type === "tool-error" && typeof part.toolCallId === "string") {
    const { error, ...rest } = part;

    return {
      ...rest,
      type: "tool-output-error",
      errorText:
        typeof error === "string" ? error : JSON.stringify(error ?? null),
    };
  }

  const isDelta = part.type === "text-delta" || part.type === "reasoning-delta";
  if (!isDelta || typeof part.text !== "string" || "delta" in part) {
    return part;
  }
  const { text, ...rest } = part;

  return { ...rest, type: part.type, delta: text };
}

type SubagentPanelEvent = {
  phase: "started" | "tool_call" | "tool_result";
  text: string;
  toolNames?: string[];
};

type SubagentPanelPart = {
  type: "subagent-panel";
  taskId: string;
  sessionId: string;
  agentName?: string;
  status: "running" | "completed";
  events: SubagentPanelEvent[];
  text: string;
};

type WebSocketStreamResult = {
  stream: ReadableStream<Uint8Array>;
};

type HttpStreamResult = {
  stream: ReadableStream<Uint8Array>;
  sessionId?: string;
};

/**
 * Owner-authenticated internal test transport (ticket 15): the Convex
 * `/v1/dashboard/test-agent` HTTP action proxies the turn to the runtime's
 * internal caller class, which is never gated on Public access. Serves the
 * same AI-SDK SSE stream as the public HTTP path.
 */
export interface InternalTestTransport {
  invokeUrl: string;
  configId: string;
  /** Returns the caller's WorkOS session JWT, or null when signed out. */
  fetchToken: () => Promise<string | null>;
}

async function startInternalSseStream(options: {
  transport: InternalTestTransport;
  message: string;
  sessionId?: string;
  signal: AbortSignal;
}): Promise<HttpStreamResult> {
  const { transport, message, sessionId, signal } = options;
  const token = await transport.fetchToken();
  if (!token) {
    throw new Error("You are signed out. Sign in again to test this agent.");
  }
  const conversationKey = sessionId || `chat-${crypto.randomUUID()}`;

  const response = await fetch(transport.invokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      configId: transport.configId,
      text: message,
      conversationKey: conversationKey,
    }),
    signal: signal,
  });

  if (!response.ok) {
    // Keep the whole body for the error card's resolver + raw disclosure.
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      responseBody.trim() ||
        `Internal test request failed with status ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new Error("Response body is empty");
  }

  return {
    stream: response.body,
    sessionId: response.headers.get("X-Session-Id") ?? conversationKey,
  };
}

async function startHttpSseStream(options: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  baseUrl: string;
  projectSlug?: string;
  stageSlug?: string;
  message: string;
  sessionId?: string;
  signal: AbortSignal;
}): Promise<HttpStreamResult> {
  const {
    endpointId,
    agentId,
    apiKey,
    baseUrl,
    projectSlug,
    stageSlug,
    message,
    sessionId,
    signal,
  } = options;

  const stagePrefix = stageSlug ? `/${stageSlug}` : "";
  const projectPrefix = projectSlug ? `/${projectSlug}` : "";
  const endpointUrl = `${baseUrl.replace(/\/+$/, "")}/v1${projectPrefix}/agents${stagePrefix}/${endpointId}`;
  const conversationKey = sessionId || `chat-${crypto.randomUUID()}`;

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      agentId: agentId,
      eventId: `evt-${crypto.randomUUID()}`,
      conversationKey: conversationKey,
      events: [
        {
          role: "user",
          content: [{ type: "text", text: message }],
        },
      ],
      stream: true,
    }),
    signal: signal,
  });

  if (!response.ok) {
    // Keep the whole body: the error card's resolver reads the `code` field
    // out of the core service's JSON payload, and the raw text is preserved
    // behind the card's "Show details" disclosure.
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      responseBody.trim() ||
        `HTTP stream request failed with status ${response.status}.`,
    );
  }

  if (!response.body) {
    throw new Error("Response body is empty");
  }

  return {
    stream: response.body,
    sessionId: response.headers.get("X-Session-Id") ?? conversationKey,
  };
}

async function startWebSocketSseStream(options: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  websocketBaseUrl: string;
  projectSlug?: string;
  stageSlug?: string;
  message: string;
  sessionId?: string;
  signal: AbortSignal;
  onMeta: (meta: { sessionId: string; taskId: string }) => void;
  onContinuationDelta: (delta: string) => void;
  onSubagentDelta: (event: {
    sessionId: string;
    taskId: string;
    agentName?: string;
    delta: string;
  }) => void;
  onSubagentActivity: (event: {
    sessionId: string;
    taskId: string;
    agentName?: string;
    phase: "started" | "tool_call" | "tool_result";
    toolNames?: string[];
  }) => void;
  onSubagentResult: (output: string) => void;
}): Promise<WebSocketStreamResult> {
  const {
    endpointId,
    agentId,
    apiKey,
    websocketBaseUrl,
    projectSlug,
    stageSlug,
    message,
    sessionId,
    signal,
    onMeta,
    onContinuationDelta,
    onSubagentDelta,
    onSubagentActivity,
    onSubagentResult,
  } = options;

  const stagePrefix = stageSlug ? `/${stageSlug}` : "";
  const projectPrefix = projectSlug ? `/${projectSlug}` : "";
  const wsUrl =
    `${websocketBaseUrl}/v1${projectPrefix}/agents${stagePrefix}/${endpointId}/ws` +
    `?token=${encodeURIComponent(apiKey)}`;

  const socket = new WebSocket(wsUrl);
  const encoder = new TextEncoder();

  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let opened = false;
  let settled = false;
  // Text part ids we have already forwarded a `text-start` for. The runtime's
  // resumable stream does not guarantee ordering, so a `text-delta` can arrive
  // before its `text-start`; `readUIMessageStream` then rejects the whole
  // stream with "Received text-delta for missing text part". Synthesising the
  // missing start keeps the reply renderable whatever order frames land in.
  const startedTextIds = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    start: function (controller) {
      streamController = controller;
    },
    cancel: function () {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "cancelled");
      }
    },
  });

  return await new Promise<WebSocketStreamResult>((resolve, reject) => {
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else if (streamController) {
        streamController.error(error);
        streamController = null;
      }

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        // 1011 is a SERVER-only close code: `close()` throws
        // InvalidAccessError when a page passes anything outside 1000 or
        // 3000-4999. Relaying the server's code here crashed the handler
        // mid-failure, which swallowed the real error and left the UI stuck
        // on "Thinking …". Close normally and let `error` carry the reason.
        socket.close(1000, error.message.slice(0, 120));
      }
    };

    const finishStream = () => {
      if (streamController) {
        try {
          streamController.close();
        } catch {
          // Consumer already errored the stream — nothing left to signal.
        }
        streamController = null;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "done");
      }
    };

    const onAbort = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel" }));
      }
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "aborted");
      }
      if (streamController) {
        streamController.error(new DOMException("Aborted", "AbortError"));
        streamController = null;
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });

    const timeoutId = window.setTimeout(() => {
      if (!opened) {
        fail(new Error("WebSocket connection timeout."));
      }
    }, WEBSOCKET_CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      opened = true;
      window.clearTimeout(timeoutId);

      if (signal.aborted) {
        onAbort();

        return;
      }

      socket.send(
        JSON.stringify({
          type: "execute",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: message }],
            },
          ],
          agentId: agentId,
          sessionId: sessionId,
        }),
      );

      if (!settled) {
        settled = true;
        resolve({
          stream: stream,
        });
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let payload: WsServerMessage;
      try {
        payload = JSON.parse(event.data) as WsServerMessage;
      } catch {
        return;
      }

      if (payload.type === "meta") {
        onMeta({
          sessionId: payload.sessionId,
          taskId: payload.taskId,
        });

        return;
      }

      if (payload.type === "sse") {
        if (streamController) {
          streamController.enqueue(encoder.encode(payload.chunk));
        }

        return;
      }

      // Resumable-stream frames. The runtime wraps each AI-SDK stream part in
      // an `output` envelope instead of sending a raw `sse` chunk, so re-frame
      // it as SSE for the shared reader. Without this branch every content
      // frame was dropped and the UI streamed nothing at all.
      if (payload.type === "output") {
        if (payload.data.type === "done") {
          finishStream();

          return;
        }
        if (streamController) {
          const chunk = toUiMessageChunk(payload.data);
          const partId = typeof chunk.id === "string" ? chunk.id : null;
          const startType =
            chunk.type === "reasoning-delta" || chunk.type === "reasoning-end"
              ? "reasoning-start"
              : "text-start";
          if (partId !== null) {
            if (
              chunk.type === "text-start" ||
              chunk.type === "reasoning-start"
            ) {
              // A start we already synthesised below: forwarding the real one
              // too would open a second part with the same id and orphan the
              // text collected so far.
              if (startedTextIds.has(partId)) {
                return;
              }
              startedTextIds.add(partId);
            } else if (
              /^(text|reasoning)-(delta|end)$/.test(chunk.type) &&
              !startedTextIds.has(partId)
            ) {
              startedTextIds.add(partId);
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: startType, id: partId })}\n\n`,
                ),
              );
            }
          }
          streamController.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }

        return;
      }

      if (payload.type === "subagent_result") {
        onSubagentResult(payload.output);

        return;
      }

      if (payload.type === "continuation_delta") {
        onContinuationDelta(payload.delta);

        return;
      }

      if (payload.type === "subagent_delta") {
        onSubagentDelta({
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          agentName: payload.agentName,
          delta: payload.delta,
        });

        return;
      }

      if (payload.type === "subagent_activity") {
        onSubagentActivity({
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          agentName: payload.agentName,
          phase: payload.phase,
          toolNames: payload.toolNames,
        });

        return;
      }

      if (payload.type === "done") {
        finishStream();

        return;
      }

      if (payload.type === "error") {
        fail(new Error(payload.error || "WebSocket stream error."));
      }
    };

    socket.onerror = () => {
      fail(new Error("WebSocket transport error."));
    };

    socket.onclose = (event) => {
      signal.removeEventListener("abort", onAbort);
      window.clearTimeout(timeoutId);

      if (!opened) {
        fail(new Error(event.reason || "WebSocket closed before opening."));

        return;
      }

      if (streamController) {
        // The consumer can have errored the stream already (e.g.
        // `readUIMessageStream` terminating on a chunk-ordering violation);
        // close()/error() then throw an uncaught TypeError inside the socket
        // handler. The stream is finished either way — swallow it.
        try {
          if (event.code === 1000 || signal.aborted) {
            streamController.close();
          } else {
            streamController.error(
              new Error(event.reason || "WebSocket connection closed."),
            );
          }
        } catch {
          // Already closed or errored — nothing left to signal.
        }
        streamController = null;
      }
    };
  });
}

function isSubagentPanelPart(value: unknown): value is SubagentPanelPart {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "subagent-panel" &&
    typeof (value as { taskId?: unknown }).taskId === "string"
  );
}

function upsertMainAssistantMessage(options: {
  previousMessages: UIMessage[];
  messageId: string | null;
  assistantMessage: UIMessage;
}): { messages: UIMessage[]; messageId: string } {
  const requestedId = options.messageId;
  const assistantId =
    typeof options.assistantMessage.id === "string" &&
    options.assistantMessage.id.length > 0
      ? options.assistantMessage.id
      : null;
  const resolvedId = assistantId ?? requestedId ?? crypto.randomUUID();

  const existingIndex = options.previousMessages.findIndex((message) => {
    if (assistantId && message.id === assistantId) {
      return true;
    }
    if (requestedId && message.id === requestedId) {
      return true;
    }

    return false;
  });

  const normalizedMessage: UIMessage = {
    ...options.assistantMessage,
    id: resolvedId,
  };

  if (existingIndex >= 0) {
    const nextMessages = [...options.previousMessages];
    nextMessages[existingIndex] = normalizedMessage;

    return {
      messages: nextMessages,
      messageId: resolvedId,
    };
  }

  return {
    messages: [...options.previousMessages, normalizedMessage],
    messageId: resolvedId,
  };
}

function appendAssistantTextDelta(options: {
  previousMessages: UIMessage[];
  messageId: string | null;
  delta: string;
}): { messages: UIMessage[]; messageId: string } {
  if (!options.delta) {
    return {
      messages: options.previousMessages,
      messageId: options.messageId ?? crypto.randomUUID(),
    };
  }

  if (options.messageId) {
    const index = options.previousMessages.findIndex(
      (message) => message.id === options.messageId,
    );
    if (index >= 0) {
      const existing = options.previousMessages[index];
      const currentText = existing.parts
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      const nextMessages = [...options.previousMessages];
      nextMessages[index] = {
        ...existing,
        parts: [{ type: "text", text: `${currentText}${options.delta}` }],
      };

      return {
        messages: nextMessages,
        messageId: options.messageId,
      };
    }
  }

  const newMessageId = options.messageId ?? crypto.randomUUID();

  return {
    messages: [
      ...options.previousMessages,
      {
        id: newMessageId,
        role: "assistant",
        parts: [{ type: "text", text: options.delta }],
      },
    ],
    messageId: newMessageId,
  };
}

function formatSubagentActivityText(event: {
  phase: "started" | "tool_call" | "tool_result";
  toolNames?: string[];
}): string | null {
  if (event.phase === "started") {
    return null;
  }

  const toolNames = Array.isArray(event.toolNames)
    ? event.toolNames.filter(
        (name) => typeof name === "string" && name.trim().length > 0,
      )
    : [];
  const formattedTools =
    toolNames.length > 0 ? ` (${toolNames.join(", ")})` : "";

  if (event.phase === "tool_call") {
    return `Using tools${formattedTools}`;
  }

  return `Received tool results${formattedTools}`;
}

function upsertSubagentPanel(options: {
  previousMessages: UIMessage[];
  messageId: string | null;
  taskId: string;
  sessionId: string;
  agentName?: string;
  delta?: string;
  activityEvent?: {
    phase: "started" | "tool_call" | "tool_result";
    toolNames?: string[];
  };
  markCompleted?: boolean;
  completedOutput?: string;
}): { messages: UIMessage[]; messageId: string } {
  const updatePanel = (part: SubagentPanelPart): SubagentPanelPart => {
    const nextEvents = [...part.events];
    if (options.activityEvent) {
      const activityText = formatSubagentActivityText(options.activityEvent);
      if (activityText) {
        nextEvents.push({
          phase: options.activityEvent.phase,
          text: activityText,
          toolNames: options.activityEvent.toolNames,
        });
      }
    }

    let nextText = part.text;
    if (options.delta && options.delta.length > 0) {
      nextText += options.delta;
    }
    if (options.completedOutput && nextText.trim().length === 0) {
      nextText = options.completedOutput;
    }

    return {
      ...part,
      sessionId: options.sessionId || part.sessionId,
      agentName: options.agentName ?? part.agentName,
      status: options.markCompleted ? "completed" : part.status,
      events: nextEvents,
      text: nextText,
    };
  };

  const existingIndex = options.messageId
    ? options.previousMessages.findIndex(
        (message) => message.id === options.messageId,
      )
    : -1;

  if (existingIndex >= 0) {
    const existingMessage = options.previousMessages[existingIndex];
    const existingPanel = existingMessage.parts.find((part) =>
      isSubagentPanelPart(part),
    );
    if (existingPanel) {
      const nextMessages = [...options.previousMessages];
      nextMessages[existingIndex] = {
        ...existingMessage,
        parts: [
          updatePanel(existingPanel) as unknown as UIMessage["parts"][number],
        ],
      } as UIMessage;

      return {
        messages: nextMessages,
        messageId: options.messageId ?? crypto.randomUUID(),
      };
    }
  }

  const newMessageId = crypto.randomUUID();
  const initialPanel: SubagentPanelPart = updatePanel({
    type: "subagent-panel",
    taskId: options.taskId,
    sessionId: options.sessionId,
    agentName: options.agentName,
    status: options.markCompleted ? "completed" : "running",
    events: [],
    text: "",
  });

  const nextMessage = {
    id: newMessageId,
    role: "assistant",
    parts: [initialPanel as unknown],
  } as unknown as UIMessage;

  return {
    messages: [...options.previousMessages, nextMessage],
    messageId: newMessageId,
  };
}

/**
 * Streams chat messages from the core service and maintains conversation state.
 * @param endpointId Deployment endpoint ID
 * @param apiKey API key for bearer authentication
 * @param projectSlug Optional project slug for the URL path prefix
 * @param stageSlug Optional stage slug for the URL path prefix
 */
export function useAgentChat({
  endpointId,
  agentId,
  apiKey,
  projectSlug,
  stageSlug,
  webSocketEnabled,
  initialMessages,
  initialSessionId,
  internalTransport,
}: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  projectSlug?: string;
  stageSlug?: string;
  webSocketEnabled: boolean;
  /**
   * Persisted transcript to hydrate the chat with. Read once on mount —
   * callers remount (React `key`) to switch conversations.
   */
  initialMessages?: UIMessage[];
  /** Conversation key the next send continues instead of starting fresh. */
  initialSessionId?: string;
  /**
   * When set, sends go through the owner-authenticated internal endpoint
   * instead of the public runtime endpoint — private agents answer without
   * Public access. Pass a stable (memoised) object.
   */
  internalTransport?: InternalTestTransport;
}): AgentChat {
  const [messages, setMessages] = useState<UIMessage[]>(
    () => initialMessages ?? [],
  );
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<Error | null>(null);
  // Ref for send-time reads; state mirror so callers can react to the key.
  const [sessionId, setSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const sessionIdRef = useRef<string | undefined>(initialSessionId);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<UIMessage[]>([]);
  const mainAssistantMessageIdRef = useRef<string | null>(null);
  const continuationMessageIdRef = useRef<string | null>(null);
  const subagentMessageIdsRef = useRef<Record<string, string>>({});
  const coreEndpoint = resolveCoreEndpoint();
  const coreEndpointOk = coreEndpoint.ok;
  const coreEndpointMessage = coreEndpoint.ok ? "" : coreEndpoint.message;
  const baseUrl = coreEndpoint.ok ? coreEndpoint.httpBaseUrl : "";
  const websocketBaseUrl = coreEndpoint.ok ? coreEndpoint.websocketBaseUrl : "";

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Abort in-flight streams when the component using this hook unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /** Send a message and stream the assistant response. */
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Append user message
      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: trimmed }],
      };
      setMessages((prev) => [...prev, userMessage]);
      setStatus("streaming");
      setError(null);

      // Abort any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      mainAssistantMessageIdRef.current = null;
      continuationMessageIdRef.current = null;
      subagentMessageIdsRef.current = {};

      try {
        if (!internalTransport && !coreEndpointOk) {
          throw new Error(coreEndpointMessage);
        }

        let streamBody: ReadableStream<Uint8Array> | null = null;
        if (internalTransport) {
          const internalResult = await startInternalSseStream({
            transport: internalTransport,
            message: trimmed,
            sessionId: sessionIdRef.current,
            signal: controller.signal,
          });
          streamBody = internalResult.stream;
          if (internalResult.sessionId) {
            sessionIdRef.current = internalResult.sessionId;
            setSessionId(internalResult.sessionId);
          }
        }
        if (
          !streamBody &&
          webSocketEnabled &&
          typeof window !== "undefined" &&
          "WebSocket" in window
        ) {
          try {
            const wsResult = await startWebSocketSseStream({
              endpointId: endpointId,
              agentId: agentId,
              apiKey: apiKey,
              websocketBaseUrl: websocketBaseUrl,
              projectSlug: projectSlug,
              stageSlug: stageSlug,
              message: trimmed,
              sessionId: sessionIdRef.current,
              signal: controller.signal,
              onMeta: ({ sessionId: assignedSessionId }) => {
                sessionIdRef.current = assignedSessionId;
                setSessionId(assignedSessionId);
              },
              onContinuationDelta: (delta) => {
                setMessages((prev) => {
                  const next = appendAssistantTextDelta({
                    previousMessages: prev,
                    messageId: continuationMessageIdRef.current,
                    delta: delta,
                  });
                  continuationMessageIdRef.current = next.messageId;
                  messagesRef.current = next.messages;

                  return next.messages;
                });
              },
              onSubagentDelta: ({ taskId, sessionId, delta, agentName }) => {
                setMessages((prev) => {
                  const currentMessageId =
                    subagentMessageIdsRef.current[taskId] ?? null;
                  const next = upsertSubagentPanel({
                    previousMessages: prev,
                    messageId: currentMessageId,
                    taskId: taskId,
                    sessionId: sessionId,
                    delta: delta,
                    agentName: agentName,
                  });
                  subagentMessageIdsRef.current[taskId] = next.messageId;
                  messagesRef.current = next.messages;

                  return next.messages;
                });
              },
              onSubagentActivity: ({
                taskId,
                sessionId,
                agentName,
                phase,
                toolNames,
              }) => {
                setMessages((prev) => {
                  const currentMessageId =
                    subagentMessageIdsRef.current[taskId] ?? null;
                  const next = upsertSubagentPanel({
                    previousMessages: prev,
                    messageId: currentMessageId,
                    taskId: taskId,
                    sessionId: sessionId,
                    agentName: agentName,
                    activityEvent: {
                      phase: phase,
                      toolNames: toolNames,
                    },
                  });
                  subagentMessageIdsRef.current[taskId] = next.messageId;
                  messagesRef.current = next.messages;

                  return next.messages;
                });
              },
              onSubagentResult: (output) => {
                setMessages((prev) => {
                  const taskIds = Object.keys(subagentMessageIdsRef.current);
                  if (taskIds.length === 0) {
                    return prev;
                  }

                  let nextMessages = prev;
                  for (const taskId of taskIds) {
                    const next = upsertSubagentPanel({
                      previousMessages: nextMessages,
                      messageId: subagentMessageIdsRef.current[taskId] ?? null,
                      taskId: taskId,
                      sessionId: sessionIdRef.current ?? "",
                      markCompleted: true,
                      completedOutput: output,
                    });
                    subagentMessageIdsRef.current[taskId] = next.messageId;
                    nextMessages = next.messages;
                  }
                  messagesRef.current = nextMessages;

                  return nextMessages;
                });
              },
            });
            streamBody = wsResult.stream;
          } catch (error) {
            if ((error as Error).name === "AbortError") {
              throw error;
            }
          }
        }

        if (!streamBody) {
          const httpResult = await startHttpSseStream({
            endpointId: endpointId,
            agentId: agentId,
            apiKey: apiKey,
            baseUrl: baseUrl,
            projectSlug: projectSlug,
            stageSlug: stageSlug,
            message: trimmed,
            sessionId: sessionIdRef.current,
            signal: controller.signal,
          });
          streamBody = httpResult.stream;
          if (httpResult.sessionId) {
            sessionIdRef.current = httpResult.sessionId;
            setSessionId(httpResult.sessionId);
          }
        }

        // Parse SSE -> UIMessageChunk -> UIMessage
        const chunkStream = parseJsonEventStream({
          stream: streamBody,
          schema: uiMessageChunkSchema,
        }).pipeThrough(
          new TransformStream({
            transform: function (result, transformController) {
              if (result.success) {
                transformController.enqueue(result.value);

                return;
              }
              // The runtime's SSE frames differ from the schema in two known
              // ways — deltas carry `text` where it wants `delta`, and errors
              // carry `error` where it wants `errorText` — and used to be
              // dropped here, leaving an empty reply or an endless
              // "Thinking …". Re-frame them (same fix the WebSocket path
              // applies) instead of dropping.
              const errorText = runtimeStreamErrorText(result.rawValue);
              if (errorText !== null) {
                transformController.enqueue({
                  type: "error",
                  errorText: errorText,
                });

                return;
              }
              const raw = result.rawValue as
                ({ type?: unknown } & Record<string, unknown>) | null;
              if (raw && typeof raw.type === "string") {
                const reframed = toUiMessageChunk(
                  raw as { type: string } & Record<string, unknown>,
                );
                if (reframed !== raw) {
                  transformController.enqueue(
                    reframed as (typeof result & { success: true })["value"],
                  );
                }
              }
            },
          }),
        );

        const messageStream = readUIMessageStream({
          stream: chunkStream,
          terminateOnError: true,
        });

        for await (const assistantMessage of messageStream) {
          setMessages((prev) => {
            const next = upsertMainAssistantMessage({
              previousMessages: prev,
              messageId: mainAssistantMessageIdRef.current,
              assistantMessage: assistantMessage,
            });
            mainAssistantMessageIdRef.current = next.messageId;
            messagesRef.current = next.messages;

            return next.messages;
          });
        }

        setStatus("ready");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const message =
          err instanceof TypeError && err.message === "Failed to fetch"
            ? `Cannot reach core service at ${baseUrl}. Is the service running?`
            : err instanceof Error && err.message.includes("WebSocket")
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
        // Chunk-ordering complaints from `readUIMessageStream` are protocol
        // noise, not a user-facing condition (see ticket 14 for the cause).
        // Log them; when a reply already rendered, surface nothing at all.
        if (isStreamProtocolError(message)) {
          console.warn("[agent-chat] stream protocol warning:", message);
          const replyRendered = messagesRef.current.some(
            (m) =>
              m.role === "assistant" &&
              m.parts.some(
                (part) =>
                  part.type === "text" &&
                  "text" in part &&
                  part.text.trim().length > 0,
              ),
          );
          if (replyRendered) {
            setStatus("ready");

            return;
          }
        }
        setError(new Error(message));
        setStatus("error");
      }
    },
    [
      endpointId,
      agentId,
      apiKey,
      projectSlug,
      stageSlug,
      coreEndpointOk,
      coreEndpointMessage,
      baseUrl,
      websocketBaseUrl,
      webSocketEnabled,
      internalTransport,
    ],
  );

  /** Reset chat history and server session for a new conversation. */
  const resetChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("ready");
    setError(null);
    sessionIdRef.current = undefined;
    setSessionId(undefined);
    mainAssistantMessageIdRef.current = null;
    continuationMessageIdRef.current = null;
    subagentMessageIdsRef.current = {};
  }, []);

  return {
    messages: messages,
    status: status,
    error: error,
    sessionId: sessionId,
    sendMessage: sendMessage,
    resetChat: resetChat,
  };
}

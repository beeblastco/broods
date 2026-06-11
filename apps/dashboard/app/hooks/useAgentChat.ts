"use client";

/**
 * Streaming chat hook for testing a deployed agent via the gateway API.
 * Uses AI SDK utilities to parse the UIMessage SSE stream.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from "ai";
import type { UIMessage } from "ai";

type ChatStatus = "ready" | "streaming" | "error";
const WEBSOCKET_CONNECT_TIMEOUT_MS = 2000;

type WsServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | { type: "sse"; chunk: string }
  | { type: "continuation_delta"; delta: string }
  | { type: "subagent_delta"; sessionId: string; taskId: string; agentName?: string; delta: string }
  | {
    type: "subagent_activity";
    sessionId: string;
    taskId: string;
    agentName?: string;
    phase: "started" | "tool_call" | "tool_result";
    toolNames?: string[];
  }
  | { type: "subagent_result"; output: string }
  | { type: "done" }
  | { type: "error"; error: string; status?: number };

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

function toWebSocketBaseUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString().replace(/\/$/, "");
}

async function startHttpSseStream(options: {
  endpointId: string;
  apiKey: string;
  gatewayUrl: string;
  projectSlug?: string;
  environmentSlug?: string;
  message: string;
  sessionId?: string;
  signal: AbortSignal;
}): Promise<HttpStreamResult> {
  const {
    endpointId,
    apiKey,
    gatewayUrl,
    projectSlug,
    environmentSlug,
    message,
    sessionId,
    signal,
  } = options;

  const envPrefix = environmentSlug ? `/${environmentSlug}` : "";
  const projectPrefix = projectSlug ? `/${projectSlug}` : "";
  const endpointUrl = `${gatewayUrl.replace(/\/$/, "")}/v1${projectPrefix}/agents${envPrefix}/${endpointId}`;

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      message: message,
      sessionId: sessionId,
      stream: true,
    }),
    signal: signal,
  });

  if (!response.ok) {
    const responseBody = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(responseBody.error ?? `HTTP stream request failed with status ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("Response body is empty");
  }

  return {
    stream: response.body,
    sessionId: response.headers.get("X-Session-Id") ?? undefined,
  };
}

async function startWebSocketSseStream(options: {
  endpointId: string;
  apiKey: string;
  gatewayUrl: string;
  projectSlug?: string;
  environmentSlug?: string;
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
    apiKey,
    gatewayUrl,
    projectSlug,
    environmentSlug,
    message,
    sessionId,
    signal,
    onMeta,
    onContinuationDelta,
    onSubagentDelta,
    onSubagentActivity,
    onSubagentResult,
  } = options;

  const envPrefix = environmentSlug ? `/${environmentSlug}` : "";
  const projectPrefix = projectSlug ? `/${projectSlug}` : "";
  const wsBaseUrl = toWebSocketBaseUrl(gatewayUrl);
  const wsUrl =
    `${wsBaseUrl}/v1${projectPrefix}/agents${envPrefix}/${endpointId}/ws` +
    `?token=${encodeURIComponent(apiKey)}`;

  const socket = new WebSocket(wsUrl);
  const encoder = new TextEncoder();

  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let opened = false;
  let settled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
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
        socket.close(1011, error.message);
      }
    };

    const finishStream = () => {
      if (streamController) {
        streamController.close();
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
          message: message,
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
        if (event.code === 1000 || signal.aborted) {
          streamController.close();
        } else {
          streamController.error(
            new Error(event.reason || "WebSocket connection closed."),
          );
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
    typeof options.assistantMessage.id === "string" && options.assistantMessage.id.length > 0
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
    const index = options.previousMessages.findIndex((message) => message.id === options.messageId);
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
    ? event.toolNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  const formattedTools = toolNames.length > 0 ? ` (${toolNames.join(", ")})` : "";

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
    ? options.previousMessages.findIndex((message) => message.id === options.messageId)
    : -1;

  if (existingIndex >= 0) {
    const existingMessage = options.previousMessages[existingIndex];
    const existingPanel = existingMessage.parts.find((part) => isSubagentPanelPart(part));
    if (existingPanel) {
      const nextMessages = [...options.previousMessages];
      nextMessages[existingIndex] = {
        ...existingMessage,
        parts: [updatePanel(existingPanel) as unknown as UIMessage["parts"][number]],
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
 * Streams chat messages from the agent gateway and maintains conversation state.
 * @param endpointId Deployment endpoint ID
 * @param apiKey API key for bearer authentication
 * @param projectSlug Optional project slug for the URL path prefix
 * @param environmentSlug Optional environment slug for the URL path prefix
 */
export function useAgentChat({
  endpointId,
  apiKey,
  projectSlug,
  environmentSlug,
  webSocketEnabled,
}: {
  endpointId: string;
  apiKey: string;
  projectSlug?: string;
  environmentSlug?: string;
  webSocketEnabled: boolean;
}) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<Error | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<UIMessage[]>([]);
  const mainAssistantMessageIdRef = useRef<string | null>(null);
  const continuationMessageIdRef = useRef<string | null>(null);
  const subagentMessageIdsRef = useRef<Record<string, string>>({});
  const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL ?? "http://localhost:8080";

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
        let streamBody: ReadableStream<Uint8Array> | null = null;
        if (
          webSocketEnabled &&
          typeof window !== "undefined" &&
          "WebSocket" in window
        ) {
          try {
            const wsResult = await startWebSocketSseStream({
              endpointId: endpointId,
              apiKey: apiKey,
              gatewayUrl: gatewayUrl,
              projectSlug: projectSlug,
              environmentSlug: environmentSlug,
              message: trimmed,
              sessionId: sessionIdRef.current,
              signal: controller.signal,
              onMeta: ({ sessionId }) => {
                sessionIdRef.current = sessionId;
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
                  const currentMessageId = subagentMessageIdsRef.current[taskId] ?? null;
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
              onSubagentActivity: ({ taskId, sessionId, agentName, phase, toolNames }) => {
                setMessages((prev) => {
                  const currentMessageId = subagentMessageIdsRef.current[taskId] ?? null;
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
            apiKey: apiKey,
            gatewayUrl: gatewayUrl,
            projectSlug: projectSlug,
            environmentSlug: environmentSlug,
            message: trimmed,
            sessionId: sessionIdRef.current,
            signal: controller.signal,
          });
          streamBody = httpResult.stream;
          if (httpResult.sessionId) {
            sessionIdRef.current = httpResult.sessionId;
          }
        }

        // Parse SSE -> UIMessageChunk -> UIMessage
        const chunkStream = parseJsonEventStream({
          stream: streamBody,
          schema: uiMessageChunkSchema,
        }).pipeThrough(
          new TransformStream({
            transform(result, transformController) {
              if (result.success) {
                transformController.enqueue(result.value);
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
            ? `Cannot reach gateway at ${gatewayUrl}. Is the service running?`
            : err instanceof Error && err.message.includes("WebSocket")
              ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setError(new Error(message));
        setStatus("error");
      }
    },
    [endpointId, apiKey, projectSlug, environmentSlug, gatewayUrl, webSocketEnabled],
  );

  /** Reset chat history and server session for a new conversation. */
  const resetChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("ready");
    setError(null);
    sessionIdRef.current = undefined;
    mainAssistantMessageIdRef.current = null;
    continuationMessageIdRef.current = null;
    subagentMessageIdsRef.current = {};
  }, []);

  return {
    messages: messages,
    status: status,
    error: error,
    sendMessage: sendMessage,
    resetChat: resetChat,
  };
}

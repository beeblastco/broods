import { resolveRunEvents } from "../../../packages/broods/src/run-input.ts";
import type {
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
} from "../../../packages/broods/src/websocket-contracts.ts";
import {
  readConversationStream,
  type NatsConnection,
  type NatsStreamEvent,
} from "../../core/src/shared/nats.ts";
import {
  decoder,
  errorMessage,
  parseJson,
  type GatewayLimits,
} from "./utils.ts";

export type AgentTestGatewayData = {
  kind: "agent-test";
  corePath: string;
  token: string;
  coreBaseUrl: string;
};

type ExecuteMessage = WebSocketClientExecuteMessage;
type ActiveRun = {
  abort: AbortController;
  startTimeout: ReturnType<typeof setTimeout>;
};
type NatsStartResponse = {
  eventId: string;
  conversationKey: string;
  nats: {
    accountId: string;
    agentId: string;
    conversationKey: string;
  };
};

const activeRuns = new WeakMap<
  Bun.ServerWebSocket<AgentTestGatewayData>,
  ActiveRun
>();

export function handleAgentMessage(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  rawMessage: string | Buffer,
  limits: GatewayLimits,
  getNatsConnection: () => Promise<NatsConnection>,
): void {
  const message = parseGatewayMessage(rawMessage);
  if (!message) {
    sendAgentTest(socket, {
      type: "error",
      error: "Invalid WebSocket message",
    });
    socket.close(1003, "invalid message");
    return;
  }

  if (message.type === "cancel") {
    activeRuns.get(socket)?.abort.abort();
    activeRuns.delete(socket);
    return;
  }

  if (activeRuns.has(socket)) {
    sendAgentTest(socket, {
      type: "error",
      error: "A run is already active on this WebSocket",
    });
    return;
  }

  void runCoreStream(socket, message, limits, getNatsConnection);
}

export function buildCoreRunBody(
  message: ExecuteMessage,
): Record<string, unknown> {
  const eventId =
    typeof message.eventId === "string" && message.eventId.trim()
      ? message.eventId.trim()
      : `ws-${Date.now()}-${crypto.randomUUID()}`;
  const conversationKey =
    typeof message.sessionId === "string" && message.sessionId.trim()
      ? message.sessionId.trim()
      : eventId;

  return {
    agentId: message.agentId.trim(),
    eventId,
    conversationKey,
    connectionId: `ws-${crypto.randomUUID()}`,
    events: resolveRunEvents(message),
    ...(message.system !== undefined ? { system: message.system } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
  };
}

export function websocketMessageForNatsData(
  data: Record<string, unknown>,
): WebSocketServerMessage | null {
  return typeof data.type === "string"
    ? (data as WebSocketServerMessage)
    : null;
}

export function parseGatewayMessage(
  rawMessage: string | Buffer,
): WebSocketClientMessage | null {
  const text =
    typeof rawMessage === "string" ? rawMessage : decoder.decode(rawMessage);
  const parsed = parseJson(text);

  if (!parsed || typeof parsed !== "object") return null;
  if ((parsed as { type?: unknown }).type === "cancel")
    return { type: "cancel" };

  return isExecuteMessage(parsed) ? parsed : null;
}

export function stopActiveRun(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
): void {
  const activeRun = activeRuns.get(socket);
  if (!activeRun) return;

  clearTimeout(activeRun.startTimeout);
  activeRun.abort.abort();
  activeRuns.delete(socket);
}

async function runCoreStream(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  message: ExecuteMessage,
  limits: GatewayLimits,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const abort = new AbortController();
  let startTimedOut = false;
  const startTimeout = setTimeout(() => {
    startTimedOut = true;
    abort.abort();
  }, limits.runStartTimeoutMs);
  activeRuns.set(socket, { abort, startTimeout });

  let body: Record<string, unknown>;
  try {
    body = buildCoreRunBody(message);
  } catch (error) {
    sendAgentTest(socket, { type: "error", error: errorMessage(error) });
    stopActiveRun(socket);
    return;
  }

  sendAgentTest(socket, {
    type: "meta",
    sessionId: String(body.conversationKey),
    taskId: String(body.eventId),
  });

  try {
    const response = await fetch(
      `${socket.data.coreBaseUrl}${socket.data.corePath}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${socket.data.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      },
    );

    if (!response.ok) {
      clearTimeout(startTimeout);
      sendAgentTest(socket, {
        type: "error",
        status: response.status,
        error: await response.text(),
      });
      return;
    }

    const started = (await response.json()) as NatsStartResponse;
    clearTimeout(startTimeout);
    await streamNatsResponses(socket, started, abort.signal, getNatsConnection);
  } catch (error) {
    if (!abort.signal.aborted) {
      sendAgentTest(socket, { type: "error", error: errorMessage(error) });
    } else if (startTimedOut) {
      sendAgentTest(socket, { type: "error", error: "Run start timed out" });
    }
  } finally {
    stopActiveRun(socket);
  }
}

async function streamNatsResponses(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  started: NatsStartResponse,
  signal: AbortSignal,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const connection = await getNatsConnection();
  const messages = await readConversationStream({
    connection,
    accountId: started.nats.accountId,
    agentId: started.nats.agentId,
    conversationKey: started.nats.conversationKey,
  });

  try {
    for await (const message of messages) {
      if (signal.aborted) break;

      const event = decodeNatsStreamEvent(message.data);
      if (!event) {
        ackNatsMessage(message);
        continue;
      }

      const outbound = websocketMessageForNatsData(event.data);
      if (outbound) sendAgentTest(socket, outbound);
      ackNatsMessage(message);

      if (event.data.type === "done") break;
    }
  } finally {
    await messages.close().catch(() => {});
  }
}

function decodeNatsStreamEvent(data: Uint8Array): NatsStreamEvent | null {
  const parsed = parseJson(decoder.decode(data));

  return parsed &&
    typeof parsed === "object" &&
    (parsed as { type?: unknown }).type === "stream"
    ? (parsed as NatsStreamEvent)
    : null;
}

function ackNatsMessage(message: { ack?: () => void }): void {
  try {
    message.ack?.();
  } catch {
    return;
  }
}

function sendAgentTest(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  payload: WebSocketServerMessage,
): void {
  socket.send(JSON.stringify(payload));
}

function isExecuteMessage(
  value: object,
): value is WebSocketClientExecuteMessage {
  const record = value as { type?: unknown; agentId?: unknown };

  return (
    record.type === "execute" &&
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0
  );
}

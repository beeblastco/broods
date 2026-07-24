import { createHash } from "node:crypto";
import { resolveRunEvents } from "../../../packages/broods/src/run-input.ts";
import type {
  IngressStatus,
  WebSocketClientAttachMessage,
  WebSocketClientControlMessage,
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
} from "../../../packages/broods/src/websocket-contracts.ts";
import {
  conversationLastSequence,
  conversationReplaySnapshot,
  readConversationStream,
  retainedMessageSubject,
  streamResponseSubject,
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
  accountId: string;
};

type ExecuteMessage = WebSocketClientExecuteMessage;
type ActiveRun = {
  abort: AbortController;
  startTimeout: ReturnType<typeof setTimeout>;
  agentId: string;
  publicConversationKey: string;
  publicEventId: string;
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
type IngressHttpResponse = {
  eventId?: string;
  conversationKey?: string;
  status?: IngressStatus | "not_found";
  requestedMode?: "reject" | "followup" | "collect" | "steer";
  appliedMode?: "reject" | "followup" | "collect" | "steer";
  appliedToEventId?: string;
  statusUrl?: string;
  error?: string;
};

const activeRuns = new WeakMap<
  Bun.ServerWebSocket<AgentTestGatewayData>,
  ActiveRun
>();
const TERMINAL_STATUSES = new Set<IngressStatus>([
  "completed",
  "failed",
  "expired",
]);
const CURSOR_PREFIX = "ws-responses";

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
    stopActiveRun(socket);
    return;
  }

  if (message.type === "control") {
    const active = activeRuns.get(socket);
    if (!active) {
      sendAgentTest(socket, {
        type: "error",
        error: "No active run to control",
      });
      return;
    }
    void submitControl(socket, active, message);
    return;
  }

  if (activeRuns.has(socket)) {
    sendAgentTest(socket, {
      type: "error",
      error: "A run is already active on this WebSocket",
    });
    return;
  }

  if (message.type === "attach") {
    void attachCoreStream(socket, message, limits, getNatsConnection);
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
    ...(message.mode !== undefined ? { mode: message.mode } : {}),
    ...(message.idempotencyKey !== undefined
      ? { idempotencyKey: message.idempotencyKey }
      : {}),
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
  const type = (parsed as { type?: unknown }).type;
  if (type === "cancel") return { type: "cancel" };
  if (type === "control") return isControlMessage(parsed) ? parsed : null;
  if (type === "attach") return isAttachMessage(parsed) ? parsed : null;
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
  let body: Record<string, unknown>;
  try {
    body = buildCoreRunBody(message);
  } catch (error) {
    sendAgentTest(socket, { type: "error", error: errorMessage(error) });
    return;
  }
  const active: ActiveRun = {
    abort,
    startTimeout,
    agentId: String(body.agentId),
    publicConversationKey: String(body.conversationKey),
    publicEventId: String(body.eventId),
  };
  activeRuns.set(socket, active);
  sendAgentTest(socket, {
    type: "meta",
    sessionId: active.publicConversationKey,
    taskId: active.publicEventId,
  });

  try {
    const response = await fetch(
      `${socket.data.coreBaseUrl}${socket.data.corePath}`,
      {
        method: "POST",
        headers: coreHeaders(socket),
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
    if (!response.headers.get("content-type")?.includes("application/json")) {
      sendAgentTest(socket, {
        type: "error",
        error: "Core WebSocket start did not return JSON",
      });
      return;
    }
    const payload = (await response.json()) as NatsStartResponse &
      IngressHttpResponse;
    clearTimeout(startTimeout);
    if (!payload.nats) {
      if (!payload.eventId || !isIngressStatus(payload.status)) {
        sendAgentTest(socket, {
          type: "error",
          error: "Core did not return a WebSocket stream or ingress status",
        });
        return;
      }
      sendAgentTest(socket, {
        type: "ack",
        requestId: payload.eventId,
        eventId: payload.eventId,
        status: payload.status,
        ...(payload.statusUrl ? { statusUrl: payload.statusUrl } : {}),
      });
      // A durable 202 is not a terminal answer: follow the queued event to a
      // terminal frame so the client's stream never hangs on a bare ack.
      await followQueuedExecution(
        socket,
        active,
        {
          eventId: payload.eventId,
          status: payload.status,
          ...(payload.statusUrl ? { statusUrl: payload.statusUrl } : {}),
        },
        getNatsConnection,
      );
      return;
    }
    await streamNatsResponses(
      socket,
      payload,
      abort.signal,
      getNatsConnection,
      false,
    );
  } catch (error) {
    if (!abort.signal.aborted)
      sendAgentTest(socket, { type: "error", error: errorMessage(error) });
    else if (startTimedOut)
      sendAgentTest(socket, { type: "error", error: "Run start timed out" });
  } finally {
    stopActiveRun(socket);
  }
}

/**
 * Follows a queued (non-owner) execute to completion: live-streams its output
 * once the durable envelope runs, polls its ingress status, and always closes
 * the client stream with a terminal done/error frame.
 */
async function followQueuedExecution(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  accepted: { eventId: string; status: IngressStatus; statusUrl?: string },
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const signal = active.abort.signal;
  const finishTerminal = (status: IngressStatus, error?: string) => {
    if (TERMINAL_STATUSES.has(status) && status !== "completed") {
      sendAgentTest(socket, {
        type: "error",
        error: error ?? `Queued run ended with status ${status}`,
      });
      return;
    }
    sendAgentTest(socket, { type: "done" });
  };
  if (TERMINAL_STATUSES.has(accepted.status)) {
    finishTerminal(accepted.status);
    return;
  }

  const scope = {
    accountId: socket.data.accountId,
    agentId: active.agentId,
    conversationKey: active.publicConversationKey,
  };
  const connection = await getNatsConnection();
  const snapshot = await conversationReplaySnapshot({ connection, ...scope });
  const eventKey = cursorEventKey(accepted.eventId);
  let sawDone = false;
  void (async () => {
    const messages = await readConversationStream({
      connection,
      ...scope,
      startSequence: snapshot.lastSequence + 1,
    });
    const closeOnAbort = () => void messages.close().catch(() => {});
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      for await (const message of messages) {
        if (signal.aborted) break;
        const event = decodeNatsStreamEvent(message.data);
        if (!event || event.headers.eventId !== accepted.eventId) {
          ackNatsMessage(message);
          continue;
        }
        const outbound = websocketMessageForNatsData(event.data);
        if (outbound) {
          sendAgentTest(socket, {
            type: "output",
            eventId: accepted.eventId,
            cursor: formatCursor(snapshot.generation, message.seq, eventKey),
            replay: false,
            data: outbound,
          });
        }
        ackNatsMessage(message);
        if (event.data.type === "done") {
          sawDone = true;
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      await messages.close().catch(() => {});
    }
  })().catch(() => {});

  let previous = "";
  let terminal: IngressHttpResponse | null = null;
  while (!signal.aborted && !sawDone) {
    await Bun.sleep(500);
    if (sawDone || signal.aborted) break;
    const status = await fetchStatus(
      socket,
      active.agentId,
      accepted.eventId,
      signal,
      accepted.statusUrl,
    ).catch(() => null);
    if (!status?.status) continue;
    const fingerprint = JSON.stringify([
      status.status,
      status.appliedMode,
      status.appliedToEventId,
      status.error,
    ]);
    if (fingerprint !== previous) {
      previous = fingerprint;
      sendAgentTest(socket, {
        type: "status",
        requestId: accepted.eventId,
        eventId: accepted.eventId,
        status: isIngressStatus(status.status) ? status.status : "expired",
        ...(status.appliedMode ? { appliedMode: status.appliedMode } : {}),
        ...(status.appliedToEventId
          ? { appliedToEventId: status.appliedToEventId }
          : {}),
        ...(accepted.statusUrl ? { statusUrl: accepted.statusUrl } : {}),
        ...(status.error ? { error: status.error } : {}),
      });
    }
    if (
      status.status === "not_found" ||
      (isIngressStatus(status.status) && TERMINAL_STATUSES.has(status.status))
    ) {
      terminal = status;
      break;
    }
  }
  if (signal.aborted) return;
  if (!sawDone && terminal) {
    // Give in-flight stream frames a short grace window before the terminal
    // frame: settle can land in Convex just ahead of the NATS done marker.
    for (let i = 0; i < 4 && !sawDone && !signal.aborted; i += 1) {
      await Bun.sleep(500);
    }
  }
  if (sawDone) return;
  if (terminal) {
    const status = isIngressStatus(terminal.status)
      ? terminal.status
      : ("expired" as const);
    finishTerminal(status, terminal.error);
  }
}

async function submitControl(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  message: WebSocketClientControlMessage,
): Promise<void> {
  try {
    const response = await fetch(
      `${socket.data.coreBaseUrl}${socket.data.corePath}`,
      {
        method: "POST",
        headers: coreHeaders(socket),
        body: JSON.stringify({
          agentId: active.agentId,
          eventId: message.eventId,
          conversationKey: active.publicConversationKey,
          connectionId: `ws-${crypto.randomUUID()}`,
          events: resolveRunEvents(message),
          mode: message.mode,
          idempotencyKey: message.idempotencyKey ?? message.eventId,
        }),
        signal: active.abort.signal,
      },
    );
    const payload = await responseJson(response);
    if (
      response.status !== 202 ||
      !payload.eventId ||
      !isIngressStatus(payload.status)
    ) {
      sendAgentTest(socket, {
        type: "status",
        requestId: message.requestId,
        eventId: message.eventId,
        status: payload.status ?? "not_found",
        error:
          payload.error ??
          `Control input was rejected with HTTP ${response.status}`,
      });
      return;
    }
    sendAgentTest(socket, {
      type: "ack",
      requestId: message.requestId,
      eventId: payload.eventId,
      status: payload.status,
      ...(payload.statusUrl ? { statusUrl: payload.statusUrl } : {}),
    });
    void pollControlStatus(
      socket,
      active,
      message.requestId,
      payload.eventId,
      payload.statusUrl,
    );
  } catch (error) {
    if (!active.abort.signal.aborted) {
      sendAgentTest(socket, {
        type: "status",
        requestId: message.requestId,
        eventId: message.eventId,
        status: "not_found",
        error: errorMessage(error),
      });
    }
  }
}

async function pollControlStatus(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  requestId: string,
  eventId: string,
  statusUrl?: string,
): Promise<void> {
  let previous = "";
  while (!active.abort.signal.aborted) {
    await Bun.sleep(500);
    const payload = await fetchStatus(
      socket,
      active.agentId,
      eventId,
      active.abort.signal,
      statusUrl,
    ).catch(() => null);
    if (!payload?.status) continue;
    const fingerprint = JSON.stringify([
      payload.status,
      payload.appliedMode,
      payload.appliedToEventId,
      payload.error,
    ]);
    if (fingerprint !== previous) {
      previous = fingerprint;
      sendAgentTest(socket, {
        type: "status",
        requestId,
        eventId,
        status: payload.status,
        ...(payload.requestedMode
          ? { requestedMode: payload.requestedMode }
          : {}),
        ...(payload.appliedMode ? { appliedMode: payload.appliedMode } : {}),
        ...(payload.appliedToEventId
          ? { appliedToEventId: payload.appliedToEventId }
          : {}),
        ...(statusUrl ? { statusUrl } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      });
    }
    if (
      payload.status === "not_found" ||
      (isIngressStatus(payload.status) && TERMINAL_STATUSES.has(payload.status))
    )
      return;
  }
}

async function attachCoreStream(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  message: WebSocketClientAttachMessage,
  limits: GatewayLimits,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const abort = new AbortController();
  const startTimeout = setTimeout(
    () => abort.abort(),
    limits.runStartTimeoutMs,
  );
  activeRuns.set(socket, {
    abort,
    startTimeout,
    agentId: message.agentId,
    publicConversationKey: message.conversationKey,
    publicEventId: message.eventId,
  });
  const statusUrl = `/status/${encodeURIComponent(message.eventId)}?agentId=${encodeURIComponent(message.agentId)}`;
  try {
    const status = await fetchStatus(
      socket,
      message.agentId,
      message.eventId,
      abort.signal,
    );
    if (!status.status || status.status === "not_found") {
      sendAgentTest(socket, {
        type: "replay_unavailable",
        requestId: message.requestId,
        eventId: message.eventId,
        status: "not_found",
        statusUrl,
      });
      return;
    }
    if (status.conversationKey !== message.conversationKey) {
      sendAgentTest(socket, {
        type: "replay_unavailable",
        requestId: message.requestId,
        eventId: message.eventId,
        status: status.status,
        statusUrl,
      });
      return;
    }
    const connection = await getNatsConnection();
    const scope = {
      accountId: socket.data.accountId,
      agentId: message.agentId,
      conversationKey: message.conversationKey,
    };
    const snapshot = await conversationReplaySnapshot({
      connection,
      ...scope,
    });
    const cursor = message.afterCursor
      ? parseCursor(message.afterCursor)
      : null;
    const eventKey = cursorEventKey(message.eventId);
    const unavailable = () =>
      sendAgentTest(socket, {
        type: "replay_unavailable",
        requestId: message.requestId,
        eventId: message.eventId,
        status: status.status,
        statusUrl,
      });
    if (
      (message.afterCursor && !cursor) ||
      (cursor && cursor.generation !== snapshot.generation) ||
      (cursor?.eventKey !== undefined && cursor.eventKey !== eventKey) ||
      (snapshot.bufferedCount === 0 && !TERMINAL_STATUSES.has(status.status))
    ) {
      unavailable();
      return;
    }
    if (cursor) {
      // A cursor is only resumable when its own message is still retained for
      // this conversation subject: head eviction guarantees everything after a
      // retained message is intact, and a sequence past the subject's last
      // message is a fabricated future cursor, not a resume point.
      const lastSequence = await conversationLastSequence({
        connection,
        ...scope,
      });
      if (lastSequence === null || cursor.sequence > lastSequence) {
        unavailable();
        return;
      }
      const subjectAtCursor = await retainedMessageSubject(
        connection,
        cursor.sequence,
      );
      if (
        subjectAtCursor !==
        streamResponseSubject(
          scope.accountId,
          scope.agentId,
          scope.conversationKey,
        )
      ) {
        unavailable();
        return;
      }
    }
    const replayFrom = cursor ? cursor.sequence + 1 : snapshot.firstSequence;
    sendAgentTest(socket, {
      type: "attached",
      requestId: message.requestId,
      eventId: message.eventId,
      status: status.status,
      ...(snapshot.bufferedCount > 0
        ? {
            replayFromCursor: formatCursor(
              snapshot.generation,
              replayFrom,
              eventKey,
            ),
            replayThroughCursor: formatCursor(
              snapshot.generation,
              snapshot.lastSequence,
              eventKey,
            ),
          }
        : {}),
      statusUrl,
    });
    clearTimeout(startTimeout);
    if (snapshot.bufferedCount === 0) {
      sendAgentTest(socket, {
        type: "status",
        requestId: message.requestId,
        eventId: message.eventId,
        status: status.status,
        statusUrl,
      });
      return;
    }
    const messages = await readConversationStream({
      connection,
      accountId: socket.data.accountId,
      agentId: message.agentId,
      conversationKey: message.conversationKey,
      ...(replayFrom > 0 ? { startSequence: replayFrom } : {}),
    });
    try {
      for await (const natsMessage of messages) {
        if (abort.signal.aborted) break;
        const event = decodeNatsStreamEvent(natsMessage.data);
        if (!event || event.headers.eventId !== message.eventId) {
          ackNatsMessage(natsMessage);
          continue;
        }
        const outbound = websocketMessageForNatsData(event.data);
        if (outbound) {
          sendAgentTest(socket, {
            type: "output",
            eventId: message.eventId,
            cursor: formatCursor(
              snapshot.generation,
              natsMessage.seq,
              eventKey,
            ),
            replay: natsMessage.seq <= snapshot.lastSequence,
            data: outbound,
          });
        }
        ackNatsMessage(natsMessage);
        if (event.data.type === "done") break;
      }
    } finally {
      await messages.close().catch(() => {});
    }
  } catch (error) {
    if (!abort.signal.aborted)
      sendAgentTest(socket, { type: "error", error: errorMessage(error) });
  } finally {
    stopActiveRun(socket);
  }
}

async function streamNatsResponses(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  started: NatsStartResponse,
  signal: AbortSignal,
  getNatsConnection: () => Promise<NatsConnection>,
  replay: boolean,
): Promise<void> {
  const connection = await getNatsConnection();
  const snapshot = await conversationReplaySnapshot({
    connection,
    ...started.nats,
  });
  const eventKey = cursorEventKey(started.eventId);
  const messages = await readConversationStream({
    connection,
    ...started.nats,
  });
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      const event = decodeNatsStreamEvent(message.data);
      if (!event || event.headers.eventId !== started.eventId) {
        ackNatsMessage(message);
        continue;
      }
      const outbound = websocketMessageForNatsData(event.data);
      if (outbound) {
        sendAgentTest(socket, {
          type: "output",
          eventId: started.eventId,
          cursor: formatCursor(snapshot.generation, message.seq, eventKey),
          replay: replay || message.seq <= snapshot.lastSequence,
          data: outbound,
        });
      }
      ackNatsMessage(message);
      if (event.data.type === "done") break;
    }
  } finally {
    await messages.close().catch(() => {});
  }
}

async function fetchStatus(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  agentId: string,
  eventId: string,
  signal: AbortSignal,
  statusUrl?: string,
): Promise<IngressHttpResponse> {
  const target =
    statusUrl && /^https?:\/\//.test(statusUrl)
      ? statusUrl
      : `${socket.data.coreBaseUrl}/status/${encodeURIComponent(eventId)}?agentId=${encodeURIComponent(agentId)}`;
  return responseJson(
    await fetch(target, { headers: coreHeaders(socket), signal }),
  );
}

function coreHeaders(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${socket.data.token}`,
    "Content-Type": "application/json",
  };
}

async function responseJson(response: Response): Promise<IngressHttpResponse> {
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === "object"
    ? (payload as IngressHttpResponse)
    : {};
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

/** Binds a cursor to its originating event so it cannot resume another one. */
function cursorEventKey(eventId: string): string {
  return createHash("sha256").update(eventId).digest("base64url").slice(0, 16);
}

function formatCursor(
  generation: string,
  sequence: number,
  eventKey: string,
): string {
  return `${CURSOR_PREFIX}:${generation}:${sequence}:${eventKey}`;
}

function parseCursor(value: string): {
  generation: string;
  sequence: number;
  eventKey?: string;
} | null {
  const match = /^ws-responses:([^:]+):(\d+)(?::([^:]+))?$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;

  return {
    generation: match[1],
    sequence,
    ...(match[3] ? { eventKey: match[3] } : {}),
  };
}

function isIngressStatus(value: unknown): value is IngressStatus {
  return (
    value === "accepted" ||
    value === "queued" ||
    value === "applied" ||
    value === "processing" ||
    value === "awaiting_approval" ||
    value === "completed" ||
    value === "failed" ||
    value === "expired"
  );
}

function isIngressMode(
  value: unknown,
): value is "reject" | "followup" | "collect" | "steer" {
  return (
    value === "reject" ||
    value === "followup" ||
    value === "collect" ||
    value === "steer"
  );
}

function hasEventInput(value: object): boolean {
  const record = value as { input?: unknown; events?: unknown };
  return (
    typeof record.input === "string" ||
    (Array.isArray(record.events) && record.events.length > 0)
  );
}

function isExecuteMessage(
  value: object,
): value is WebSocketClientExecuteMessage {
  const record = value as { type?: unknown; agentId?: unknown; mode?: unknown };
  return (
    record.type === "execute" &&
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0 &&
    (record.mode === undefined || isIngressMode(record.mode)) &&
    hasEventInput(value)
  );
}

function isControlMessage(
  value: object,
): value is WebSocketClientControlMessage {
  const record = value as {
    type?: unknown;
    requestId?: unknown;
    eventId?: unknown;
    mode?: unknown;
  };
  return (
    record.type === "control" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.eventId === "string" &&
    record.eventId.length > 0 &&
    (record.mode === undefined || isIngressMode(record.mode)) &&
    hasEventInput(value)
  );
}

function isAttachMessage(value: object): value is WebSocketClientAttachMessage {
  const record = value as {
    type?: unknown;
    requestId?: unknown;
    agentId?: unknown;
    conversationKey?: unknown;
    eventId?: unknown;
    afterCursor?: unknown;
  };
  return (
    record.type === "attach" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0 &&
    typeof record.conversationKey === "string" &&
    record.conversationKey.length > 0 &&
    typeof record.eventId === "string" &&
    record.eventId.length > 0 &&
    (record.afterCursor === undefined || typeof record.afterCursor === "string")
  );
}

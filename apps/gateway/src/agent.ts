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
  errorText,
  type GatewayLimits,
  parseJson,
} from "./utils.ts";
import type { ApiError } from "../../../packages/convex/model/apiError.ts";
import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";

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
  // One control input at a time: each one is a core POST plus a status poll.
  /** Control inputs submitted and not yet applied or terminal. */
  controls: number;
};
type IngressHttpResponse = {
  eventId?: string;
  runId?: string;
  conversationKey?: string;
  status?: IngressStatus | "not_found";
  requestedMode?: "reject" | "followup" | "collect" | "steer";
  appliedMode?: "reject" | "followup" | "collect" | "steer";
  appliedToEventId?: string;
  statusUrl?: string;
  error?: string | ApiError;
};
// Derived from the NATS helpers rather than restated, so neither can drift.
type ConversationScope = Omit<
  Parameters<typeof conversationReplaySnapshot>[0],
  "connection"
>;
type ReplaySnapshot = Awaited<ReturnType<typeof conversationReplaySnapshot>>;
// A socket turn that starts at once carries the NATS scope core streams it on;
// a queued one carries none and streams on the requested conversation.
type CoreStartResponse = IngressHttpResponse & { nats?: ConversationScope };
// Everything the execute and attach paths follow a run with. Only these fields
// differ between them; the lifecycle itself is shared.
type FollowedExecution = {
  connection: NatsConnection;
  scope: ConversationScope;
  eventId: string;
  eventKey: string;
  snapshot: ReplaySnapshot;
  // Undefined replays from the subject's earliest retained frame, which is the
  // only way to name that boundary on a stream shared by every conversation.
  startSequence: number | undefined;
  initialConsumedSequence: number;
  isReplay: (sequence: number) => boolean;
  statusRequestId: string;
  runId?: string;
  statusUrl?: string;
  // Seeds the terminal state and the status fingerprint, so an attach that is
  // already terminal neither re-sends its seed frame nor polls again.
  seedStatus: IngressHttpResponse | null;
  terminalLabel: string;
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
// An agent id lands raw in a NATS subject (`v1.<account>.<agent>.ws...`), so it
// must be one token: a `.` would shift the subject and `*` or `>` would widen
// the subscription across agents.
const SUBJECT_TOKEN = /^[^\s.*>]+$/;
// Each control in flight polls its status until applied or terminal, and a
// queued `collect` or `followup` stays in flight until the run ends, so this
// bounds poll loops per socket without serializing batching.
const MAX_CONTROLS_IN_FLIGHT = 8;
const STATUS_POLL_INTERVAL_MS = 500;
const STATUS_QUIET_MS = 3_000;
const NATS_TAIL_GRACE_POLLS = 4;
const NATS_TAIL_MAX_WAIT_MS = 10_000;

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
    if (active.controls >= MAX_CONTROLS_IN_FLIGHT) {
      sendAgentTest(socket, {
        type: "status",
        requestId: message.requestId,
        eventId: message.eventId,
        status: "failed",
        error: `Too many control inputs in flight on this WebSocket (max ${MAX_CONTROLS_IN_FLIGHT})`,
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
    eventId: eventId,
    conversationKey: conversationKey,
    connectionId: `ws-${crypto.randomUUID()}`,
    ...(message.answers
      ? { answers: message.answers }
      : { events: resolveRunEvents(message) }),
    ...(message.mode !== undefined ? { mode: message.mode } : {}),
    ...(message.idempotencyKey !== undefined
      ? { idempotencyKey: message.idempotencyKey }
      : {}),
    ...(message.system !== undefined ? { system: message.system } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
  };
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

/**
 * Stops the socket's active run. With `run`, only while that run is still the
 * active one: a run's own cleanup must never abort a newer run on the socket.
 */
export function stopActiveRun(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  run?: ActiveRun,
): void {
  const activeRun = activeRuns.get(socket);
  if (!activeRun || (run && activeRun !== run)) return;
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
  let body: Record<string, unknown>;
  try {
    body = buildCoreRunBody(message);
  } catch (error) {
    sendAgentTest(socket, { type: "error", error: errorMessage(error) });

    return;
  }
  const abort = new AbortController();
  let startTimedOut = false;
  const active: ActiveRun = {
    abort: abort,
    startTimeout: setTimeout((): void => {
      startTimedOut = true;
      abort.abort();
    }, limits.runStartTimeoutMs),
    agentId: String(body.agentId),
    publicConversationKey: String(body.conversationKey),
    publicEventId: String(body.eventId),
    controls: 0,
  };
  activeRuns.set(socket, active);
  sendAgentTest(socket, {
    type: "meta",
    sessionId: active.publicConversationKey,
    taskId: active.publicEventId,
  });

  try {
    const scope: ConversationScope = {
      accountId: socket.data.accountId,
      agentId: active.agentId,
      conversationKey: active.publicConversationKey,
    };
    const connection = await getNatsConnection();
    // Taken before the POST, so every frame this run publishes lands after it
    // and the consumer never replays the subject's earlier turns.
    const snapshot = await conversationReplaySnapshot({
      connection: connection,
      ...scope,
    });
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
      clearTimeout(active.startTimeout);
      sendAgentTest(socket, {
        type: "error",
        status: response.status,
        error: await responseErrorText(response),
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
    const payload = (await response.json()) as CoreStartResponse;
    clearTimeout(active.startTimeout);
    if (!payload.eventId || !isIngressStatus(payload.status)) {
      sendAgentTest(socket, {
        type: "error",
        error: "Core did not return a WebSocket stream or ingress status",
      });

      return;
    }
    // A durable 202 is not a terminal answer: follow the queued event to a
    // terminal frame so the client's stream never hangs on a bare ack.
    if (!payload.nats) {
      sendAgentTest(socket, {
        type: "ack",
        requestId: payload.eventId,
        eventId: payload.eventId,
        status: payload.status,
        ...(payload.statusUrl ? { statusUrl: payload.statusUrl } : {}),
      });
      if (TERMINAL_STATUSES.has(payload.status)) {
        sendTerminalFrame(socket, "Queued", payload.status);

        return;
      }
    }
    await followExecution(socket, abort.signal, {
      connection: connection,
      scope: payload.nats ?? scope,
      eventId: payload.eventId,
      eventKey: cursorEventKey(payload.eventId),
      snapshot: snapshot,
      startSequence: snapshot.lastSequence + 1,
      initialConsumedSequence: snapshot.lastSequence,
      // The snapshot predates the run, so nothing it emits is a replay.
      isReplay: (): boolean => false,
      statusRequestId: payload.eventId,
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(payload.statusUrl ? { statusUrl: payload.statusUrl } : {}),
      // A started turn is seeded so its "processing" is not re-sent as news.
      seedStatus: payload.nats ? payload : null,
      terminalLabel: payload.nats ? "Direct" : "Queued",
    });
  } catch (error) {
    if (!abort.signal.aborted)
      sendAgentTest(socket, { type: "error", error: errorMessage(error) });
    else if (startTimedOut)
      sendAgentTest(socket, { type: "error", error: "Run start timed out" });
  } finally {
    stopActiveRun(socket, active);
  }
}

/**
 * Follows one run to its terminal frame: streams its NATS responses, polls its
 * status, drains the tail, then emits exactly one done or error frame. Shared by
 * the execute and attach paths, which differ only in `execution`.
 */
async function followExecution(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  signal: AbortSignal,
  execution: FollowedExecution,
): Promise<void> {
  const messages = await readConversationStream({
    connection: execution.connection,
    ...execution.scope,
    startSequence: execution.startSequence,
  }).catch(() => null);
  let lastConsumedSequence = execution.initialConsumedSequence;
  let sawDone = false;
  let sawError = false;
  let lastFrameAt = 0;
  let streamSettled = messages === null;
  const closeOnAbort = () => void messages?.close().catch(() => {});
  if (messages) {
    signal.addEventListener("abort", closeOnAbort, { once: true });
  }
  const stream = messages
    ? (async () => {
        try {
          for await (const natsMessage of messages) {
            if (signal.aborted) break;
            lastConsumedSequence = Math.max(
              lastConsumedSequence,
              natsMessage.seq,
            );
            const event = decodeNatsStreamEvent(natsMessage.data);
            if (!event || event.headers.eventId !== execution.eventId) {
              ackNatsMessage(natsMessage);
              continue;
            }
            lastFrameAt = Date.now();
            if (typeof event.data.type === "string") {
              sendAgentTest(socket, {
                type: "output",
                eventId: execution.eventId,
                cursor: formatCursor(
                  execution.snapshot.generation,
                  natsMessage.seq,
                  execution.eventKey,
                ),
                replay: execution.isReplay(natsMessage.seq),
                data: event.data as WebSocketServerMessage,
              });
            }
            ackNatsMessage(natsMessage);
            if (event.data.type === "done") {
              sawDone = true;
              break;
            }
            if (event.data.type === "error") {
              sawError = true;
            }
          }
        } finally {
          streamSettled = true;
        }
      })().catch(() => {})
    : Promise.resolve();

  const seed = execution.seedStatus;
  let terminal =
    seed && isIngressStatus(seed.status) && TERMINAL_STATUSES.has(seed.status)
      ? seed
      : null;
  let previous = seed ? statusFingerprint(seed) : "";
  try {
    while (!signal.aborted && !sawDone && !terminal) {
      await Bun.sleep(STATUS_POLL_INTERVAL_MS);
      if (signal.aborted || sawDone) break;
      // Frames arriving prove the run is alive, so status is only asked for
      // once the stream has gone quiet.
      if (Date.now() - lastFrameAt < STATUS_QUIET_MS) continue;
      const status = await fetchStatus(
        socket,
        execution.runId,
        signal,
        execution.statusUrl,
      ).catch(() => null);
      if (!status?.status) continue;
      const fingerprint = statusFingerprint(status);
      if (fingerprint !== previous) {
        previous = fingerprint;
        sendAgentTest(socket, {
          type: "status",
          requestId: execution.statusRequestId,
          eventId: execution.eventId,
          status: isIngressStatus(status.status) ? status.status : "expired",
          ...(status.appliedMode ? { appliedMode: status.appliedMode } : {}),
          ...(status.appliedToEventId
            ? { appliedToEventId: status.appliedToEventId }
            : {}),
          ...(execution.statusUrl ? { statusUrl: execution.statusUrl } : {}),
          ...(errorText(status.error)
            ? { error: errorText(status.error) }
            : {}),
        });
      }
      if (
        status.status === "not_found" ||
        (isIngressStatus(status.status) && TERMINAL_STATUSES.has(status.status))
      ) {
        terminal = status;
      }
    }
    if (terminal && !sawDone && messages) {
      await waitForNatsTail({
        connection: execution.connection,
        ...execution.scope,
        initialBoundary: execution.snapshot.lastSequence,
        lastConsumedSequence: () => lastConsumedSequence,
        sawDone: () => sawDone,
        signal: signal,
        streamSettled: () => streamSettled,
      });
    }
  } finally {
    if (messages) {
      signal.removeEventListener("abort", closeOnAbort);
      await messages.close().catch(() => {});
    }
    await stream;
  }
  if (signal.aborted || sawDone || sawError || !terminal) return;

  sendTerminalFrame(
    socket,
    execution.terminalLabel,
    isIngressStatus(terminal.status) ? terminal.status : "expired",
    errorText(terminal.error),
  );
}

/** Submits one control input and follows its status until it settles. */
async function submitControl(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  message: WebSocketClientControlMessage,
): Promise<void> {
  active.controls += 1;
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
          errorText(payload.error) ??
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
    await pollControlStatus(
      socket,
      active,
      message.requestId,
      payload.eventId,
      payload.runId,
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
  } finally {
    active.controls -= 1;
  }
}

async function pollControlStatus(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  requestId: string,
  eventId: string,
  runId?: string,
  statusUrl?: string,
): Promise<void> {
  let previous = "";
  while (!active.abort.signal.aborted) {
    await Bun.sleep(STATUS_POLL_INTERVAL_MS);
    const payload = await fetchStatus(
      socket,
      runId,
      active.abort.signal,
      statusUrl,
    ).catch(() => null);
    if (!payload?.status) continue;
    const statusError = errorText(payload.error);
    const fingerprint = statusFingerprint(payload);
    if (fingerprint !== previous) {
      previous = fingerprint;
      sendAgentTest(socket, {
        type: "status",
        requestId: requestId,
        eventId: eventId,
        status: payload.status,
        ...(payload.requestedMode
          ? { requestedMode: payload.requestedMode }
          : {}),
        ...(payload.appliedMode ? { appliedMode: payload.appliedMode } : {}),
        ...(payload.appliedToEventId
          ? { appliedToEventId: payload.appliedToEventId }
          : {}),
        ...(statusUrl ? { statusUrl: statusUrl } : {}),
        ...(statusError ? { error: statusError } : {}),
      });
    }
    // Applied means folded into its target run, whose own stream reports the
    // outcome, so the control settles there and frees the socket's slot.
    if (
      payload.status === "not_found" ||
      payload.status === "applied" ||
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
  const active: ActiveRun = {
    abort: abort,
    startTimeout: startTimeout,
    agentId: message.agentId,
    publicConversationKey: message.conversationKey,
    publicEventId: message.eventId,
    controls: 0,
  };
  activeRuns.set(socket, active);
  const statusUrl = `/v1/runs/${encodeURIComponent(message.runId)}`;
  try {
    const status = await fetchStatus(socket, message.runId, abort.signal);
    if (!status.status || status.status === "not_found") {
      sendAgentTest(socket, {
        type: "replay_unavailable",
        requestId: message.requestId,
        eventId: message.eventId,
        status: "not_found",
        statusUrl: statusUrl,
      });

      return;
    }
    if (status.conversationKey !== message.conversationKey) {
      sendAgentTest(socket, {
        type: "replay_unavailable",
        requestId: message.requestId,
        eventId: message.eventId,
        status: status.status,
        statusUrl: statusUrl,
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
      connection: connection,
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
        statusUrl: statusUrl,
      });
    if (
      (message.afterCursor && !cursor) ||
      (cursor && cursor.generation !== snapshot.generation) ||
      (cursor?.eventKey !== undefined && cursor.eventKey !== eventKey)
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
        connection: connection,
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
    // Only a client cursor names a real resume point. A fresh attach replays
    // from the subject's earliest retained frame, whose sequence is unknown
    // until it arrives, so no lower bound is advertised for it.
    const replayFrom = cursor ? cursor.sequence + 1 : null;
    sendAgentTest(socket, {
      type: "attached",
      requestId: message.requestId,
      eventId: message.eventId,
      status: status.status,
      ...(snapshot.bufferedCount > 0
        ? {
            ...(replayFrom === null
              ? {}
              : {
                  replayFromCursor: formatCursor(
                    snapshot.generation,
                    replayFrom,
                    eventKey,
                  ),
                }),
            replayThroughCursor: formatCursor(
              snapshot.generation,
              snapshot.lastSequence,
              eventKey,
            ),
          }
        : {}),
      statusUrl: statusUrl,
    });
    clearTimeout(startTimeout);
    await followAttachedExecution(
      socket,
      active,
      message,
      statusUrl,
      status,
      connection,
      snapshot,
      replayFrom,
      eventKey,
    );
  } catch (error) {
    if (!abort.signal.aborted)
      sendAgentTest(socket, { type: "error", error: errorMessage(error) });
  } finally {
    stopActiveRun(socket, active);
  }
}

async function followAttachedExecution(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  active: ActiveRun,
  message: WebSocketClientAttachMessage,
  statusUrl: string,
  initialStatus: IngressHttpResponse,
  connection: NatsConnection,
  snapshot: ReplaySnapshot,
  replayFrom: number | null,
  eventKey: string,
): Promise<void> {
  const buffered = snapshot.bufferedCount > 0;
  // Nothing retained: tail from the snapshot boundary. Retained frames with a
  // cursor: resume after it. Retained frames without one: let the filtered
  // consumer start at this subject's own first frame.
  let startSequence: number | undefined = snapshot.lastSequence + 1;
  let initialConsumedSequence = snapshot.lastSequence;
  if (buffered && replayFrom !== null) {
    startSequence = Math.max(1, replayFrom);
    initialConsumedSequence = startSequence - 1;
  } else if (buffered) {
    startSequence = undefined;
    initialConsumedSequence = 0;
  }

  await followExecution(socket, active.abort.signal, {
    connection: connection,
    scope: {
      accountId: socket.data.accountId,
      agentId: message.agentId,
      conversationKey: message.conversationKey,
    },
    eventId: message.eventId,
    eventKey: eventKey,
    snapshot: snapshot,
    startSequence: startSequence,
    initialConsumedSequence: initialConsumedSequence,
    // Only frames at or below the snapshot existed before the attach.
    isReplay: (sequence) => buffered && sequence <= snapshot.lastSequence,
    statusRequestId: message.requestId,
    runId: message.runId,
    statusUrl: statusUrl,
    seedStatus: initialStatus,
    terminalLabel: "Attached",
  });
}

async function waitForNatsTail(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
  initialBoundary: number;
  lastConsumedSequence: () => number;
  sawDone: () => boolean;
  signal: AbortSignal;
  streamSettled: () => boolean;
}): Promise<void> {
  let boundary = options.initialBoundary;
  let stablePolls = 0;
  // The run is already terminal here, so this drain is bounded: a consumer that
  // stalls below the boundary would otherwise hold the socket open forever.
  const deadline = Date.now() + NATS_TAIL_MAX_WAIT_MS;
  while (
    !options.signal.aborted &&
    !options.sawDone() &&
    !options.streamSettled() &&
    stablePolls < NATS_TAIL_GRACE_POLLS &&
    Date.now() < deadline
  ) {
    if (options.lastConsumedSequence() < boundary) {
      await Bun.sleep(STATUS_POLL_INTERVAL_MS);
      continue;
    }
    await Bun.sleep(STATUS_POLL_INTERVAL_MS);
    if (
      options.signal.aborted ||
      options.sawDone() ||
      options.streamSettled()
    ) {
      break;
    }
    const latest = await conversationReplaySnapshot(options).catch(() => null);
    if (latest && latest.lastSequence > boundary) {
      boundary = latest.lastSequence;
      stablePolls = 0;
      continue;
    }
    stablePolls += 1;
  }
}

/**
 * Reads a run's status from core's in-cluster address. Core's `statusUrl` is
 * the public door, so only its path is kept: a started turn answers with it and
 * no run id, and polling the public URL would hairpin through ingress.
 */
async function fetchStatus(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  runId: string | undefined,
  signal: AbortSignal,
  statusUrl?: string,
): Promise<IngressHttpResponse> {
  const path = runId
    ? `/v1/runs/${encodeURIComponent(runId)}`
    : statusUrl?.match(/\/v1\/runs\/[^/?#]+/)?.[0];
  // Nothing to poll; callers treat a status-less answer as "nothing new yet".
  if (!path) return {};

  return responseJson(
    await fetch(`${socket.data.coreBaseUrl}${path}`, {
      headers: coreHeaders(socket),
      signal: signal,
    }),
  );
}

function coreHeaders(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${socket.data.token}`,
    "Content-Type": "application/json",
    [VIA_GATEWAY_HEADER]: "1",
  };
}

/** Core's error envelope reduced to its message, or the raw body if it is not one. */
async function responseErrorText(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: string | ApiError };

    return errorText(parsed.error) ?? body;
  } catch {
    return body;
  }
}

async function responseJson(response: Response): Promise<IngressHttpResponse> {
  // An unknown run answers 404 with the error envelope, which carries no
  // `status`. The status code is the signal; the body would leave the poll
  // loops spinning on a payload they cannot read.
  if (response.status === 404) return { status: "not_found" };
  const payload = await response.json().catch(() => ({}));

  return payload && typeof payload === "object"
    ? (payload as IngressHttpResponse)
    : {};
}

function ackNatsMessage(message: { ack?: () => void }): void {
  try {
    message.ack?.();
  } catch {
    return;
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

function sendAgentTest(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  payload: WebSocketServerMessage,
): void {
  socket.send(JSON.stringify(payload));
}

/** Emits the single closing frame for a run: done when completed, else error. */
function sendTerminalFrame(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  label: string,
  status: IngressStatus,
  error?: string,
): void {
  if (status !== "completed") {
    sendAgentTest(socket, {
      type: "error",
      error: error ?? `${label} run ended with status ${status}`,
    });

    return;
  }

  sendAgentTest(socket, { type: "done" });
}

/** One stable digest of the status fields a client sees, for change detection. */
function statusFingerprint(status: IngressHttpResponse): string {
  return JSON.stringify([
    status.status,
    status.appliedMode,
    status.appliedToEventId,
    errorText(status.error),
  ]);
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
    sequence: sequence,
    ...(match[3] ? { eventKey: match[3] } : {}),
  };
}

// Core checks each answer's shape and refuses a bad one with a 400.
function hasAnswerInput(value: object): boolean {
  const record = value as { answers?: unknown };

  return Array.isArray(record.answers) && record.answers.length > 0;
}

function hasEventInput(value: object): boolean {
  const record = value as { input?: unknown; events?: unknown };

  return (
    typeof record.input === "string" ||
    (Array.isArray(record.events) && record.events.length > 0)
  );
}

function isAttachMessage(value: object): value is WebSocketClientAttachMessage {
  const record = value as {
    type?: unknown;
    requestId?: unknown;
    agentId?: unknown;
    conversationKey?: unknown;
    eventId?: unknown;
    runId?: unknown;
    afterCursor?: unknown;
  };

  return (
    record.type === "attach" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.agentId === "string" &&
    SUBJECT_TOKEN.test(record.agentId) &&
    typeof record.conversationKey === "string" &&
    record.conversationKey.length > 0 &&
    typeof record.eventId === "string" &&
    record.eventId.length > 0 &&
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    (record.afterCursor === undefined || typeof record.afterCursor === "string")
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

function isExecuteMessage(
  value: object,
): value is WebSocketClientExecuteMessage {
  const record = value as { type?: unknown; agentId?: unknown; mode?: unknown };

  return (
    record.type === "execute" &&
    typeof record.agentId === "string" &&
    SUBJECT_TOKEN.test(record.agentId.trim()) &&
    (record.mode === undefined || isIngressMode(record.mode)) &&
    (hasEventInput(value) || hasAnswerInput(value))
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

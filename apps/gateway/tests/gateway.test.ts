import { expect, test } from "bun:test";
import { DeliverPolicy } from "nats.ws";
import {
  buildCoreRunBody,
  handleAgentMessage,
  parseGatewayMessage,
  stopActiveRun,
  websocketMessageForNatsData,
} from "../src/agent.ts";
import { RateLimiter } from "../src/rate-limiter.ts";
import {
  isConfigHttpPath,
  isCoreHttpRoute,
  matchAgentWebSocketPath,
} from "../src/routes.ts";
import { proxyHttp, resolveObservabilityScope } from "../src/upstream.ts";
import {
  lokiBackfillQuery,
  lokiLogEntry,
  quoteLabel,
  normalizeOtelId,
  relayNatsMessages,
  tempoTraceRowsFromResponse,
} from "../src/observability.ts";
import {
  isSessionInitFrame,
  MAX_PENDING_TERMINAL_BYTES,
  openTerminalTicketWithSecrets,
  openTerminalUpstream,
  relayTerminalInput,
  terminalServiceSecretsFromEnv,
} from "../src/terminal.ts";
import {
  allowedOriginPatternsFromEnv,
  clientIp,
  gatewayLimitsFromEnv,
  isOriginAllowed,
  mapWithConcurrency,
  normalizedCoreBaseUrls,
  websocketToken,
  websocketUpgradeHeaders,
} from "../src/utils.ts";
import { sealTerminalTicket } from "../../core/src/shared/terminal-ticket.ts";
import {
  createSubagentTaskId,
  scopedDirectEventId,
} from "../../core/src/shared/runtime-keys.ts";
import { streamResponseSubject } from "../../core/src/shared/nats.ts";
import {
  isObservabilityClientMessage,
  MAX_OBSERVABILITY_BACKFILL,
} from "../../../packages/broods/src/observability-contracts.ts";

test("builds the core direct API body from a websocket execute message", () => {
  const body = buildCoreRunBody({
    type: "execute",
    agentId: "agent_123",
    sessionId: "demo-session",
    eventId: "event_123",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });

  expect(body).toMatchObject({
    agentId: "agent_123",
    eventId: "event_123",
    conversationKey: "demo-session",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  expect(typeof body.connectionId).toBe("string");
});

test("supports input shorthand for websocket execute messages", () => {
  const body = buildCoreRunBody({
    type: "execute",
    agentId: "agent_123",
    eventId: "event_123",
    input: "hello",
  });

  expect(body).toMatchObject({
    agentId: "agent_123",
    eventId: "event_123",
    conversationKey: "event_123",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  expect(typeof body.connectionId).toBe("string");
});

test("forwards typed NATS stream payloads directly", () => {
  expect(
    websocketMessageForNatsData({
      type: "text-delta",
      id: "text-1",
      text: "hello",
    }),
  ).toEqual({
    type: "text-delta",
    id: "text-1",
    text: "hello",
  });
  expect(websocketMessageForNatsData({ type: "waiting" })).toEqual({
    type: "waiting",
  });
});

test("forwards stream errors directly", () => {
  expect(
    websocketMessageForNatsData({ type: "error", error: "bad key" }),
  ).toEqual({
    type: "error",
    error: "bad key",
  });
});

test("reuses attach and stream contracts for subagent task identities", () => {
  expect(
    parseGatewayMessage(
      JSON.stringify({
        type: "attach",
        requestId: "attach-subagent",
        agentId: "agent_child",
        conversationKey: "subagent-persistent-abc",
        eventId: "subagent_task_123",
      }),
    ),
  ).toEqual({
    type: "attach",
    requestId: "attach-subagent",
    agentId: "agent_child",
    conversationKey: "subagent-persistent-abc",
    eventId: "subagent_task_123",
  });
  expect(
    [
      { type: "reasoning-delta", text: "thinking" },
      { type: "text-delta", text: "answer" },
      { type: "tool-call", toolName: "search" },
    ].map(websocketMessageForNatsData),
  ).toEqual([
    { type: "reasoning-delta", text: "thinking" },
    { type: "text-delta", text: "answer" },
    { type: "tool-call", toolName: "search" },
  ]);
});

test("attaches virtual and private child streams through durable parent deployment authorization", async () => {
  for (const childKind of ["virtual", "private"] as const) {
    const fixture = gatewaySubagentFixture(childKind);
    const originalFetch = globalThis.fetch;
    const sent: Array<Record<string, unknown>> = [];
    const socket = gatewaySocket(sent);
    const connection = replayThenLiveConnection(fixture);
    // Core authorizes the child status read (covered by core's status-access
    // tests); the gateway only proceeds when the returned conversationKey matches.
    globalThis.fetch = (async (input, init) => {
      if (
        new Headers(init?.headers).get("authorization") !== "Bearer runtime-key"
      ) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        });
      }
      const taskId = decodeURIComponent(
        new URL(String(input)).pathname.slice("/status/".length),
      );

      return new Response(
        JSON.stringify({
          eventId: taskId,
          conversationKey: fixture.publicConversationKey,
          status: "processing",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      handleAgentMessage(
        socket,
        JSON.stringify({
          type: "attach",
          requestId: `attach-${childKind}`,
          agentId: fixture.childAgentId,
          conversationKey: fixture.publicConversationKey,
          eventId: fixture.taskId,
        }),
        gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
        async () => connection as never,
      );

      await waitForGatewayMessage(
        sent,
        (message) =>
          message.type === "output" &&
          (message.data as { type?: unknown } | undefined)?.type === "done",
      );

      expect(sent[0]).toMatchObject({
        type: "attached",
        eventId: fixture.taskId,
        status: "processing",
      });
      expect(
        sent
          .filter((message) => message.type === "output")
          .map((message) => message.replay),
      ).toEqual([true, false]);
      expect(
        sent
          .filter((message) => message.type === "output")
          .map((message) => (message.data as { type: string }).type),
      ).toEqual(["reasoning-delta", "done"]);
    } finally {
      stopActiveRun(socket);
      globalThis.fetch = originalFetch;
    }
  }
});

test("rejects an attach whose durable status conversation does not own the requested subject", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  let natsRequested = false;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        eventId: "subagent-task",
        conversationKey: "different-conversation",
        status: "processing",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-wrong-subject",
        agentId: "agent_private",
        conversationKey: "requested-conversation",
        eventId: "subagent-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => {
        natsRequested = true;
        throw new Error("NATS must not be reached");
      },
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "replay_unavailable",
    );
    expect(natsRequested).toBe(false);
    expect(sent).toContainEqual({
      type: "replay_unavailable",
      requestId: "attach-wrong-subject",
      eventId: "subagent-task",
      status: "processing",
      statusUrl: "/status/subagent-task?agentId=agent_private",
    });
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("keeps a zero-buffer processing attach open for future live frames", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  const encoder = new TextEncoder();
  let consumerClosed = false;
  let consumerOptions:
    | { deliver_policy?: DeliverPolicy; opt_start_seq?: number }
    | undefined;
  const streamEvent = (sequence: number, data: Record<string, unknown>) => ({
    seq: sequence,
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: "acct_test",
          agentId: "agent_child",
          conversationKey: "child-conversation",
          eventId: "child-task",
          connectionId: "child-task",
        },
        data: data,
        sequence: sequence,
      }),
    ),
    ack: () => {},
  });
  const connection = zeroBufferConnection(
    async () => ({
      [Symbol.asyncIterator]: async function* () {
        await Bun.sleep(50);
        yield streamEvent(21, { type: "text-delta", text: "future" });
        yield streamEvent(22, { type: "done" });
      },
      close: async () => {
        consumerClosed = true;
      },
    }),
    (options) => {
      consumerOptions = options;
    },
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: "processing",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-live",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) =>
        message.type === "output" &&
        (message.data as { type?: unknown } | undefined)?.type === "done",
    );
    expect(sent[0]).toMatchObject({
      type: "attached",
      requestId: "attach-live",
      status: "processing",
    });
    expect(consumerOptions).toMatchObject({
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: 21,
    });
    expect(
      sent
        .filter((message) => message.type === "output")
        .map((message) => ({
          replay: message.replay,
          type: (message.data as { type: string }).type,
        })),
    ).toEqual([
      { replay: false, type: "text-delta" },
      { replay: false, type: "done" },
    ]);
    await waitForCondition(
      () => consumerClosed,
      100,
      () => "consumer close",
    );
    expect(
      sent.filter(
        (message) =>
          message.type === "done" ||
          (message.type === "error" && message.eventId === "child-task"),
      ),
    ).toHaveLength(0);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("finishes buffered replay before applying terminal tail grace", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  const encoder = new TextEncoder();
  let consumerClosed = false;
  const streamEvent = (sequence: number, data: Record<string, unknown>) => ({
    seq: sequence,
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: "acct_test",
          agentId: "agent_child",
          conversationKey: "child-conversation",
          eventId: "child-task",
          connectionId: "child-task",
        },
        data: data,
        sequence: sequence,
      }),
    ),
    ack: () => {},
  });
  const connection = zeroBufferConnection(
    async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent(10, { type: "text-delta", text: "first" });
        await Bun.sleep(2_100);
        if (consumerClosed) return;
        yield streamEvent(11, { type: "text-delta", text: "last" });
        yield streamEvent(12, { type: "done" });
      },
      close: async () => {
        consumerClosed = true;
      },
    }),
    undefined,
    { bufferedCount: 3, firstSequence: 10, lastSequence: 12 },
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-buffered-terminal",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "4000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) =>
        message.type === "output" &&
        (message.data as { type?: unknown } | undefined)?.type === "done",
      1_600,
    );
    expect(
      sent
        .filter((message) => message.type === "output")
        .map((message) => (message.data as { type: string }).type),
    ).toEqual(["text-delta", "text-delta", "done"]);
    expect(
      sent.filter(
        (message) => message.type === "done" || message.type === "error",
      ),
    ).toHaveLength(0);
    await waitForCondition(
      () => consumerClosed,
      100,
      () => "consumer close",
    );
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("replays a fresh buffered attach from its own subject, not the shared stream head", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  const encoder = new TextEncoder();
  const consumerOptions: Array<Record<string, unknown>> = [];
  const streamEvent = (sequence: number, data: Record<string, unknown>) => ({
    seq: sequence,
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: "acct_test",
          agentId: "agent_child",
          conversationKey: "child-conversation",
          eventId: "child-task",
          connectionId: "child-task",
        },
        data: data,
        sequence: sequence,
      }),
    ),
    ack: () => {},
  });
  // The oldest message retained on the shared stream is sequence 2 and belongs
  // to another conversation; this subject's own frames start at 10.
  const connection = zeroBufferConnection(
    async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent(10, { type: "text-delta", text: "first" });
        yield streamEvent(12, { type: "done" });
      },
      close: async () => {},
    }),
    (options) => {
      consumerOptions.push(options);
    },
    { bufferedCount: 2, firstSequence: 2, lastSequence: 12 },
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-foreign-head",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "4000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "attached",
      1_600,
    );
    const attached = sent.find((message) => message.type === "attached");
    // A cursor built from the shared stream head names another conversation's
    // message, so resuming with it would be denied by the subject check.
    expect(attached?.replayFromCursor).toBeUndefined();
    // The inclusive upper bound is this subject's own last sequence.
    expect(attached?.replayThroughCursor).toContain(":12:");
    expect(consumerOptions[0]?.opt_start_seq).toBeUndefined();
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("closes a zero-frame attach after durable completion and emits one terminal frame", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  let consumerClosed = false;
  let statusReads = 0;
  const connection = zeroBufferConnection(async () => ({
    [Symbol.asyncIterator]: async function* () {
      while (!consumerClosed) {
        await Bun.sleep(10);
      }
    },
    close: async () => {
      consumerClosed = true;
    },
  }));
  globalThis.fetch = (async () => {
    statusReads += 1;

    return new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: statusReads === 1 ? "processing" : "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-empty",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "done",
      700,
    );
    expect(consumerClosed).toBe(true);
    expect(sent.filter((message) => message.type === "done")).toHaveLength(1);
    expect(sent).toContainEqual({
      type: "status",
      requestId: "attach-empty",
      eventId: "child-task",
      status: "completed",
      statusUrl: "/status/child-task?agentId=agent_child",
    });
    expect(sent.some((message) => message.type === "error")).toBe(false);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("does not duplicate a streamed error when durable failure arrives without done", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  const encoder = new TextEncoder();
  let consumerClosed = false;
  let statusReads = 0;
  const connection = zeroBufferConnection(async () => ({
    [Symbol.asyncIterator]: async function* () {
      yield {
        seq: 21,
        data: encoder.encode(
          JSON.stringify({
            type: "stream",
            headers: {
              accountId: "acct_test",
              agentId: "agent_child",
              conversationKey: "child-conversation",
              eventId: "child-task",
              connectionId: "child-task",
            },
            data: { type: "error", error: "child failed" },
            sequence: 1,
          }),
        ),
        ack: () => {},
      };
      while (!consumerClosed) {
        await Bun.sleep(10);
      }
    },
    close: async () => {
      consumerClosed = true;
    },
  }));
  globalThis.fetch = (async () => {
    statusReads += 1;

    return new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: statusReads === 1 ? "processing" : "failed",
        error: "child failed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-failed",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForCondition(
      () => consumerClosed,
      700,
      () => "consumer close",
    );
    expect(
      sent.filter(
        (message) =>
          message.type === "output" &&
          (message.data as { type?: unknown } | undefined)?.type === "error",
      ),
    ).toHaveLength(1);
    expect(sent.filter((message) => message.type === "error")).toHaveLength(0);
    expect(sent.filter((message) => message.type === "done")).toHaveLength(0);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("closes a zero-frame queued execute consumer after durable completion", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  let consumerClosed = false;
  const connection = zeroBufferConnection(async () => ({
    [Symbol.asyncIterator]: async function* () {
      while (!consumerClosed) {
        await Bun.sleep(10);
      }
    },
    close: async () => {
      consumerClosed = true;
    },
  }));
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({
          eventId: "queued-task",
          conversationKey: "queued-conversation",
          status: "queued",
          statusUrl: "/status/queued-task?agentId=agent_child",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        eventId: "queued-task",
        conversationKey: "queued-conversation",
        status: "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "execute",
        agentId: "agent_child",
        sessionId: "queued-conversation",
        eventId: "queued-task",
        input: "continue",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "done",
      700,
    );
    expect(consumerClosed).toBe(true);
    expect(sent.filter((message) => message.type === "done")).toHaveLength(1);
    expect(sent.some((message) => message.type === "error")).toBe(false);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("falls back to durable attach status when NATS consumer creation fails", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  let statusReads = 0;
  const connection = zeroBufferConnection(async () => {
    throw new Error("consumer unavailable");
  });
  globalThis.fetch = (async () => {
    statusReads += 1;

    return new Response(
      JSON.stringify({
        eventId: "child-task",
        conversationKey: "child-conversation",
        status: statusReads === 1 ? "processing" : "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach-nats-unavailable",
        agentId: "agent_child",
        conversationKey: "child-conversation",
        eventId: "child-task",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "done",
      300,
    );
    expect(sent.filter((message) => message.type === "done")).toHaveLength(1);
    expect(sent.some((message) => message.type === "error")).toBe(false);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("falls back to durable queued status when NATS consumer creation fails", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const socket = gatewaySocket(sent);
  const connection = zeroBufferConnection(async () => {
    throw new Error("consumer unavailable");
  });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({
          eventId: "queued-task",
          conversationKey: "queued-conversation",
          status: "queued",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        eventId: "queued-task",
        conversationKey: "queued-conversation",
        status: "completed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  try {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "execute",
        agentId: "agent_child",
        sessionId: "queued-conversation",
        eventId: "queued-task",
        input: "continue",
      }),
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "1000" }),
      async () => connection as never,
    );

    await waitForGatewayMessage(
      sent,
      (message) => message.type === "done",
      300,
    );
    expect(sent.filter((message) => message.type === "done")).toHaveLength(1);
    expect(sent.some((message) => message.type === "error")).toBe(false);
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("parses only valid gateway websocket messages", () => {
  expect(parseGatewayMessage("{not json")).toBeNull();
  expect(parseGatewayMessage(JSON.stringify({ type: "cancel" }))).toEqual({
    type: "cancel",
  });
  expect(
    parseGatewayMessage(
      JSON.stringify({ type: "execute", agentId: "agent_123", input: "hello" }),
    ),
  ).toMatchObject({ type: "execute", agentId: "agent_123" });
  expect(
    parseGatewayMessage(JSON.stringify({ type: "execute", agentId: "   " })),
  ).toBeNull();
  expect(
    parseGatewayMessage(
      JSON.stringify({
        type: "control",
        requestId: "request-2",
        eventId: "event-2",
        mode: "steer",
        input: "change direction",
      }),
    ),
  ).toMatchObject({ type: "control", mode: "steer" });
  expect(
    parseGatewayMessage(
      JSON.stringify({
        type: "control",
        requestId: "request-default",
        eventId: "event-default",
        input: "steer by default",
      }),
    ),
  ).toEqual({
    type: "control",
    requestId: "request-default",
    eventId: "event-default",
    input: "steer by default",
  });
  expect(
    parseGatewayMessage(
      JSON.stringify({
        type: "attach",
        requestId: "attach-1",
        agentId: "agent_123",
        conversationKey: "conversation-1",
        eventId: "event-1",
        afterCursor: "ws-responses:generation:42",
      }),
    ),
  ).toMatchObject({
    type: "attach",
    afterCursor: "ws-responses:generation:42",
  });
});

test("rejects invalid agent websocket messages and closes the socket", () => {
  const sent: unknown[] = [];
  const closes: Array<[number, string]> = [];
  const socket = {
    data: {
      kind: "agent-test",
      corePath: "/v1/agents/agent_1",
      token: "runtime-key",
      coreBaseUrl: "https://core.example",
      accountId: "account-1",
    },
    send: (value: string) => sent.push(JSON.parse(value)),
    close: (code: number, reason: string) => closes.push([code, reason]),
  } as unknown as Bun.ServerWebSocket<
    import("../src/agent.ts").AgentTestGatewayData
  >;

  handleAgentMessage(
    socket,
    "{not json",
    gatewayLimitsFromEnv({}),
    async () => {
      throw new Error("NATS should not be reached");
    },
  );

  expect(sent).toEqual([{ type: "error", error: "Invalid WebSocket message" }]);
  expect(closes).toEqual([[1003, "invalid message"]]);
});

test("rejects a second active agent run on the same websocket", () => {
  const originalFetch = globalThis.fetch;
  const sent: unknown[] = [];
  const socket = {
    data: {
      kind: "agent-test",
      corePath: "/v1/agents/agent_1",
      token: "runtime-key",
      coreBaseUrl: "https://core.example",
      accountId: "account-1",
    },
    send: (value: string) => sent.push(JSON.parse(value)),
    close: () => {},
  } as unknown as Bun.ServerWebSocket<
    import("../src/agent.ts").AgentTestGatewayData
  >;

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as typeof fetch;

  try {
    const message = JSON.stringify({
      type: "execute",
      agentId: "agent_123",
      eventId: "event_1",
      input: "hello",
    });
    handleAgentMessage(
      socket,
      message,
      gatewayLimitsFromEnv({ GATEWAY_RUN_START_TIMEOUT_MS: "10000" }),
      async () => {
        throw new Error("NATS should not be reached");
      },
    );
    handleAgentMessage(socket, message, gatewayLimitsFromEnv({}), async () => {
      throw new Error("NATS should not be reached");
    });

    expect(sent).toContainEqual({
      type: "error",
      error: "A run is already active on this WebSocket",
    });
  } finally {
    stopActiveRun(socket);
    globalThis.fetch = originalFetch;
  }
});

test("uses conservative gateway limit defaults", () => {
  expect(gatewayLimitsFromEnv({})).toEqual({
    maxConnections: 10_000,
    maxPayloadBytes: 1024 * 1024,
    backpressureBytes: 1024 * 1024,
    idleTimeoutSeconds: 255,
    runStartTimeoutMs: 15_000,
  });
});

test("ignores invalid gateway limit overrides", () => {
  expect(
    gatewayLimitsFromEnv({
      GATEWAY_MAX_CONNECTIONS: "500",
      GATEWAY_MAX_PAYLOAD_BYTES: "bad",
      GATEWAY_BACKPRESSURE_BYTES: "-1",
      GATEWAY_IDLE_TIMEOUT_SECONDS: "60",
      GATEWAY_RUN_START_TIMEOUT_MS: "2500",
    }),
  ).toEqual({
    maxConnections: 500,
    maxPayloadBytes: 1024 * 1024,
    backpressureBytes: 1024 * 1024,
    idleTimeoutSeconds: 60,
    runStartTimeoutMs: 2500,
  });
});

test("caps gateway idle timeout at Bun's supported maximum", () => {
  expect(
    gatewayLimitsFromEnv({
      GATEWAY_IDLE_TIMEOUT_SECONDS: "300",
    }).idleTimeoutSeconds,
  ).toBe(255);
});

test("normalizes and de-duplicates unified gateway core upstreams", () => {
  expect(
    normalizedCoreBaseUrls([
      "https://dev-core.example.com/",
      "https://prod-core.example.com",
      "https://dev-core.example.com",
    ]),
  ).toEqual(["https://dev-core.example.com", "https://prod-core.example.com"]);
  expect(() => normalizedCoreBaseUrls(["", "  "])).toThrow("Gateway requires");
});

test("proxies runtime HTTP paths used by the SDK", () => {
  expect(isCoreHttpRoute("/")).toBe(true);
  expect(isCoreHttpRoute("/accounts")).toBe(true);
  expect(isCoreHttpRoute("/async")).toBe(true);
  expect(isCoreHttpRoute("/status/request-1")).toBe(true);
  // The one webhook shape reaches core, and so does a retired agent-scoped URL:
  // core answers that with a 404 naming the right one, which it cannot do if
  // the gateway swallows the path first.
  expect(isCoreHttpRoute("/webhooks/acct_1/slack")).toBe(true);
  expect(isCoreHttpRoute("/webhooks/acct_1/agent_1/slack")).toBe(true);
  expect(isCoreHttpRoute("/v1/crons")).toBe(true);
  expect(isCoreHttpRoute("/v1/demo/agents/development/env_123/async")).toBe(
    true,
  );
  expect(isCoreHttpRoute("/healthz")).toBe(false);
});

test("routes config-plane CRUD to Convex, not core", () => {
  // Account metadata/rotation plus agents, skills, tools, hooks, workspace files, crons, workspaces, sandboxes, policies, and channels are Convex config-plane routes.
  for (const method of ["GET", "POST", "PUT"]) {
    expect(isConfigHttpPath("/v1/account/onboarding", method)).toBe(true);
    expect(
      isConfigHttpPath("/v1/account/projects/p/stages/e/manifest", method),
    ).toBe(true);
  }
  expect(isConfigHttpPath("/v1/accountx", "GET")).toBe(false);
  expect(isConfigHttpPath("/v1/account", "DELETE")).toBe(false);
  expect(isConfigHttpPath("/v1/account", "GET")).toBe(true);
  expect(isConfigHttpPath("/v1/account", "PATCH")).toBe(true);
  expect(isConfigHttpPath("/v1/account/rotate-secret", "POST")).toBe(true);
  expect(isConfigHttpPath("/accounts", "GET")).toBe(true);
  expect(isConfigHttpPath("/accounts/acct_1", "GET")).toBe(true);
  expect(isConfigHttpPath("/accounts/acct_1", "PATCH")).toBe(true);
  expect(isConfigHttpPath("/accounts/acct_1/rotate-secret", "POST")).toBe(true);
  expect(isConfigHttpPath("/v1/agents", "GET")).toBe(true);
  expect(isConfigHttpPath("/v1/agents", "POST")).toBe(true);
  expect(isConfigHttpPath("/v1/agents/agent_1", "GET")).toBe(true);
  expect(isConfigHttpPath("/v1/agents/agent_1", "PATCH")).toBe(true);
  expect(isConfigHttpPath("/v1/agents/agent_1", "DELETE")).toBe(true);
  expect(
    isConfigHttpPath("/v1/agents/agent_1/channels/slack/directory", "GET"),
  ).toBe(true);
  expect(
    isConfigHttpPath("/v1/agents/agent_1/channels/slack/directory", "POST"),
  ).toBe(false);
  expect(isConfigHttpPath("/v1/env", "GET")).toBe(true);
  expect(isConfigHttpPath("/v1/env/OVH_API_KEY", "PUT")).toBe(true);
  expect(isConfigHttpPath("/v1/env/OVH_API_KEY", "DELETE")).toBe(true);
  expect(isConfigHttpPath("/v1/skills")).toBe(true);
  expect(isConfigHttpPath("/v1/skills/my-skill")).toBe(true);
  // /v1/tools is retired (#331 phase 3); it no longer routes to the config plane.
  expect(isConfigHttpPath("/v1/tools")).toBe(false);
  expect(isConfigHttpPath("/v1/mcp")).toBe(true);
  expect(isConfigHttpPath("/v1/mcp/k57mcpserver00000000000000000000")).toBe(
    true,
  );
  expect(isConfigHttpPath("/v1/hooks")).toBe(true);
  expect(isConfigHttpPath("/v1/hooks/k17zwc4z4q5ysxm74fgrhd13s88xxtv")).toBe(
    true,
  );
  expect(isConfigHttpPath("/v1/workspaces")).toBe(true);
  expect(isConfigHttpPath("/v1/workspaces/ws_123")).toBe(true);
  expect(isConfigHttpPath("/v1/workspaces/ws_123/files")).toBe(true);
  expect(isConfigHttpPath("/v1/workspaces/ws_123/download-links", "POST")).toBe(
    true,
  );
  expect(isConfigHttpPath("/v1/workspaces/ws_123/download-links", "GET")).toBe(
    false,
  );
  // Redeeming a download link is unauthenticated and read-only.
  expect(isConfigHttpPath("/v1/downloads/tok_abc", "GET")).toBe(true);
  expect(isConfigHttpPath("/v1/downloads/tok_abc", "HEAD")).toBe(true);
  expect(isConfigHttpPath("/v1/downloads/tok_abc", "DELETE")).toBe(false);
  expect(isConfigHttpPath("/v1/downloads", "GET")).toBe(false);
  expect(isConfigHttpPath("/v1/downloads/tok_abc/extra", "GET")).toBe(false);
  expect(isConfigHttpPath("/v1/sandboxes")).toBe(true);
  expect(isConfigHttpPath("/v1/sandboxes/sbx_1")).toBe(true);
  expect(isConfigHttpPath("/v1/policies")).toBe(true);
  expect(isConfigHttpPath("/v1/policies/pol_1")).toBe(true);
  expect(isConfigHttpPath("/v1/roles")).toBe(true);
  expect(isConfigHttpPath("/v1/roles/fp_role_abc")).toBe(true);
  expect(isConfigHttpPath("/v1/account/assume-role", "POST")).toBe(true);
  expect(isConfigHttpPath("/v1/channels")).toBe(true);
  expect(isConfigHttpPath("/v1/channels/chan_1")).toBe(true);
  expect(isConfigHttpPath("/v1/crons")).toBe(true);
  expect(isConfigHttpPath("/v1/crons/cron_123")).toBe(true);
  expect(isConfigHttpPath("/v1/crons/cron_123/runs")).toBe(true);
  expect(isConfigHttpPath("/v1/cron-runs", "POST")).toBe(false);

  // Exact depth only: scoped agent invocations and other resources stay core.
  expect(isConfigHttpPath("/v1/account", "DELETE")).toBe(false);
  expect(isConfigHttpPath("/accounts", "POST")).toBe(false);
  expect(isConfigHttpPath("/accounts/acct_1", "DELETE")).toBe(false);
  expect(isConfigHttpPath("/accounts/acct_1/rotate-secret", "GET")).toBe(false);
  expect(isConfigHttpPath("/accounts/acct_1/agents", "GET")).toBe(false);
  expect(isConfigHttpPath("/accounts/acct_1/rotate-secret/extra", "POST")).toBe(
    false,
  );
  // The whole /v1/account/ subtree is Convex's; core only owns the exact-path DELETE.
  expect(isConfigHttpPath("/v1/account/rotate-secret", "POST")).toBe(true);
  expect(isConfigHttpPath("/v1/account/auth/exchange", "POST")).toBe(true);
  expect(isConfigHttpPath("/v1/skills/agents/development/env_123")).toBe(false);
  expect(isConfigHttpPath("/v1/hooks/agents/development/env_123")).toBe(false);
  expect(isConfigHttpPath("/v1/crons/agents/development/env_123")).toBe(false);
  expect(isConfigHttpPath("/v1/sandboxes/sbx_1/exec")).toBe(false);
  expect(isConfigHttpPath("/v1/sandboxes/sbx_1/terminal")).toBe(false);
  expect(isConfigHttpPath("/v1/policies/agents/development/env_123")).toBe(
    false,
  );
  expect(isConfigHttpPath("/v1/channels/agents/development/env_123")).toBe(
    false,
  );
  expect(isConfigHttpPath("/v1/agents/agent_1", "POST")).toBe(false);
  expect(isConfigHttpPath("/v1/env", "PUT")).toBe(false);
  expect(isConfigHttpPath("/v1/env/OVH_API_KEY", "GET")).toBe(false);
  expect(isConfigHttpPath("/v1/agents/agent_1/ws", "GET")).toBe(false);
  expect(isConfigHttpPath("/v1/agents/agent_1/async", "POST")).toBe(false);
  expect(isConfigHttpPath("/v1/demo/agents/development/env_123", "POST")).toBe(
    false,
  );
  expect(
    isConfigHttpPath("/v1/demo/agents/development/env_123/async", "POST"),
  ).toBe(false);
  expect(
    isConfigHttpPath("/v1/demo/agents/development/env_123/ws", "GET"),
  ).toBe(false);
});

test("parses agent websocket paths so the upgrade can bind the key's endpoint scope", () => {
  expect(matchAgentWebSocketPath("/v1/agents/env_123/ws")).toEqual({
    endpointId: "env_123",
  });
  expect(
    matchAgentWebSocketPath("/v1/demo/agents/development/env_123/ws"),
  ).toEqual({
    projectSlug: "demo",
    stageSlug: "development",
    endpointId: "env_123",
  });
  expect(
    matchAgentWebSocketPath("/v1/demo/agents/dev%20stage/stage%20123/ws"),
  ).toEqual({
    projectSlug: "demo",
    stageSlug: "dev stage",
    endpointId: "stage 123",
  });
  expect(matchAgentWebSocketPath("/v1/agents/env_123")).toBeNull();
  expect(matchAgentWebSocketPath("/v1/demo/observability/ws")).toBeNull();
  expect(matchAgentWebSocketPath("/v1/demo/agents/development/ws")).toBeNull();
});

test("routes a runtime key to the matching core upstream", async () => {
  const calls: string[] = [];
  const resolved = await resolveObservabilityScope(
    "runtime-key",
    ["https://dev.example", "https://prod.example"],
    async (input) => {
      calls.push(String(input));
      if (new URL(String(input)).origin === "https://dev.example")
        return new Response("unauthorized", { status: 401 });

      return Response.json({
        accountId: "account-1",
        projectSlug: "project",
        stageSlug: "production",
        endpointIds: ["endpoint-1"],
      });
    },
  );

  expect(calls).toHaveLength(2);
  expect(resolved).toMatchObject({
    coreBaseUrl: "https://prod.example",
    scope: { stageSlug: "production" },
  });
});

test("proxyHttp strips hop-by-hop headers and preserves method query and body", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init: init });

    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const response = await proxyHttp(
      new Request("https://gateway.example/v1/agents?debug=1", {
        method: "POST",
        headers: {
          host: "gateway.example",
          connection: "upgrade",
          upgrade: "websocket",
          "x-test": "yes",
        },
        body: "hello",
      }),
      ["https://core.example"],
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("https://core.example/v1/agents?debug=1");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("manual");
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.get("x-test")).toBe("yes");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("upgrade")).toBe(false);
    expect(new TextDecoder().decode(calls[0]!.init?.body as ArrayBuffer)).toBe(
      "hello",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxyHttp falls through to the next upstream only on 401", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));

    return calls.length === 1
      ? new Response("unauthorized", { status: 401 })
      : new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const response = await proxyHttp(
      new Request("https://gateway.example/status/request-1"),
      ["https://dev.example", "https://prod.example"],
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "https://dev.example/status/request-1",
      "https://prod.example/status/request-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds observability backfill requests", () => {
  expect(
    isObservabilityClientMessage({
      type: "subscribe",
      stream: "logs",
      backfill: 100,
    }),
  ).toBe(true);
  expect(
    isObservabilityClientMessage({
      type: "subscribe",
      stream: "logs",
      liveOnly: true,
    }),
  ).toBe(true);
  expect(
    isObservabilityClientMessage({
      type: "subscribe",
      stream: "logs",
      liveOnly: "true",
    }),
  ).toBe(false);
  expect(
    isObservabilityClientMessage({
      type: "subscribe",
      stream: "logs",
      backfill: MAX_OBSERVABILITY_BACKFILL + 1,
    }),
  ).toBe(false);
  expect(
    isObservabilityClientMessage({
      type: "subscribe",
      stream: "logs",
      backfill: Number.POSITIVE_INFINITY,
    }),
  ).toBe(false);
});

test("observability relay skips malformed and below-threshold log messages", async () => {
  const encoder = new TextEncoder();
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0,
    send: (value: string) => sent.push(JSON.parse(value)),
  } as unknown as Bun.ServerWebSocket<
    import("../src/observability.ts").ObservabilityGatewayData
  >;
  const messages = async function* () {
    yield { data: encoder.encode("{not json") };
    yield {
      data: encoder.encode(
        JSON.stringify({
          ts: 1,
          level: "INFO",
          eventType: "info",
          message: "skip",
        }),
      ),
    };
    yield {
      data: encoder.encode(
        JSON.stringify({
          ts: 2,
          level: "ERROR",
          eventType: "error",
          message: "keep",
        }),
      ),
    };
  };

  await relayNatsMessages(socket, messages(), "logs", { logsMinLevel: "WARN" });

  expect(sent).toEqual([
    {
      type: "log",
      entry: { ts: 2, level: "ERROR", eventType: "error", message: "keep" },
    },
  ]);
});

test("asks Loki to drop the levels a subscription does not want", () => {
  const scope = {
    accountId: "acct-1",
    projectSlug: "shop",
    stageSlug: "dev",
    endpointIds: [],
  };
  const selector = '{account_id="acct-1",project="shop",stage="dev"}';

  // A DEBUG subscriber wants everything, so nothing is filtered away.
  expect(lokiBackfillQuery(scope, "DEBUG")).toBe(selector);
  expect(lokiBackfillQuery(scope, "WARN")).toBe(
    `${selector} | level!~"(?i)(DEBUG|INFO)"`,
  );
  expect(lokiBackfillQuery(scope, "ERROR")).toBe(
    `${selector} | level!~"(?i)(DEBUG|INFO|WARN)"`,
  );
});

test("reads a lowercase Loki level label as its real level", () => {
  expect(
    lokiLogEntry(
      { account_id: "acct-1", detected_level: "debug" },
      "s3.write start",
      1_700_000_000_000,
      "fallback",
    ).level,
  ).toBe("DEBUG");
});

test("rehydrates Loki OTLP metadata for durable log history", () => {
  expect(
    lokiLogEntry(
      {
        account_id: "acct-1",
        endpoint_id: "endpoint-1",
        agent_id: "agent-1",
        conversation_key: "conversation-1",
        eventType: "service.agent.config.updated",
        level: "INFO",
        service_name: "broods-account-manage",
        trace_id: "trace-1",
        changedFields: '["modelId"]',
      },
      "Agent configuration updated",
      1_700_000_000_000,
      "fallback",
    ),
  ).toMatchObject({
    ts: 1_700_000_000_000,
    level: "INFO",
    eventType: "service.agent.config.updated",
    message: "Agent configuration updated",
    traceId: "trace-1",
    accountId: "acct-1",
    endpointId: "endpoint-1",
    agentId: "agent-1",
    conversationKey: "conversation-1",
    service: "broods-account-manage",
    data: { changedFields: '["modelId"]' },
  });
});

test("reconstructs full Tempo span trees with tenant attributes and errors", () => {
  const rows = tempoTraceRowsFromResponse({
    batches: [
      {
        resource: {
          attributes: [
            { key: "account_id", value: { stringValue: "acct-1" } },
            { key: "endpoint_id", value: { stringValue: "endpoint-1" } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "trace-1",
                spanId: "root-1",
                name: "agent.task",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "3000000000",
                attributes: [
                  { key: "agent_id", value: { stringValue: "agent-1" } },
                ],
                status: { code: 1 },
              },
              {
                traceId: "trace-1",
                spanId: "tool-1",
                parentSpanId: "root-1",
                name: "tool.call",
                startTimeUnixNano: "1500000000",
                endTimeUnixNano: "2000000000",
                status: { code: 2, message: "tool failed" },
              },
            ],
          },
        ],
      },
    ],
  });

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    traceId: "trace-1",
    spanId: "root-1",
    kind: "task",
    endpointId: "endpoint-1",
    agentId: "agent-1",
    durationMs: 2_000,
    status: "ok",
  });
  expect(rows[1]).toMatchObject({
    spanId: "tool-1",
    parentSpanId: "root-1",
    kind: "tool.call",
    durationMs: 500,
    status: "error",
    error: "tool failed",
  });
});

test("normalizes base64 Tempo ids to hex so backfill keys match live spans", () => {
  // 16-byte trace id and 8-byte span id, hex then base64-encoded.
  const traceHex = "2e4a86cf02516e0768dff2a96ae9eb12";
  const spanHex = "5bb16b70ae735d82";
  const traceB64 = Buffer.from(traceHex, "hex").toString("base64");
  const spanB64 = Buffer.from(spanHex, "hex").toString("base64");

  expect(normalizeOtelId(traceB64, 16)).toBe(traceHex);
  expect(normalizeOtelId(spanB64, 8)).toBe(spanHex);
  // Already-hex ids pass through unchanged; unknown fixtures are left alone.
  expect(normalizeOtelId(traceHex, 16)).toBe(traceHex);
  expect(normalizeOtelId("trace-1", 16)).toBe("trace-1");
  expect(normalizeOtelId("root-1", 8)).toBe("root-1");
});

test("reconstructs Tempo span trees from base64-encoded ids", () => {
  const rootHex = "1111111111111111";
  const childHex = "2222222222222222";
  const traceHex = "33333333333333333333333333333333";
  const rows = tempoTraceRowsFromResponse({
    batches: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from(traceHex, "hex").toString("base64"),
                spanId: Buffer.from(childHex, "hex").toString("base64"),
                parentSpanId: Buffer.from(rootHex, "hex").toString("base64"),
                name: "tool.call",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1500000000",
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });

  expect(rows[0]).toMatchObject({
    traceId: traceHex,
    spanId: childHex,
    parentSpanId: rootHex,
    kind: "tool.call",
  });
});

test("maps phase span names to the phase kind on Tempo backfill", () => {
  const rows = tempoTraceRowsFromResponse({
    batches: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "trace-1",
                spanId: "phase-1",
                parentSpanId: "root-1",
                name: "phase.cold_start",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1500000000",
                attributes: [
                  { key: "phase.name", value: { stringValue: "Cold start" } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    spanId: "phase-1",
    parentSpanId: "root-1",
    kind: "phase",
    durationMs: 500,
    status: "ok",
    attributes: { "phase.name": "Cold start" },
  });
});

test("maps with bounded concurrency, preserves order, and isolates failures", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (n === 3) throw new Error("boom");

    return n * 10;
  });

  expect(peak).toBeLessThanOrEqual(2);
  expect(
    results.map((r) => (r.status === "fulfilled" ? r.value : r.reason.message)),
  ).toEqual([10, 20, "boom", 40, 50]);
});

test("collects stage service secrets from the env (multi-stage or single)", () => {
  expect(
    terminalServiceSecretsFromEnv({
      BROODS_SERVICE_AUTH_SECRETS: "dev-secret, prod-secret,dev-secret",
    }),
  ).toEqual(["dev-secret", "prod-secret"]);
  expect(
    terminalServiceSecretsFromEnv({
      BROODS_SERVICE_AUTH_SECRET: "only-secret",
    }),
  ).toEqual(["only-secret"]);
  expect(terminalServiceSecretsFromEnv({})).toEqual([]);
});

test("opens a sealed terminal ticket with whichever stage secret verifies it", () => {
  const ticket = {
    url: "ws://sandbox-node.example:8080/v1/sandboxes/sb_1/pty",
    authorization: "Bearer sk_live_key",
    accountId: "acct_1",
    expiresAt: Date.now() + 60_000,
  };
  const sealed = sealTerminalTicket(ticket, "prod-secret");

  expect(
    openTerminalTicketWithSecrets(sealed, ["dev-secret", "prod-secret"]),
  ).toEqual(ticket);
  expect(openTerminalTicketWithSecrets(sealed, ["dev-secret"])).toBeNull();
  expect(openTerminalTicketWithSecrets("", ["dev-secret"])).toBeNull();
  expect(
    openTerminalTicketWithSecrets("garbage-token", [
      "dev-secret",
      "prod-secret",
    ]),
  ).toBeNull();
});

test("recognizes only the MicroVM shell session_init metadata frame", () => {
  expect(isSessionInitFrame('{"type":"session_init","session_id":"abc"}')).toBe(
    true,
  );
  expect(isSessionInitFrame('{"type":"resize"}')).toBe(false);
  expect(isSessionInitFrame("$ echo hello")).toBe(false);
  expect(isSessionInitFrame("{not json")).toBe(false);
});

test("preserves the MicroVM shell auth header through the sealed ticket", () => {
  const ticket = {
    url: "wss://mvm-1.lambda-microvm.eu-west-1.on.aws",
    authorization: "jwe-shell-token",
    authorizationHeader: "X-aws-proxy-auth",
    accountId: "acct_1",
    expiresAt: Date.now() + 60_000,
  };

  expect(
    openTerminalTicketWithSecrets(sealTerminalTicket(ticket, "dev-secret"), [
      "dev-secret",
    ]),
  ).toEqual(ticket);
});

test("terminal relay closes sockets that exceed the pending input buffer", () => {
  const originalWebSocket = globalThis.WebSocket;
  const closes: Array<[number, string]> = [];

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string, _options?: unknown) {}
    send(_chunk: unknown) {}
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const socket = {
      readyState: FakeWebSocket.OPEN,
      data: {
        kind: "terminal",
        ticket: {
          url: "ws://sandbox.example/pty",
          authorization: "Bearer sandbox-token",
          accountId: "acct_1",
          expiresAt: Date.now() + 60_000,
        },
      },
      send: () => {},
      close: (code: number, reason: string) => closes.push([code, reason]),
    } as unknown as Bun.ServerWebSocket<
      import("../src/terminal.ts").TerminalGatewayData
    >;

    openTerminalUpstream(socket);
    relayTerminalInput(socket, Buffer.alloc(MAX_PENDING_TERMINAL_BYTES + 1));

    expect(closes).toEqual([[1009, "terminal input buffer exceeded"]]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("terminal upstream filters only the first session_init frame", () => {
  const originalWebSocket = globalThis.WebSocket;
  const sent: unknown[] = [];

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string, _options?: unknown) {
      FakeWebSocket.instances.push(this);
    }
    send(_chunk: unknown) {}
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const socket = {
      readyState: FakeWebSocket.OPEN,
      data: {
        kind: "terminal",
        ticket: {
          url: "ws://sandbox.example/pty",
          authorization: "Bearer sandbox-token",
          accountId: "acct_1",
          expiresAt: Date.now() + 60_000,
        },
      },
      send: (value: unknown) => sent.push(value),
      close: () => {},
    } as unknown as Bun.ServerWebSocket<
      import("../src/terminal.ts").TerminalGatewayData
    >;

    openTerminalUpstream(socket);
    const upstream = FakeWebSocket.instances[0]!;
    upstream.onmessage?.({
      data: '{"type":"session_init","session_id":"abc"}',
    });
    upstream.onmessage?.({ data: "$ echo hello" });

    expect(sent).toEqual(["$ echo hello"]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("origin allow-list: defaults cover broods.app, wildcards, and non-browser clients", () => {
  const defaults = allowedOriginPatternsFromEnv({});
  expect(isOriginAllowed(null, defaults)).toBe(true);
  expect(isOriginAllowed("", defaults)).toBe(true);
  expect(isOriginAllowed("https://dashboard.broods.app", defaults)).toBe(true);
  expect(isOriginAllowed("https://dashboard.dev.broods.app", defaults)).toBe(
    true,
  );
  expect(isOriginAllowed("https://broods.app", defaults)).toBe(true);
  expect(isOriginAllowed("http://localhost:3000", defaults)).toBe(true);
  expect(isOriginAllowed("https://evil.example.com", defaults)).toBe(false);
  expect(isOriginAllowed("https://broods.app.evil.com", defaults)).toBe(false);
  expect(isOriginAllowed("not a url", defaults)).toBe(false);

  const custom = allowedOriginPatternsFromEnv({
    GATEWAY_ALLOWED_ORIGINS: "app.example.com, *.internal.example.com",
  });
  expect(isOriginAllowed("https://app.example.com", custom)).toBe(true);
  expect(isOriginAllowed("https://x.internal.example.com", custom)).toBe(true);
  expect(isOriginAllowed("https://dashboard.broods.app", custom)).toBe(false);
  expect(isOriginAllowed("https://anything.example", ["*"])).toBe(true);
});

test("rate limiter: bounds a window, probes without counting, and resets", async () => {
  const limiter = new RateLimiter(3, 50);
  expect(limiter.allow("ip-1")).toBe(true);
  expect(limiter.allow("ip-1")).toBe(true);
  expect(limiter.allow("ip-1")).toBe(true);
  expect(limiter.allow("ip-1")).toBe(false);
  expect(limiter.blocked("ip-1")).toBe(true);
  expect(limiter.blocked("ip-1")).toBe(true);
  expect(limiter.allow("ip-2")).toBe(true);
  expect(limiter.blocked("ip-2")).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(limiter.blocked("ip-1")).toBe(false);
  expect(limiter.allow("ip-1")).toBe(true);
});

test("websocket token prefers the Authorization header over the query param", () => {
  const url = new URL("https://gateway.example.com/ws?token=from-query");
  const withHeader = new Request(url, {
    headers: { authorization: "Bearer from-header" },
  });
  expect(websocketToken(withHeader, url)).toBe("from-header");
  expect(websocketToken(new Request(url), url)).toBe("from-query");

  const bare = new URL("https://gateway.example.com/ws");
  expect(websocketToken(new Request(bare), bare)).toBe("");
});

test("client ip takes the rightmost forwarded hop, then the socket address", () => {
  const withForwarded = new Request("https://gateway.example.com/", {
    headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
  });
  expect(clientIp(withForwarded, "127.0.0.1")).toBe("10.0.0.1");

  // Only the ingress appends the rightmost hop, so a caller cannot mint a fresh
  // rate-limit bucket by prepending one or by sending its own x-real-ip.
  const spoofed = new Request("https://gateway.example.com/", {
    headers: {
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.9, 198.51.100.1, 10.0.0.1",
    },
  });
  expect(clientIp(spoofed, "127.0.0.1")).toBe("10.0.0.1");

  expect(
    clientIp(new Request("https://gateway.example.com/"), "127.0.0.1"),
  ).toBe("127.0.0.1");
  expect(clientIp(new Request("https://gateway.example.com/"), undefined)).toBe(
    "unknown",
  );
});

test("proxyHttp returns 502 when every upstream is unreachable", async () => {
  const response = await proxyHttp(
    new Request("https://gateway.example.com/v1/agents"),
    ["http://127.0.0.1:9", "http://127.0.0.1:1"],
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Upstream is unreachable" });
});

test("observability relay sheds droppable frames when the socket buffer is backed up", async () => {
  const encoder = new TextEncoder();
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    getBufferedAmount: () => 10 * 1024 * 1024,
    send: (value: string) => sent.push(JSON.parse(value)),
  } as unknown as Bun.ServerWebSocket<
    import("../src/observability.ts").ObservabilityGatewayData
  >;
  const messages = async function* () {
    yield {
      data: encoder.encode(
        JSON.stringify({
          ts: 1,
          level: "ERROR",
          eventType: "error",
          message: "shed me",
        }),
      ),
    };
  };

  await relayNatsMessages(socket, messages(), "logs", { logsMinLevel: "INFO" });
  expect(sent).toEqual([]);
});

test("observability relay waits out span backpressure instead of shedding", async () => {
  const encoder = new TextEncoder();
  const sent: unknown[] = [];
  // Backed up for the first few polls, drained afterwards — the relay must
  // deliver the span once the buffer drops rather than shedding it.
  let drainChecks = 0;
  const socket = {
    readyState: WebSocket.OPEN,
    getBufferedAmount: () => (drainChecks++ < 3 ? 10 * 1024 * 1024 : 0),
    send: (value: string) => sent.push(JSON.parse(value)),
  } as unknown as Bun.ServerWebSocket<
    import("../src/observability.ts").ObservabilityGatewayData
  >;
  const span = {
    traceId: "trace-1",
    spanId: "span-1",
    name: "agent.task",
    kind: "task",
    startTimeMs: 1,
    endTimeMs: 2,
    durationMs: 1,
    status: "ok",
    attributes: {},
  };
  const messages = async function* () {
    yield { data: encoder.encode(JSON.stringify(span)) };
  };

  await relayNatsMessages(socket, messages(), "traces", {
    logsMinLevel: "INFO",
  });
  expect(sent).toEqual([{ type: "span", entry: span }]);
});

function gatewaySocket(sent: Array<Record<string, unknown>>) {
  return {
    data: {
      kind: "agent-test",
      corePath: "/v1/demo/agents/development/env-endpoint",
      token: "runtime-key",
      coreBaseUrl: "https://core.example",
      accountId: "acct_test",
    },
    send: (value: string) =>
      sent.push(JSON.parse(value) as Record<string, unknown>),
    close: () => {},
  } as unknown as Bun.ServerWebSocket<
    import("../src/agent.ts").AgentTestGatewayData
  >;
}

function gatewaySubagentFixture(childKind: "private" | "virtual") {
  const account = { accountId: "acct_test" };
  const parentEventId = scopedDirectEventId(
    account.accountId,
    "agent_parent",
    "parent-event",
  );
  const taskId = createSubagentTaskId(
    parentEventId,
    "019833ce-7f5d-7000-8000-000000000001",
  );
  const childAgentId =
    childKind === "virtual" ? `virtual_subagent_${taskId}` : "agent_private";

  return {
    account: account,
    taskId: taskId,
    childAgentId: childAgentId,
    publicConversationKey: "subagent-child",
  };
}

function replayThenLiveConnection(
  fixture: ReturnType<typeof gatewaySubagentFixture>,
) {
  const encoder = new TextEncoder();
  const subject = streamResponseSubject(
    fixture.account.accountId,
    fixture.childAgentId,
    fixture.publicConversationKey,
  );
  const streamMessage = (sequence: number, data: Record<string, unknown>) => ({
    seq: sequence,
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: fixture.account.accountId,
          agentId: fixture.childAgentId,
          conversationKey: fixture.publicConversationKey,
          eventId: fixture.taskId,
          connectionId: fixture.taskId,
        },
        data: data,
        sequence: sequence,
      }),
    ),
    ack: () => {},
  });
  const messages = [
    streamMessage(10, { type: "reasoning-delta", text: "thinking" }),
    streamMessage(11, { type: "done" }),
  ];

  return {
    jetstreamManager: async () => ({
      streams: {
        add: async () => {},
        getMessage: async () => ({ seq: 10, subject: subject }),
        info: async (
          _name: string,
          options?: { subjects_filter?: string },
        ) => ({
          created: "2026-07-24T00:00:00.000Z",
          state: {
            first_seq: 10,
            last_seq: 10,
            subjects: options?.subjects_filter ? { [subject]: 1 } : {},
          },
        }),
        update: async () => {},
      },
    }),
    jetstream: () => ({
      consumers: {
        get: async () => ({
          consume: async () => ({
            [Symbol.asyncIterator]: async function* () {
              for (const message of messages) {
                yield message;
              }
            },
            close: async () => {},
          }),
        }),
      },
    }),
  };
}

async function waitForGatewayMessage(
  sent: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  attempts = 100,
): Promise<void> {
  await waitForCondition(
    () => sent.some(predicate),
    attempts,
    () => `Timed out waiting for gateway message: ${JSON.stringify(sent)}`,
  );
}

/**
 * For conditions that do not depend on a sent frame. `sent.some(predicate)`
 * never calls the predicate while `sent` is empty, so those waits would time
 * out even once the condition held.
 */
async function waitForCondition(
  condition: () => boolean,
  attempts = 100,
  describe: () => string = () => "condition",
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error(`Timed out waiting for ${describe()}`);
}

function zeroBufferConnection(
  consume: () => Promise<{
    [Symbol.asyncIterator](): AsyncIterator<{
      seq: number;
      data: Uint8Array;
      ack(): void;
    }>;
    close(): Promise<void>;
  }>,
  onConsumerOptions?: (options: {
    deliver_policy?: DeliverPolicy;
    opt_start_seq?: number;
  }) => void,
  snapshot = {
    bufferedCount: 0,
    firstSequence: 1,
    lastSequence: 20,
  },
) {
  return {
    jetstreamManager: async () => ({
      streams: {
        add: async () => {},
        getMessage: async (
          _stream: string,
          query: { last_by_subj?: string },
        ) => ({
          seq: query.last_by_subj
            ? snapshot.lastSequence
            : snapshot.firstSequence,
        }),
        info: async (
          _name: string,
          options?: { subjects_filter?: string },
        ) => ({
          created: "2026-07-24T00:00:00.000Z",
          state: {
            first_seq: snapshot.firstSequence,
            last_seq: snapshot.lastSequence,
            subjects: options?.subjects_filter
              ? { [options.subjects_filter]: snapshot.bufferedCount }
              : undefined,
          },
        }),
        update: async () => {},
      },
    }),
    jetstream: () => ({
      consumers: {
        get: async (
          _stream: string,
          options: {
            deliver_policy?: DeliverPolicy;
            opt_start_seq?: number;
          },
        ) => {
          onConsumerOptions?.(options);

          return { consume: consume };
        },
      },
    }),
  };
}

test("websocket token reads the broods.token subprotocol before the query param", () => {
  const url = new URL("https://gateway.example.com/ws?token=from-query");
  const request = new Request(url, {
    headers: { "sec-websocket-protocol": "broods.v1, broods.token.from-proto" },
  });
  expect(websocketToken(request, url)).toBe("from-proto");
  // The handshake completes only when the offered subprotocol is echoed.
  expect(websocketUpgradeHeaders(request)).toEqual({
    "Sec-WebSocket-Protocol": "broods.v1",
  });
  expect(websocketUpgradeHeaders(new Request(url))).toEqual({});
});

test("observability selectors keep a hostile stage slug inside the string", () => {
  const scope = {
    accountId: "acct-1",
    projectSlug: "shop",
    stageSlug: 'dev"} or {stage=~".+',
    endpointIds: [],
  };
  expect(quoteLabel(scope.stageSlug)).toBe('"dev\\"} or {stage=~\\".+"');
  expect(lokiBackfillQuery(scope, "DEBUG")).toBe(
    '{account_id="acct-1",project="shop",stage="dev\\"} or {stage=~\\".+"}',
  );
});

test("proxyHttp forwards X-Account-Id by default and drops it when told to", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<string | null> = [];
  globalThis.fetch = (async (_input, init) => {
    seen.push(new Headers(init?.headers).get("x-account-id"));

    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const request = () =>
      new Request("https://gateway.example/v1/sandboxes/sb_1/terminate", {
        method: "POST",
        headers: { "x-account-id": "acct_1", authorization: "Bearer svc" },
        body: "{}",
      });
    await proxyHttp(request(), ["https://core.example"]);
    await proxyHttp(request(), ["https://core.example"], {
      forwardAccountId: false,
    });

    expect(seen).toEqual(["acct_1", null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

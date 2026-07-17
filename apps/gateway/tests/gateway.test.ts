import { expect, test } from "bun:test";
import {
  buildCoreRunBody,
  handleAgentMessage,
  parseGatewayMessage,
  stopActiveRun,
  websocketMessageForNatsData,
} from "../src/agent.ts";
import { RateLimiter } from "../src/rate-limiter.ts";
import { isConfigHttpPath, isCoreHttpRoute } from "../src/routes.ts";
import { proxyHttp, resolveObservabilityScope } from "../src/upstream.ts";
import {
  lokiLogEntry,
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
} from "../src/utils.ts";
import { sealTerminalTicket } from "../../core/src/shared/terminal-ticket.ts";
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
  expect(isCoreHttpRoute("/v1/crons")).toBe(true);
  expect(isCoreHttpRoute("/v1/demo/agents/development/env_123/async")).toBe(
    true,
  );
  expect(isCoreHttpRoute("/healthz")).toBe(false);
});

test("routes config-plane CRUD to Convex, not core", () => {
  // Account metadata/rotation plus agents, skills, tools, hooks, workspace files, crons, workspaces, sandboxes, and policies are Convex config-plane routes.
  for (const method of ["GET", "POST", "PUT"]) {
    expect(isConfigHttpPath("/v1/account/onboarding", method)).toBe(true);
    expect(
      isConfigHttpPath(
        "/v1/account/projects/p/environments/e/manifest",
        method,
      ),
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
  expect(isConfigHttpPath("/v1/tools")).toBe(true);
  expect(isConfigHttpPath("/v1/tools/qs78zwc4z4q5ysxm74fgrhd13s88xxt")).toBe(
    true,
  );
  expect(isConfigHttpPath("/v1/hooks")).toBe(true);
  expect(isConfigHttpPath("/v1/hooks/k17zwc4z4q5ysxm74fgrhd13s88xxtv")).toBe(
    true,
  );
  expect(isConfigHttpPath("/v1/workspaces")).toBe(true);
  expect(isConfigHttpPath("/v1/workspaces/ws_123")).toBe(true);
  expect(isConfigHttpPath("/v1/workspaces/ws_123/files")).toBe(true);
  expect(isConfigHttpPath("/v1/sandboxes")).toBe(true);
  expect(isConfigHttpPath("/v1/sandboxes/sbx_1")).toBe(true);
  expect(isConfigHttpPath("/v1/policies")).toBe(true);
  expect(isConfigHttpPath("/v1/policies/pol_1")).toBe(true);
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

test("routes a runtime key to the matching core upstream", async () => {
  const calls: string[] = [];
  const resolved = await resolveObservabilityScope(
    "runtime-key",
    ["https://dev.example", "https://prod.example"],
    async (input) => {
      calls.push(String(input));
      if (String(input).startsWith("https://dev.example"))
        return new Response("unauthorized", { status: 401 });
      return Response.json({
        accountId: "account-1",
        projectSlug: "project",
        environmentSlug: "production",
        endpointIds: ["endpoint-1"],
      });
    },
  );

  expect(calls).toHaveLength(2);
  expect(resolved).toMatchObject({
    coreBaseUrl: "https://prod.example",
    scope: { environmentSlug: "production" },
  });
});

test("proxyHttp strips hop-by-hop headers and preserves method query and body", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
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

test("client ip prefers x-real-ip, then x-forwarded-for, then the socket address", () => {
  const withRealIp = new Request("https://gateway.example.com/", {
    headers: {
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1, 10.0.0.1",
    },
  });
  expect(clientIp(withRealIp, "127.0.0.1")).toBe("203.0.113.7");

  const withForwarded = new Request("https://gateway.example.com/", {
    headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
  });
  expect(clientIp(withForwarded, "127.0.0.1")).toBe("198.51.100.1");
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

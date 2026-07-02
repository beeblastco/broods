import { expect, test } from "bun:test";
import {
  buildCoreRunBody,
  isCoreHttpPathForTest,
  gatewayLimitsFromEnv,
  mapWithConcurrency,
  normalizedCoreBaseUrls,
  normalizeOtelId,
  openTerminalTicketWithSecrets,
  resolveObservabilityScope,
  tempoTraceRowsFromResponse,
  terminalServiceSecretsFromEnv,
  lokiLogEntry,
  websocketMessageForNatsData,
} from "../src/index.ts";
import { sealTerminalTicket } from "../../core/functions/_shared/terminal-ticket.ts";
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
  expect(websocketMessageForNatsData({ type: "text-delta", id: "text-1", text: "hello" })).toEqual({
    type: "text-delta",
    id: "text-1",
    text: "hello",
  });
  expect(websocketMessageForNatsData({ type: "waiting" })).toEqual({ type: "waiting" });
});

test("forwards stream errors directly", () => {
  expect(websocketMessageForNatsData({ type: "error", error: "bad key" })).toEqual({
    type: "error",
    error: "bad key",
  });
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
  expect(gatewayLimitsFromEnv({
    GATEWAY_MAX_CONNECTIONS: "500",
    GATEWAY_MAX_PAYLOAD_BYTES: "bad",
    GATEWAY_BACKPRESSURE_BYTES: "-1",
    GATEWAY_IDLE_TIMEOUT_SECONDS: "60",
    GATEWAY_RUN_START_TIMEOUT_MS: "2500",
  })).toEqual({
    maxConnections: 500,
    maxPayloadBytes: 1024 * 1024,
    backpressureBytes: 1024 * 1024,
    idleTimeoutSeconds: 60,
    runStartTimeoutMs: 2500,
  });
});

test("caps gateway idle timeout at Bun's supported maximum", () => {
  expect(gatewayLimitsFromEnv({
    GATEWAY_IDLE_TIMEOUT_SECONDS: "300",
  }).idleTimeoutSeconds).toBe(255);
});

test("normalizes and de-duplicates unified gateway core upstreams", () => {
  expect(normalizedCoreBaseUrls([
    "https://dev-core.example.com/",
    "https://prod-core.example.com",
    "https://dev-core.example.com",
  ])).toEqual([
    "https://dev-core.example.com",
    "https://prod-core.example.com",
  ]);
  expect(() => normalizedCoreBaseUrls(["", "  "])).toThrow("Gateway requires");
});

test("proxies runtime HTTP paths used by the SDK", () => {
  expect(isCoreHttpPathForTest("/")).toBe(true);
  expect(isCoreHttpPathForTest("/async")).toBe(true);
  expect(isCoreHttpPathForTest("/status/request-1")).toBe(true);
  expect(isCoreHttpPathForTest("/accounts/me/crons")).toBe(true);
  expect(isCoreHttpPathForTest("/v1/demo/agents/development/env_123/async")).toBe(true);
  expect(isCoreHttpPathForTest("/healthz")).toBe(false);
});

test("routes a runtime key to the matching core upstream", async () => {
  const calls: string[] = [];
  const resolved = await resolveObservabilityScope("runtime-key", ["https://dev.example", "https://prod.example"],
    async (input) => {
      calls.push(String(input));
      if (String(input).startsWith("https://dev.example")) return new Response("unauthorized", { status: 401 });
      return Response.json({
        accountId: "account-1",
        projectSlug: "project",
        environmentSlug: "production",
        endpointIds: ["endpoint-1"],
      });
    });

  expect(calls).toHaveLength(2);
  expect(resolved).toMatchObject({
    coreBaseUrl: "https://prod.example",
    scope: { environmentSlug: "production" },
  });
});

test("bounds observability backfill requests", () => {
  expect(isObservabilityClientMessage({ type: "subscribe", stream: "logs", backfill: 100 })).toBe(true);
  expect(isObservabilityClientMessage({ type: "subscribe", stream: "logs", liveOnly: true })).toBe(true);
  expect(isObservabilityClientMessage({ type: "subscribe", stream: "logs", liveOnly: "true" })).toBe(false);
  expect(isObservabilityClientMessage({
    type: "subscribe",
    stream: "logs",
    backfill: MAX_OBSERVABILITY_BACKFILL + 1,
  })).toBe(false);
  expect(isObservabilityClientMessage({ type: "subscribe", stream: "logs", backfill: Number.POSITIVE_INFINITY })).toBe(false);
});

test("rehydrates Loki OTLP metadata for durable log history", () => {
  expect(lokiLogEntry({
    account_id: "acct-1",
    endpoint_id: "endpoint-1",
    agent_id: "agent-1",
    conversation_key: "conversation-1",
    eventType: "service.agent.config.updated",
    level: "INFO",
    service_name: "broods-account-manage",
    trace_id: "trace-1",
    changedFields: "[\"modelId\"]",
  }, "Agent configuration updated", 1_700_000_000_000, "fallback"))
    .toMatchObject({
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
      data: { changedFields: "[\"modelId\"]" },
    });
});

test("reconstructs full Tempo span trees with tenant attributes and errors", () => {
  const rows = tempoTraceRowsFromResponse({
    batches: [{
      resource: { attributes: [
        { key: "account_id", value: { stringValue: "acct-1" } },
        { key: "endpoint_id", value: { stringValue: "endpoint-1" } },
      ] },
      scopeSpans: [{ spans: [
        {
          traceId: "trace-1",
          spanId: "root-1",
          name: "agent.task",
          startTimeUnixNano: "1000000000",
          endTimeUnixNano: "3000000000",
          attributes: [{ key: "agent_id", value: { stringValue: "agent-1" } }],
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
      ] }],
    }],
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
    batches: [{
      resource: { attributes: [] },
      scopeSpans: [{ spans: [
        {
          traceId: Buffer.from(traceHex, "hex").toString("base64"),
          spanId: Buffer.from(childHex, "hex").toString("base64"),
          parentSpanId: Buffer.from(rootHex, "hex").toString("base64"),
          name: "tool.call",
          startTimeUnixNano: "1000000000",
          endTimeUnixNano: "1500000000",
          status: { code: 1 },
        },
      ] }],
    }],
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
    batches: [{
      resource: { attributes: [] },
      scopeSpans: [{ spans: [
        {
          traceId: "trace-1",
          spanId: "phase-1",
          parentSpanId: "root-1",
          name: "phase.cold_start",
          startTimeUnixNano: "1000000000",
          endTimeUnixNano: "1500000000",
          attributes: [{ key: "phase.name", value: { stringValue: "Cold start" } }],
          status: { code: 1 },
        },
      ] }],
    }],
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
  expect(results.map((r) => (r.status === "fulfilled" ? r.value : r.reason.message))).toEqual([
    10,
    20,
    "boom",
    40,
    50,
  ]);
});

test("collects stage service secrets from the env (multi-stage or single)", () => {
  expect(terminalServiceSecretsFromEnv({ BROODS_SERVICE_AUTH_SECRETS: "dev-secret, prod-secret,dev-secret" }))
    .toEqual(["dev-secret", "prod-secret"]);
  expect(terminalServiceSecretsFromEnv({ BROODS_SERVICE_AUTH_SECRET: "only-secret" })).toEqual(["only-secret"]);
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

  expect(openTerminalTicketWithSecrets(sealed, ["dev-secret", "prod-secret"])).toEqual(ticket);
  expect(openTerminalTicketWithSecrets(sealed, ["dev-secret"])).toBeNull();
  expect(openTerminalTicketWithSecrets("", ["dev-secret"])).toBeNull();
  expect(openTerminalTicketWithSecrets("garbage-token", ["dev-secret", "prod-secret"])).toBeNull();
});

test("preserves the MicroVM shell auth header through the sealed ticket", () => {
  const ticket = {
    url: "wss://mvm-1.lambda-microvm.eu-west-1.on.aws",
    authorization: "jwe-shell-token",
    authorizationHeader: "X-aws-proxy-auth",
    accountId: "acct_1",
    expiresAt: Date.now() + 60_000,
  };

  expect(openTerminalTicketWithSecrets(sealTerminalTicket(ticket, "dev-secret"), ["dev-secret"])).toEqual(ticket);
});

import { expect, test } from "bun:test";
import {
  buildCoreRunBody,
  gatewayLimitsFromEnv,
  normalizedCoreBaseUrls,
  resolveObservabilityScope,
  tempoTraceRowsFromResponse,
  lokiLogEntry,
  websocketMessageForNatsData,
} from "../src/index.ts";
import {
  isObservabilityClientMessage,
  MAX_OBSERVABILITY_BACKFILL,
} from "../../../packages/filthy-panty/src/observability-contracts.ts";

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
    service_name: "filthy-panty-account-manage",
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
      service: "filthy-panty-account-manage",
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

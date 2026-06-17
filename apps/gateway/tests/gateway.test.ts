import { expect, test } from "bun:test";
import { buildCoreRunBody, gatewayLimitsFromEnv, websocketMessageForNatsData } from "../src/index.ts";

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

import { expect, test } from "bun:test";
import { buildCoreRunBody, websocketMessageForStreamPart } from "../src/index.ts";

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

test("translates text stream parts to websocket deltas", () => {
  expect(websocketMessageForStreamPart({ type: "text-delta", id: "text-1", text: "hello" })).toEqual({
    type: "continuation_delta",
    delta: "hello",
  });
});

test("translates stream errors to websocket errors", () => {
  expect(websocketMessageForStreamPart({ type: "error", error: { message: "bad key" } })).toEqual({
    type: "error",
    error: "bad key",
  });
});

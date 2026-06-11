/**
 * Agent lifecycle webhook emitter tests.
 * Cover event filtering, delivery, error handling, and value serialization.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { createAgentLifecycleEmitter, toLifecycleValue } from "../functions/harness-processing/lifecycle.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createAgentLifecycleEmitter", () => {
  const baseSession = {
    accountId: "acct_test",
    agentId: "agent_test",
    eventId: "evt_123",
    conversationKey: "direct:conv_1",
  };

  it("does not fire when webhook is not enabled", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: false,
          url: "https://example.com/hook",
          secret: "secret",
        },
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when webhook url is missing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          secret: "secret",
        },
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when webhook secret is missing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
        },
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when event is not in subscribed events allow-list", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
          events: ["agent.finished"],
        },
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires webhook for subscribed events", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
          events: ["agent.started", "agent.finished"],
        },
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google", modelId: "gemini-2.0" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/hook");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    expect(init?.headers).toHaveProperty("X-Webhook-Signature");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      type: "agent.started",
      accountId: "acct_test",
      agentId: "agent_test",
      eventId: "evt_123",
      conversationKey: "direct:conv_1",
      payload: { modelProvider: "google", modelId: "gemini-2.0" },
    });
  });

  it("fires all events when no events allow-list is configured", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
        },
      },
    });

    await emitter.emit("tool.call.started", { stepNumber: 1 });
    await emitter.emit("agent.finished", { finishReason: "stop" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs error when webhook delivery fails", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
        },
      },
    });

    await emitter.emit("agent.failed", { error: "something broke" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes accountId and agentId only when present in session", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter({
      eventId: "evt_456",
      conversationKey: "direct:conv_2",
    } as never, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
        },
      },
    });

    await emitter.emit("agent.started", {});

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("accountId");
    expect(body).not.toHaveProperty("agentId");
    expect(body.eventId).toBe("evt_456");
    expect(body.conversationKey).toBe("direct:conv_2");
  });

  it("generates ISO timestamp for each event", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhook: {
          enabled: true,
          url: "https://example.com/hook",
          secret: "secret",
        },
      },
    });

    await emitter.emit("agent.started", {});

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});

describe("toLifecycleValue", () => {
  it("returns undefined for undefined input", () => {
    expect(toLifecycleValue(undefined)).toBeUndefined();
  });

  it("serializes and parses plain objects", () => {
    const input = { success: true, count: 42 };
    expect(toLifecycleValue(input)).toEqual({ success: true, count: 42 });
  });

  it("serializes and parses arrays", () => {
    const input = ["a", "b", "c"];
    expect(toLifecycleValue(input)).toEqual(["a", "b", "c"]);
  });

  it("serializes and parses primitives", () => {
    expect(toLifecycleValue(42)).toBe(42);
    expect(toLifecycleValue("hello")).toBe("hello");
    expect(toLifecycleValue(true)).toBe(true);
    expect(toLifecycleValue(null)).toBeNull();
  });

  it("returns stringified fallback for non-serializable values", () => {
    const result = toLifecycleValue(() => {});
    expect(typeof result).toBe("string");
  });

  it("handles BigInt by falling back to string", () => {
    const result = toLifecycleValue(BigInt(9007199254740991));
    expect(typeof result).toBe("string");
    expect(result).toBe("9007199254740991");
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BroodsWebSocketClient,
  WebsocketClient,
  toWebSocketBaseUrl,
  type WebSocketServerMessage,
  type WebSocketLike,
} from "../src/websocket.ts";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.onclose?.({ code: code, reason: reason });
  }

  emit(message: WebSocketServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  delete process.env.BROODS_DASHBOARD_URL;
  delete process.env.BROODS_TOKEN;
  delete process.env.BROODS_PROJECT;
  delete process.env.BROODS_ENVIRONMENT;
  delete process.env.BROODS_BASE_URL;
  delete process.env.BROODS_HOST;
  delete process.env.BROODS_API_KEY;
});

test("websocket client accepts host as a shorthand for the core service URL", () => {
  const client = new BroodsWebSocketClient({
    host: "app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://app.example/v1/agents/agent_1/ws?token=test-key",
  );
});

test("websocket URL normalization accepts https and wss service URLs", () => {
  expect(toWebSocketBaseUrl("https://app.example")).toBe("wss://app.example");
  expect(toWebSocketBaseUrl("wss://app.example")).toBe("wss://app.example");
});

test("exports WebsocketClient as an alias", () => {
  expect(WebsocketClient).toBe(BroodsWebSocketClient);
});

test("websocket client reads apiKey from the shared SDK environment variable", () => {
  process.env.BROODS_API_KEY = "env-key";
  const client = new BroodsWebSocketClient({
    host: "app.example",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://app.example/v1/agents/agent_1/ws?token=env-key",
  );
});

test("websocket client reads apiKey from package-local .env.local", () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "broods-websocket-"));
  delete process.env.BROODS_API_KEY;
  writeFileSync(join(tempDir, ".env.local"), "BROODS_API_KEY=local-env-key\n");
  process.chdir(tempDir);

  try {
    const client = new BroodsWebSocketClient({
      host: "app.example",
      WebSocket: FakeWebSocket,
    });

    expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
      "wss://app.example/v1/agents/agent_1/ws?token=local-env-key",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.BROODS_API_KEY;
  }
});

test("websocket client can be constructed without options", () => {
  process.env.BROODS_API_KEY = "env-key";
  const client = new BroodsWebSocketClient();

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://gateway.broods.app/v1/agents/agent_1/ws?token=env-key",
  );
});

test("websocket client lets BROODS_BASE_URL override the default service URL", () => {
  process.env.BROODS_BASE_URL = "https://gateway.example";
  const client = new BroodsWebSocketClient({
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://gateway.example/v1/agents/agent_1/ws?token=test-key",
  );
});

test("websocket client subscribes to the core service and forwards server messages", async () => {
  const messages: WebSocketServerMessage[] = [];
  let done = false;
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  const subscription = client.subscribe(
    {
      endpointId: "agent_1",
      projectSlug: "demo",
      environmentSlug: "development",
      events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      sessionId: "session_1",
      system: {
        role: "system",
        content: "Keep the answer short.",
      },
      model: {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
        },
      },
    },
    {
      onMessage(message) {
        messages.push(message);
      },
      onDone() {
        done = true;
      },
    },
  );

  expect(subscription.url).toBe(
    "wss://app.example/v1/demo/agents/development/agent_1/ws?token=test-key",
  );

  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: "execute",
    agentId: "agent_1",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    sessionId: "session_1",
    system: {
      role: "system",
      content: "Keep the answer short.",
    },
    model: {
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      },
    },
  });

  socket.emit({ type: "text-delta", id: "text-1", text: "hello" });
  socket.emit({ type: "waiting" });
  socket.emit({ type: "done" });

  expect(messages).toEqual([
    { type: "text-delta", id: "text-1", text: "hello" },
    { type: "waiting" },
    { type: "done" },
  ]);
  expect(done).toBe(true);
});

test("websocket client unwraps output envelopes for handlers and stream consumers", async () => {
  const messages: WebSocketServerMessage[] = [];
  const outputs: unknown[] = [];
  let done = false;
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  client.subscribe(
    {
      endpointId: "agent_1",
      agentId: "agent_1",
      sessionId: "conversation-1",
      input: "start",
    },
    {
      onMessage(message) {
        messages.push(message);
      },
      onOutput(output) {
        outputs.push(output);
      },
      onDone() {
        done = true;
      },
    },
  );
  await Promise.resolve();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.emit({
    type: "output",
    eventId: "event-1",
    cursor: "ws-responses:generation:42:event-key",
    replay: false,
    data: { type: "text-delta", id: "text-1", text: "hello" },
  });
  socket.emit({
    type: "output",
    eventId: "event-1",
    cursor: "ws-responses:generation:43:event-key",
    replay: false,
    data: { type: "done" },
  });

  // Handlers see the inner stream parts (message.type === "text-delta"), and
  // onOutput receives the raw envelope so clients can persist resume cursors.
  expect(messages).toEqual([
    { type: "text-delta", id: "text-1", text: "hello" },
    { type: "done" },
  ]);
  expect(outputs).toEqual([
    {
      type: "output",
      eventId: "event-1",
      cursor: "ws-responses:generation:42:event-key",
      replay: false,
      data: { type: "text-delta", id: "text-1", text: "hello" },
    },
    {
      type: "output",
      eventId: "event-1",
      cursor: "ws-responses:generation:43:event-key",
      replay: false,
      data: { type: "done" },
    },
  ]);
  expect(done).toBe(true);
});

test("websocket client sends correlated control and attach frames", async () => {
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });
  const subscription = client.subscribe({
    endpointId: "agent_1",
    agentId: "agent_1",
    sessionId: "conversation-1",
    input: "start",
  });
  await Promise.resolve();
  subscription.sendControl({
    requestId: "request-2",
    eventId: "event-2",
    mode: "steer",
    input: "change direction",
  });
  expect(JSON.parse(FakeWebSocket.instances[0]!.sent[1]!)).toMatchObject({
    type: "control",
    requestId: "request-2",
    mode: "steer",
  });
  subscription.close();

  const attached = client.attach({
    endpointId: "agent_1",
    requestId: "attach-1",
    agentId: "agent_1",
    conversationKey: "conversation-1",
    eventId: "event-1",
    afterCursor: "ws-responses:generation:42",
  });
  await Promise.resolve();
  expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
    type: "attach",
    requestId: "attach-1",
    afterCursor: "ws-responses:generation:42",
  });
  attached.close();
});

test("websocket client can build scoped URLs from generated agent references", async () => {
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  const subscription = client.subscribe({
    agent: {
      kind: "agent",
      name: "chat",
      id: "agent_123",
      project: "demo",
      environment: "development",
      endpointId: "env_123",
      projectSlug: "demo",
      environmentSlug: "development",
    },
    input: "hello",
  });

  expect(subscription.url).toBe(
    "wss://app.example/v1/demo/agents/development/env_123/ws?token=test-key",
  );

  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: "execute",
    agentId: "agent_123",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
});

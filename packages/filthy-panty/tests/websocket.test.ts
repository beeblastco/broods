import { afterEach, expect, test } from "bun:test";
import {
  FilthyPantyWebSocketClient,
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
  delete process.env.FILTHY_PANTY_API_KEY;
});

test("websocket client accepts host as a shorthand for the core service URL", () => {
  const client = new FilthyPantyWebSocketClient({
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
  expect(WebsocketClient).toBe(FilthyPantyWebSocketClient);
});

test("websocket client reads apiKey from the shared SDK environment variable", () => {
  process.env.FILTHY_PANTY_API_KEY = "env-key";
  const client = new FilthyPantyWebSocketClient({
    host: "app.example",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://app.example/v1/agents/agent_1/ws?token=env-key",
  );
});

test("websocket client subscribes to the core service and forwards server messages", async () => {
  const messages: WebSocketServerMessage[] = [];
  const sseChunks: string[] = [];
  let done = false;
  const client = new FilthyPantyWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  const subscription = client.subscribe({
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
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
    },
  }, {
    onMessage(message) {
      messages.push(message);
    },
    onSse(chunk) {
      sseChunks.push(chunk);
    },
    onDone() {
      done = true;
    },
  });

  expect(subscription.url).toBe(
    "wss://app.example/v1/demo/agents/development/agent_1/ws?token=test-key",
  );

  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: "execute",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    sessionId: "session_1",
    system: {
      role: "system",
      content: "Keep the answer short.",
    },
    model: {
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
    },
  });

  socket.emit({ type: "sse", chunk: "data: {}\n\n" });
  socket.emit({ type: "done" });

  expect(messages).toEqual([
    { type: "sse", chunk: "data: {}\n\n" },
    { type: "done" },
  ]);
  expect(sseChunks).toEqual(["data: {}\n\n"]);
  expect(done).toBe(true);
});

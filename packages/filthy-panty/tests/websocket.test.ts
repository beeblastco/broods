import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  delete process.env.FILTHY_PANTY_DASHBOARD_URL;
  delete process.env.FILTHY_PANTY_TOKEN;
  delete process.env.FILTHY_PANTY_PROJECT;
  delete process.env.FILTHY_PANTY_ENVIRONMENT;
  delete process.env.FILTHY_PANTY_BASE_URL;
  delete process.env.FILTHY_PANTY_HOST;
  delete process.env.FILTHY_PANTY_API_KEY;
  delete process.env.FILTHY_PANTY_WEBSOCKET_URL;
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

test("websocket client reads apiKey from package-local .env.local", () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "filthy-panty-websocket-"));
  delete process.env.FILTHY_PANTY_API_KEY;
  writeFileSync(join(tempDir, ".env.local"), "FILTHY_PANTY_API_KEY=local-env-key\n");
  process.chdir(tempDir);

  try {
    const client = new FilthyPantyWebSocketClient({
      host: "app.example",
      WebSocket: FakeWebSocket,
    });

    expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
      "wss://app.example/v1/agents/agent_1/ws?token=local-env-key",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.FILTHY_PANTY_API_KEY;
  }
});

test("websocket client can be constructed without options", () => {
  process.env.FILTHY_PANTY_API_KEY = "env-key";
  const client = new FilthyPantyWebSocketClient();

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://app.beeblast.co/v1/agents/agent_1/ws?token=env-key",
  );
});

test("websocket client lets the gateway URL override an HTTP core host", () => {
  process.env.FILTHY_PANTY_WEBSOCKET_URL = "wss://ws.example";
  const client = new FilthyPantyWebSocketClient({
    host: "neqw2f4jkhicsoyybmb5lckebm0fsrgb.lambda-url.eu-central-1.on.aws",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://ws.example/v1/agents/agent_1/ws?token=test-key",
  );
});

test("websocket client explains Lambda Function URL upgrade failures", async () => {
  class FailingWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      queueMicrotask(() => this.onerror?.({}));
    }
  }
  let error: Error | undefined;
  const client = new FilthyPantyWebSocketClient({
    host: "https://neqw2f4jkhicsoyybmb5lckebm0fsrgb.lambda-url.eu-central-1.on.aws",
    apiKey: "test-key",
    WebSocket: FailingWebSocket,
  });

  client.subscribe({
    endpointId: "agent_1",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }, {
    onError(nextError) {
      error = nextError;
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(error?.message).toContain("AWS Lambda Function URLs do not support WebSocket upgrades");
});

test("websocket client subscribes to the core service and forwards server messages", async () => {
  const messages: WebSocketServerMessage[] = [];
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
    agentId: "agent_1",
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

test("websocket client can build scoped URLs from generated agent references", async () => {
  const client = new FilthyPantyWebSocketClient({
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

  expect(subscription.url).toBe("wss://app.example/v1/demo/agents/development/env_123/ws?token=test-key");

  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: "execute",
    agentId: "agent_123",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
});

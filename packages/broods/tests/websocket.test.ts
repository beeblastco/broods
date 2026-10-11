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
import type { QuestionAnswer } from "../src/websocket-contracts.ts";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
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
  delete process.env.BROODS_STAGE;
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
    "wss://app.example/v1/agents/agent_1/ws",
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
    "wss://app.example/v1/agents/agent_1/ws",
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
      "wss://app.example/v1/agents/agent_1/ws",
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
    "wss://gateway.broods.app/v1/agents/agent_1/ws",
  );
});

test("websocket client lets BROODS_BASE_URL override the default service URL", () => {
  process.env.BROODS_BASE_URL = "https://gateway.example";
  const client = new BroodsWebSocketClient({
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });

  expect(client.buildUrl({ endpointId: "agent_1" })).toBe(
    "wss://gateway.example/v1/agents/agent_1/ws",
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
      stageSlug: "development",
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
      onMessage: function (message) {
        messages.push(message);
      },
      onDone: function () {
        done = true;
      },
    },
  );

  expect(subscription.url).toBe(
    "wss://app.example/v1/projects/demo/stages/development/agents/agent_1/ws",
  );
  // The credential never lands in the URL; it rides the subprotocol list.
  expect(FakeWebSocket.instances[0]?.protocols).toEqual([
    "broods.v1",
    "broods.token.test-key",
  ]);

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

test("websocket client sends answers in place of events", async () => {
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });
  const answers: [QuestionAnswer] = [
    { statusId: "async_tool_1", answers: { deploy_target: ["dev"] } },
  ];

  client.subscribe({
    endpointId: "agent_1",
    sessionId: "session_1",
    answers: answers,
  });

  await Promise.resolve();
  expect(JSON.parse(FakeWebSocket.instances[0]!.sent[0]!)).toEqual({
    type: "execute",
    agentId: "agent_1",
    answers: answers,
    sessionId: "session_1",
  });
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
      onMessage: function (message) {
        messages.push(message);
      },
      onOutput: function (output) {
        outputs.push(output);
      },
      onDone: function () {
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
    input: "change direction",
  });
  const control = JSON.parse(FakeWebSocket.instances[0]!.sent[1]!);
  expect(control).toMatchObject({
    type: "control",
    requestId: "request-2",
  });
  expect(control.mode).toBeUndefined();
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
      stage: "development",
      endpointId: "env_123",
      projectSlug: "demo",
      stageSlug: "development",
    },
    input: "hello",
  });

  expect(subscription.url).toBe(
    "wss://app.example/v1/projects/demo/stages/development/agents/env_123/ws",
  );

  await Promise.resolve();
  const socket = FakeWebSocket.instances[0]!;
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: "execute",
    agentId: "agent_123",
    events: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
});

test("websocket attach honors its AbortSignal and stops delivering callbacks", async () => {
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const frames: string[] = [];
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, listener): Response | undefined =>
      listener.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": "broods.v1" },
        data: undefined,
      })
        ? undefined
        : new Response(null, { status: 400 }),
    websocket: {
      open: (socket): void => {
        sockets.add(socket);
      },
      message: (_socket, raw): void => {
        const frame: { type: string } = JSON.parse(String(raw));
        frames.push(frame.type);
      },
      close: (socket): void => {
        sockets.delete(socket);
      },
    },
  });
  const client = new BroodsWebSocketClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "test-key",
  });
  const input = {
    endpointId: "agent_1",
    agentId: "agent_1",
    requestId: "attach-1",
    runId: "run_1",
    eventId: "event-1",
    conversationKey: "conversation-1",
  };
  const seen: string[] = [];
  const errors: string[] = [];
  const handlers = {
    onMessage: (message: WebSocketServerMessage): void => {
      seen.push(message.type);
    },
    onError: (error: Error): void => {
      errors.push(error.message);
    },
  };
  try {
    const abort = new AbortController();
    client.attach({ ...input, signal: abort.signal }, handlers);
    await until(() => frames.includes("attach"));
    const [socket] = sockets;
    abort.abort();
    await until(() => sockets.size === 0);
    socket?.send(JSON.stringify({ type: "text-delta", id: "0", text: "late" }));
    await Bun.sleep(20);
    expect(seen).toEqual([]);
    expect(errors).toEqual(["WebSocket attach aborted."]);
    // Detaching a viewer is not a request to stop the durable run.
    expect(frames).toEqual(["attach"]);

    client.attach({ ...input, signal: AbortSignal.abort() }, handlers);
    await Bun.sleep(50);
    expect(sockets.size).toBe(0);
    expect(frames).toEqual(["attach"]);
    expect(errors).toEqual([
      "WebSocket attach aborted.",
      "WebSocket attach aborted.",
    ]);
  } finally {
    for (const socket of sockets) socket.close(1000, "test complete");
    await server.stop(true);
  }
});

test("websocket attach delivers nothing after a handler aborts it, and reports a socket failure once", async () => {
  const client = new BroodsWebSocketClient({
    baseUrl: "https://app.example",
    apiKey: "test-key",
    WebSocket: FakeWebSocket,
  });
  const input = {
    endpointId: "agent_1",
    agentId: "agent_1",
    requestId: "attach-1",
    runId: "run_1",
    eventId: "event-1",
    conversationKey: "conversation-1",
  };
  const calls: string[] = [];
  const record = {
    onMessage: (message: WebSocketServerMessage): void => {
      calls.push(`message:${message.type}`);
    },
    onDone: (): void => {
      calls.push("done");
    },
    onError: (error: Error): void => {
      calls.push(`error:${error.message}`);
    },
  };

  const onMessage = new AbortController();
  client.attach(
    { ...input, signal: onMessage.signal },
    { ...record, onMessage: (): void => onMessage.abort() },
  );
  const onOutput = new AbortController();
  client.attach(
    { ...input, signal: onOutput.signal },
    { ...record, onOutput: (): void => onOutput.abort() },
  );
  client.attach(input, record);
  await Promise.resolve();
  const [first, second, third] = FakeWebSocket.instances;
  first!.emit({ type: "error", error: "boom" });
  second!.emit({
    type: "output",
    eventId: "event-1",
    cursor: "ws-responses:generation:1:event-key",
    replay: true,
    data: { type: "done" },
  });
  expect(calls).toEqual([
    "error:WebSocket attach aborted.",
    "error:WebSocket attach aborted.",
  ]);

  calls.length = 0;
  third!.onerror?.({});
  third!.onclose?.({ code: 1006, reason: "abnormal" });
  expect(calls).toEqual([
    "error:Cannot access the WebSocket service at https://app.example.",
  ]);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not occur");
    await Bun.sleep(5);
  }
}

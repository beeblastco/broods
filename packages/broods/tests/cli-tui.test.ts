import { expect, spyOn, test } from "bun:test";
import {
  isToolUIPart,
  readUIMessageStream,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { BroodsClient, type AgentReference } from "../src/client.ts";
import { EventEmitter } from "node:events";
import {
  RemoteAgentTransport,
  stopTurnOnEscape,
  streamAgentText,
  submitPrompt,
} from "../src/cli/tui.ts";

const AGENT: AgentReference = {
  kind: "agent",
  name: "helper",
  id: "agent_1",
  project: "demo",
  stage: "dev",
};

type RunBody = { conversationKey: string; events: ModelMessage[] };

/** Collect the streamed assistant message the TUI would assemble for a turn. */
async function readTurn(
  transport: RemoteAgentTransport,
  messages: UIMessage[],
): Promise<UIMessage | undefined> {
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: "chat_1",
    messageId: undefined,
    messages: messages,
    abortSignal: undefined,
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: stream })) {
    last = message;
  }

  return last;
}

function sse(...parts: unknown[]): Response {
  return new Response(
    `${parts.map((part) => `data: ${JSON.stringify(part)}`).join("\n\n")}\n\n`,
  );
}

function testTransport(responses: Response[]): {
  transport: RemoteAgentTransport;
  bodies: RunBody[];
} {
  const bodies: RunBody[] = [];
  const client = new BroodsClient({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "") as RunBody,
      );

      return responses[bodies.length - 1] ?? sse();
    },
  });

  return { transport: new RemoteAgentTransport(client, AGENT), bodies: bodies };
}

function userMessage(id: string, text: string): UIMessage {
  return {
    id: id,
    role: "user",
    parts: [{ type: "text", text: text }],
  };
}

test("transport streams a user turn and converts core parts to UI chunks", async () => {
  const { transport, bodies } = testTransport([
    sse(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "hi" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop" },
    ),
  ]);

  const message = await readTurn(transport, [userMessage("m1", "hello")]);

  expect(bodies[0]?.events).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  expect(message?.parts).toContainEqual({
    type: "text",
    text: "hi",
    state: "done",
  });
});

test("transport forwards only the approval response on an approval round-trip", async () => {
  const { transport, bodies } = testTransport([
    sse(
      {
        type: "tool-input-start",
        id: "call_1",
        toolName: "bash",
      },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: { command: "ls" },
      },
      {
        type: "tool-approval-request",
        approvalId: "approval_1",
        toolCall: {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "ls" },
        },
      },
      { type: "finish", finishReason: "tool-approvals" },
    ),
    sse(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "done" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop" },
    ),
  ]);

  const messages: UIMessage[] = [userMessage("m1", "list files")];
  const assistant = await readTurn(transport, messages);
  const pending = assistant?.parts.find(
    (part) => isToolUIPart(part) && part.state === "approval-requested",
  );
  expect(pending).toBeDefined();

  // What the TUI does after the user presses "y".
  if (pending && isToolUIPart(pending)) {
    pending.state = "approval-responded";
    pending.approval = { id: "approval_1", approved: true };
  }
  messages.push(assistant as UIMessage);
  await readTurn(transport, messages);

  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.events).toEqual([
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval_1",
          approved: true,
          reason: undefined,
          providerExecuted: undefined,
        },
      ],
    },
  ]);
  // Core owns the conversation, so every turn resumes the same one.
  expect(bodies[1]?.conversationKey).toBe(bodies[0]?.conversationKey as string);
});

test("transport re-sends only the newest approval when one turn asks twice", async () => {
  const { transport, bodies } = testTransport([
    sse({ type: "finish", finishReason: "stop" }),
    sse({ type: "finish", finishReason: "stop" }),
    sse({ type: "finish", finishReason: "stop" }),
  ]);
  const assistant: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-bash",
        toolCallId: "call_1",
        state: "approval-responded",
        input: { command: "ls" },
        approval: { id: "approval_1", approved: true },
      },
    ],
  };
  const messages: UIMessage[] = [userMessage("m1", "list files"), assistant];

  await readTurn(transport, messages);
  // Core approves the first call, then stops on a second one in the same turn.
  assistant.parts.push({
    type: "tool-bash",
    toolCallId: "call_2",
    state: "approval-responded",
    input: { command: "rm -rf ." },
    approval: { id: "approval_2", approved: false, reason: "Denied by user." },
  });
  await readTurn(transport, messages);

  expect(bodies[1]?.events).toEqual([
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval_2",
          approved: false,
          reason: "Denied by user.",
          providerExecuted: undefined,
        },
      ],
    },
  ]);
});

test("transport sends each new user turn once", async () => {
  const { transport, bodies } = testTransport([
    sse(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "ok" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop" },
    ),
    sse({ type: "finish", finishReason: "stop" }),
  ]);

  const messages: UIMessage[] = [userMessage("m1", "first")];
  messages.push((await readTurn(transport, messages)) as UIMessage);
  messages.push(userMessage("m2", "second"));
  await readTurn(transport, messages);

  expect(bodies[1]?.events).toEqual([
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]);
});

test("redirected output streams plain text without terminal escapes", async () => {
  const client = new BroodsClient({
    apiKey: "test-key",
    fetch: async () =>
      sse(
        { type: "reasoning-start", id: "r0" },
        { type: "reasoning-delta", id: "r0", text: "thinking hard" },
        { type: "reasoning-end", id: "r0" },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", text: "Paris" },
        { type: "text-delta", id: "t0", text: " is the capital." },
        { type: "text-end", id: "t0" },
        { type: "finish", finishReason: "stop" },
      ),
  });
  const written: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(function (
    chunk: string | Uint8Array,
  ): boolean {
    written.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );

    return true;
  });

  try {
    await streamAgentText({ client: client, agent: AGENT, prompt: "capital?" });
  } finally {
    write.mockRestore();
  }

  expect(written.join("")).toBe("Paris is the capital.\n");
});

test("a CLI prompt is typed into the terminal UI once it listens", async () => {
  const chunks: string[] = [];
  const submitted = submitPrompt("hello there");

  // The terminal UI attaches its listener a tick after the run starts.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const listener = (chunk: Buffer) => chunks.push(chunk.toString("utf8"));
  process.stdin.on("data", listener);

  await submitted;
  process.stdin.off("data", listener);

  expect(chunks).toEqual(["hello there", "\r"]);
});

test("a failed run is re-sent, not silently dropped from the conversation", async () => {
  const bodies: RunBody[] = [];
  const client = new BroodsClient({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "") as RunBody,
      );
      if (bodies.length === 1) return new Response("nope", { status: 503 });

      return sse({ type: "finish", finishReason: "stop" });
    },
  });
  const transport = new RemoteAgentTransport(client, AGENT);
  const messages = [userMessage("m1", "hello")];

  // The SDK turns a failed run into an error part rather than rejecting.
  await readTurn(transport, messages);
  await readTurn(transport, messages);

  // Core never saw the first attempt, so the same turn has to go out again.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.events).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("aborting stops a turn that is waiting on the model", async () => {
  const controller = new AbortController();
  const client = new BroodsClient({
    apiKey: "test-key",
    // A run that streams one part and then never produces another.
    fetch: async () =>
      new Response(
        new ReadableStream({
          start: function (sse) {
            sse.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "text-start", id: "0" })}\n\n`,
              ),
            );
          },
        }),
      ),
  });
  const stream = await new RemoteAgentTransport(client, AGENT).sendMessages({
    trigger: "submit-message",
    chatId: "chat_1",
    messageId: undefined,
    messages: [userMessage("m1", "hello")],
    abortSignal: controller.signal,
  });

  const reader = stream.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort();

  // Without racing the signal this would hang until the server sent more.
  expect((await pending).done).toBe(true);
});

/** An SSE body that sends `parts` and then stays open, like a long reply. */
function openSse(...parts: unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start: function (controller): void {
        for (const part of parts)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
          );
      },
    }),
  );
}

test("stopTurn ends a streaming reply and keeps the text so far", async () => {
  const { transport } = testTransport([
    openSse(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "Once upon" },
    ),
  ]);
  expect(transport.stopTurn()).toBe(false);

  const turn = readTurn(transport, [userMessage("m1", "tell a story")]);
  await Bun.sleep(50);
  expect(transport.stopTurn()).toBe(true);
  const message = await turn;

  expect(message?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "Once upon" }),
  );
  expect(transport.stopTurn()).toBe(false);
});

test("Esc stops a streaming turn; keys, split keys, Ctrl+C and idle Esc reach the UI", async () => {
  const input = new EventEmitter();
  const seen: string[] = [];
  input.on("data", (chunk: Buffer) => seen.push(String(chunk)));
  let streaming = true;
  let stops = 0;
  const transport = {
    get streaming(): boolean {
      return streaming;
    },
    stopTurn: (): boolean => {
      stops += 1;
      const was = streaming;
      streaming = false;

      return was;
    },
  };
  const send = (text: string): boolean => input.emit("data", Buffer.from(text));

  const restore = stopTurnOnEscape(transport, input);
  send("\x1b[A");
  // An arrow split across two reads is still an arrow, not a stop.
  send("\x1b");
  send("[B");
  expect(stops).toBe(0);
  // Pressed mid-turn: stops it, and never quits, even if the turn already ended.
  send("\x1b");
  streaming = false;
  await Bun.sleep(60);
  expect(stops).toBe(1);
  // A double Esc or Esc then Ctrl+C: the Esc settles at once, the next key passes.
  streaming = true;
  send("\x1b");
  send("\x03");
  expect(stops).toBe(2);
  // Idle, Esc reaches the UI (which quits) once no sequence follows.
  send("\x1b");
  await Bun.sleep(60);
  restore();
  send("x");

  expect(seen).toEqual(["\x1b[A", "\x1b[B", "\x03", "\x1b", "x"]);
});

test("Esc before the first part counts the turn as sent", async () => {
  const { transport, bodies } = testTransport([
    openSse(),
    sse(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "ok" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop" },
    ),
  ]);

  const first = readTurn(transport, [userMessage("m1", "first")]);
  await Bun.sleep(50);
  expect(transport.stopTurn()).toBe(true);
  await first;
  await readTurn(transport, [
    userMessage("m1", "first"),
    userMessage("m2", "second"),
  ]);

  // Core already has "first": the next turn sends only the new message.
  expect(bodies[1]?.events).toEqual([
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]);
});

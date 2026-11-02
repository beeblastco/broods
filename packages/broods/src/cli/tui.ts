import type { EventEmitter } from "node:events";
import { runAgentTUI } from "@ai-sdk/tui";
import {
  convertToModelMessages,
  generateId,
  toTextStream,
  toUIMessageStream,
  type ChatTransport,
  type ModelMessage,
  type TextStreamPart,
  type ToolApprovalResponse,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  IngressAcceptedError,
  type AgentReference,
  type BroodsClient,
} from "../client.ts";

type SendMessagesOptions = Parameters<
  ChatTransport<UIMessage>["sendMessages"]
>[0];

export interface AgentRunOptions {
  client: BroodsClient;
  agent: AgentReference;
  prompt?: string;
}

export async function runAgentTui(options: AgentRunOptions): Promise<void> {
  const transport = new RemoteAgentTransport(options.client, options.agent);
  const restoreInput = stopTurnOnEscape(transport);
  if (options.prompt !== undefined) void submitPrompt(options.prompt);
  try {
    await runAgentTUI({
      title: `broods · ${options.agent.name}`,
      // The default collapses tool cards, whose input and output a dev came here to see.
      tools: "full",
      transport: transport,
    });
  } finally {
    restoreInput();
  }
}

// How long a lone Esc waits for the rest of a key sequence split across reads.
const ESC_SEQUENCE_WAIT_MS = 30;

const ESC = Buffer.from("\x1b");

// Esc mid-turn stops the turn instead of quitting; idle Esc and Ctrl+C still quit. A lone Esc is
// held briefly, since a following `[` or `O` makes it part of a split arrow key. Returns the undo.
export function stopTurnOnEscape(
  transport: Pick<RemoteAgentTransport, "stopTurn" | "streaming">,
  input: EventEmitter = process.stdin,
): () => void {
  const emit = input.emit.bind(input);
  let held:
    | { timer: ReturnType<typeof setTimeout>; streaming: boolean }
    | undefined;
  const settle = (): void => {
    if (!held) return;
    clearTimeout(held.timer);
    const pressedMidTurn = held.streaming;
    held = undefined;
    if (pressedMidTurn) transport.stopTurn();
    else emit("data", ESC);
  };
  input.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== "data") return emit(event, ...args);
    const chunk = Buffer.isBuffer(args[0])
      ? args[0]
      : Buffer.from(String(args[0]));
    if (held && (chunk[0] === 0x5b || chunk[0] === 0x4f)) {
      clearTimeout(held.timer);
      held = undefined;

      return emit("data", Buffer.concat([ESC, chunk]));
    }
    // Anything else (a second Esc, Ctrl+C) confirms the held Esc first.
    settle();
    if (chunk.equals(ESC)) {
      held = {
        timer: setTimeout(settle, ESC_SEQUENCE_WAIT_MS),
        streaming: transport.streaming,
      };

      return true;
    }

    return emit(event, ...args);
  };

  return () => {
    if (held) clearTimeout(held.timer);
    input.emit = emit;
  };
}

export async function streamAgentText(
  options: AgentRunOptions & { prompt: string },
): Promise<void> {
  const stream = toTextStream({
    stream: toReadableStream(
      options.client.stream(options.agent, { input: options.prompt }),
      undefined,
      () => {},
    ),
  });
  for await (const text of stream) {
    process.stdout.write(text);
  }
  process.stdout.write("\n");
}

// `runAgentTUI` takes no initial prompt, so type it into stdin once the TUI listens there.
export async function submitPrompt(prompt: string): Promise<void> {
  const listeners = process.stdin.listenerCount("data");
  const deadline = Date.now() + 10_000;
  while (process.stdin.listenerCount("data") <= listeners) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.stdin.emit("data", Buffer.from(prompt));
  process.stdin.emit("data", Buffer.from("\r"));
}

// Core owns the conversation, so a turn forwards only what core has not seen yet: new user
// messages and tool-approval responses, the two inputs it treats as runnable.
export class RemoteAgentTransport implements ChatTransport<UIMessage> {
  private readonly conversationKey = `tui-${generateId()}`;
  private readonly sentApprovals = new Set<string>();
  private sentUserTurns = 0;
  /** The streaming turn, which `stopTurn` ends, and how to record it sent. */
  private activeTurn:
    | { controller: AbortController; commit: () => void }
    | undefined;

  constructor(
    private readonly client: BroodsClient,
    private readonly agent: AgentReference,
  ) {}

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  async sendMessages(
    options: SendMessagesOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const pending = this.pendingEvents(
      await convertToModelMessages(options.messages),
    );
    if (pending.events.length === 0) {
      throw new Error("Nothing new to send: the agent already saw this turn.");
    }

    const turn = { controller: new AbortController(), commit: pending.commit };
    const stream = queuedAnswer(
      this.client,
      this.client.stream(this.agent, {
        conversationKey: this.conversationKey,
        events: pending.events as [ModelMessage, ...ModelMessage[]],
      }),
      turn.controller.signal,
    );
    this.activeTurn = turn;
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, turn.controller.signal])
      : turn.controller.signal;

    return toUIMessageStream({
      stream: toReadableStream(stream, signal, pending.commit, () => {
        if (this.activeTurn === turn) this.activeTurn = undefined;
      }),
      originalMessages: options.messages,
      generateMessageId: generateId,
      sendSources: true,
    });
  }

  get streaming(): boolean {
    return this.activeTurn !== undefined;
  }

  // Ends the turn on screen, keeping its text. Core still finishes the run (the runtime key has no
  // cancel), so the turn counts as sent. False when no turn is streaming.
  stopTurn(): boolean {
    if (!this.activeTurn) return false;
    this.activeTurn.commit();
    this.activeTurn.controller.abort();
    this.activeTurn = undefined;

    return true;
  }

  // Records nothing: `commit` runs once core answers, so a turn that never reached it is re-sent.
  private pendingEvents(messages: ModelMessage[]): {
    events: ModelMessage[];
    commit: () => void;
  } {
    const events: ModelMessage[] = [];
    const approvals: ToolApprovalResponse[] = [];
    let userTurns = 0;

    for (const message of messages) {
      if (message.role === "user") {
        userTurns += 1;
        if (userTurns > this.sentUserTurns) events.push(message);
        continue;
      }
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (
          part.type === "tool-approval-response" &&
          !this.sentApprovals.has(part.approvalId)
        ) {
          approvals.push(part);
        }
      }
    }
    // Core resumes on a tool message whose parts are all approval responses;
    // the denial `tool-result` the SDK synthesizes is core's job, not ours.
    if (approvals.length > 0) events.push({ role: "tool", content: approvals });

    return {
      events: events,
      commit: () => {
        this.sentUserTurns = userTurns;
        for (const approval of approvals)
          this.sentApprovals.add(approval.approvalId);
      },
    };
  }
}

// A turn sent while core still runs a stopped one is queued (202): wait and stream its answer.
async function* queuedAnswer(
  client: BroodsClient,
  stream: AsyncGenerator<TextStreamPart<ToolSet>>,
  signal: AbortSignal,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  try {
    yield* stream;
  } catch (error) {
    if (!(error instanceof IngressAcceptedError)) throw error;
    const status = await client.waitForAsyncStatus(error.accepted, {
      signal: signal,
    });
    const answer = [status.response, status.result].find(
      (value): value is string => typeof value === "string",
    );
    if (status.status !== "completed" || answer === undefined) {
      throw new Error(`The queued turn ended ${status.status}.`);
    }
    yield { type: "text-start", id: "queued" };
    yield { type: "text-delta", id: "queued", text: answer };
    yield { type: "text-end", id: "queued" };
  }
}

function abortedRead(
  signal: AbortSignal | undefined,
): Promise<IteratorResult<TextStreamPart<ToolSet>>> {
  return new Promise((resolve) => {
    if (!signal) return;
    const done = () => resolve({ done: true, value: undefined });
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

function toReadableStream(
  stream: AsyncGenerator<TextStreamPart<ToolSet>>,
  signal: AbortSignal | undefined,
  onAnswered: () => void,
  onClosed: () => void = () => {},
): ReadableStream<TextStreamPart<ToolSet>> {
  let answered = false;
  // Never awaited: `return()` queues behind a read that may never complete, so awaiting it
  // would hang the abort itself.
  const release = () => void stream.return(undefined);

  return new ReadableStream({
    pull: async function (controller): Promise<void> {
      const next = await Promise.race([
        stream.next(),
        abortedRead(signal),
      ]).catch((error: unknown) => {
        onClosed();
        throw error;
      });
      if (signal?.aborted) {
        release();
        controller.close();
        onClosed();

        return;
      }
      if (!answered) {
        answered = true;
        onAnswered();
      }
      if (next.done) {
        controller.close();
        onClosed();
      } else controller.enqueue(next.value);
    },
    cancel: () => {
      release();
      onClosed();
    },
  });
}

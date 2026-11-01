/**
 * Presentation for `broods run`. Terminals get the AI SDK terminal UI; pipes get
 * plain text. The agent stays deployed either way: a `ChatTransport` turns every
 * turn into a direct-API SSE run and the SDK maps core's stream parts for us.
 */

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
import type { AgentReference, BroodsClient } from "../client.ts";

type SendMessagesOptions = Parameters<
  ChatTransport<UIMessage>["sendMessages"]
>[0];

export interface AgentRunOptions {
  client: BroodsClient;
  agent: AgentReference;
  /** Sent as the first turn. The TUI stays open afterwards for follow-ups. */
  prompt?: string;
}

/** Run a deployed agent in the AI SDK terminal UI until the user exits. */
export async function runAgentTui(options: AgentRunOptions): Promise<void> {
  const transport = new RemoteAgentTransport(options.client, options.agent);
  const restoreKeys = stopTurnOnEscape(transport);
  if (options.prompt !== undefined) void submitPrompt(options.prompt);
  try {
    await runAgentTUI({
      title: `broods · ${options.agent.name}`,
      // Tool cards stay expanded: their input and output are what a dev testing
      // an agent came to see, and the default collapses them once text arrives.
      tools: "full",
      transport: transport,
    });
  } finally {
    restoreKeys();
  }
}

/**
 * The terminal UI quits on Esc, even mid-reply, which drops the conversation.
 * A lone Esc while a turn streams stops that turn instead; Ctrl+C still quits.
 * Arrow and page keys arrive as one `\x1b[...` chunk, so they pass untouched.
 * Returns the undo.
 */
export function stopTurnOnEscape(
  transport: RemoteAgentTransport,
  input: NodeJS.ReadStream = process.stdin,
): () => void {
  const emit = input.emit.bind(input);
  input.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (
      event === "data" &&
      String(args[0]) === "\x1b" &&
      transport.stopTurn()
    ) {
      return true;
    }

    return emit(event, ...args);
  }) as typeof input.emit;

  return () => {
    input.emit = emit;
  };
}

/** Stream a single run as plain text, for redirected or piped output. */
export async function streamAgentText(
  options: AgentRunOptions & { prompt: string },
): Promise<void> {
  const stream = toTextStream({
    stream: toReadableStream(
      options.client.stream(options.agent, { input: options.prompt }),
      undefined,
      // One-shot: there is no follow-up turn to keep bookkeeping for.
      () => {},
    ),
  });
  for await (const text of stream) {
    process.stdout.write(text);
  }
  process.stdout.write("\n");
}

/**
 * `runAgentTUI` takes no initial prompt, so type the CLI's prompt into the
 * listener the terminal UI attaches to stdin once it is ready for input.
 */
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

/**
 * Bridges the TUI's chat protocol to a deployed agent. Core owns the
 * conversation, so a turn only forwards what core has not seen yet: new user
 * messages and tool-approval responses, the two inputs it treats as runnable.
 */
export class RemoteAgentTransport implements ChatTransport<UIMessage> {
  private readonly conversationKey = `tui-${generateId()}`;
  private readonly sentApprovals = new Set<string>();
  private sentUserTurns = 0;
  /** The streaming turn, which `stopTurn` ends. */
  private activeTurn: AbortController | undefined;

  constructor(
    private readonly client: BroodsClient,
    private readonly agent: AgentReference,
  ) {}

  // The TUI never resumes a dropped stream; each turn opens its own SSE run.
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

    const stream = this.client.stream(this.agent, {
      conversationKey: this.conversationKey,
      events: pending.events as [ModelMessage, ...ModelMessage[]],
    });
    const turn = new AbortController();
    this.activeTurn = turn;
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, turn.signal])
      : turn.signal;

    return toUIMessageStream({
      stream: toReadableStream(stream, signal, pending.commit, () => {
        if (this.activeTurn === turn) this.activeTurn = undefined;
      }),
      originalMessages: options.messages,
      generateMessageId: generateId,
      sendSources: true,
    });
  }

  /**
   * End the streaming turn where it is: the text so far stays on screen and the
   * input comes back. False when no turn is streaming.
   */
  stopTurn(): boolean {
    if (!this.activeTurn) return false;
    this.activeTurn.abort();
    this.activeTurn = undefined;

    return true;
  }

  /**
   * Diff the converted history against what core already has, without recording
   * anything: `commit` runs only once core answers, so a run that never reached
   * it is re-sent on the next turn instead of being silently dropped.
   */
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

/** Resolves as an exhausted read when the signal aborts; never otherwise. */
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

/**
 * Adapt the client's async generator to the `ReadableStream` the SDK expects.
 * Aborting races the in-flight read so a stalled turn stops immediately instead
 * of waiting for the model's next event, and `onAnswered` fires once core has
 * replied, which is the point the turn counts as delivered.
 */
function toReadableStream(
  stream: AsyncGenerator<TextStreamPart<ToolSet>>,
  signal: AbortSignal | undefined,
  onAnswered: () => void,
  onClosed: () => void = () => {},
): ReadableStream<TextStreamPart<ToolSet>> {
  let answered = false;
  // Never awaited: the generator can be parked on a read that never completes,
  // and `return()` queues behind it, so awaiting would hang the abort itself.
  const release = () => void stream.return(undefined);

  return new ReadableStream({
    pull: async function (controller): Promise<void> {
      const next = await Promise.race([stream.next(), abortedRead(signal)]);
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

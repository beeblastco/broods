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
  prompt?: string;
}

export async function runAgentTui(options: AgentRunOptions): Promise<void> {
  if (options.prompt !== undefined) void submitPrompt(options.prompt);
  await runAgentTUI({
    title: `broods · ${options.agent.name}`,
    // The default collapses tool cards, whose input and output a dev came here to see.
    tools: "full",
    transport: new RemoteAgentTransport(options.client, options.agent),
  });
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

    const stream = this.client.stream(this.agent, {
      conversationKey: this.conversationKey,
      events: pending.events as [ModelMessage, ...ModelMessage[]],
    });

    return toUIMessageStream({
      stream: toReadableStream(stream, options.abortSignal, pending.commit),
      originalMessages: options.messages,
      generateMessageId: generateId,
      sendSources: true,
    });
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
): ReadableStream<TextStreamPart<ToolSet>> {
  let answered = false;
  // Never awaited: `return()` queues behind a read that may never complete, so awaiting it
  // would hang the abort itself.
  const release = () => void stream.return(undefined);

  return new ReadableStream({
    pull: async function (controller): Promise<void> {
      const next = await Promise.race([stream.next(), abortedRead(signal)]);
      if (signal?.aborted) {
        release();
        controller.close();

        return;
      }
      if (!answered) {
        answered = true;
        onAnswered();
      }
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: release,
  });
}

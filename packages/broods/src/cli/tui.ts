/**
 * Interactive terminal UI for `broods run`, backed by `@ai-sdk/tui`.
 * The agent stays deployed: a `ChatTransport` turns every TUI turn into a
 * direct-API SSE run and maps core's stream parts back into UI message chunks.
 */

import { runAgentTUI } from "@ai-sdk/tui";
import {
  convertToModelMessages,
  generateId,
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

export interface AgentTuiOptions {
  client: BroodsClient;
  agent: AgentReference;
}

/** Run a deployed agent in the AI SDK terminal UI until the user exits. */
export async function runAgentTui(options: AgentTuiOptions): Promise<void> {
  await runAgentTUI({
    title: `broods · ${options.agent.name}`,
    transport: new RemoteAgentTransport(options.client, options.agent),
  });
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
    const events = this.pendingEvents(
      await convertToModelMessages(options.messages),
    );
    if (events.length === 0) {
      throw new Error("Nothing new to send: the agent already saw this turn.");
    }

    const stream = this.client.stream(this.agent, {
      conversationKey: this.conversationKey,
      events: events as [ModelMessage, ...ModelMessage[]],
    });

    return toUIMessageStream({
      stream: toReadableStream(stream, options.abortSignal),
      originalMessages: options.messages,
      generateMessageId: generateId,
    });
  }

  /**
   * Diff the converted history against what core already has. Approvals are
   * tracked by id because one assistant turn can collect several rounds of them.
   */
  private pendingEvents(messages: ModelMessage[]): ModelMessage[] {
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
          this.sentApprovals.add(part.approvalId);
          approvals.push(part);
        }
      }
    }
    this.sentUserTurns = userTurns;
    // Core resumes on a tool message whose parts are all approval responses;
    // the denial `tool-result` the SDK synthesizes is core's job, not ours.
    if (approvals.length > 0) events.push({ role: "tool", content: approvals });

    return events;
  }
}

/** Adapt the client's async generator to the `ReadableStream` the SDK expects. */
function toReadableStream(
  stream: AsyncGenerator<TextStreamPart<ToolSet>>,
  signal: AbortSignal | undefined,
): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        await stream.return(undefined);
        controller.close();

        return;
      }
      const next = await stream.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await stream.return(undefined);
    },
  });
}

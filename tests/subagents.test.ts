/**
 * Subagent coordinator tests.
 * Cover parent-result batching without running provider models.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { UserModelMessage } from "ai";

beforeEach(() => {
  process.env.CONVERSATIONS_TABLE_NAME = "conversations";
  process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
  process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-result";
});

interface TestCompletion {
  taskId: string;
  agentId: string;
  name: string;
  conversationKey: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

interface CoordinatorInternals {
  completions: TestCompletion[];
  pending: Map<string, Promise<void>>;
  pendingMetadata: Map<string, Omit<TestCompletion, "status" | "response" | "error">>;
  notifyCompletion(): void;
}

describe("SubagentCoordinator", () => {
  it("waits for all pending subagents before draining parent messages", async () => {
    const { SubagentCoordinator } = await import("../functions/harness-processing/subagents.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    const coordinator = new SubagentCoordinator({
      accountId: "account_1",
      agentId: "agent_parent",
      eventId: "event_parent",
      persistModelMessages,
    } as never, {}, Date.now() + 1_000);
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.pending.set("subagent_1", new Promise(() => { }));
    internals.pending.set("subagent_2", new Promise(() => { }));
    setTimeout(() => {
      internals.completions.push(completion("subagent_1", "first result"));
      internals.pending.delete("subagent_1");
      internals.notifyCompletion();
    }, 5);
    setTimeout(() => {
      internals.completions.push(completion("subagent_2", "second result"));
      internals.pending.delete("subagent_2");
      internals.notifyCompletion();
    }, 15);

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(coordinator.pendingCount).toBe(0);

    await expect(coordinator.drainCompletionsToParent()).resolves.toBe(2);
    expect(persistModelMessages).toHaveBeenCalledTimes(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0])).toContain("first result");
    expect(messageText(messages[1])).toContain("second result");
  });

  it("emits heartbeats while waiting and batches completed results with timeout notices", async () => {
    const { SubagentCoordinator } = await import("../functions/harness-processing/subagents.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    const onHeartbeat = mock((_pendingCount: number) => { });
    const coordinator = new SubagentCoordinator({
      accountId: "account_1",
      agentId: "agent_parent",
      eventId: "event_parent",
      persistModelMessages,
    } as never, {}, Date.now() + 10);
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.completions.push(completion("subagent_1", "finished before timeout"));
    internals.pending.set("subagent_2", new Promise(() => { }));
    internals.pendingMetadata.set("subagent_2", {
      taskId: "subagent_2",
      agentId: "agent_research",
      name: "Research assistant",
      conversationKey: "subagent-subagent_2",
    });

    await expect(coordinator.waitForIdle({ onHeartbeat })).resolves.toBe("timeout");
    expect(onHeartbeat).toHaveBeenCalledWith(1);

    await expect(coordinator.drainCompletionsAndTimeoutsToParent()).resolves.toBe(2);
    expect(persistModelMessages).toHaveBeenCalledTimes(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0])).toContain("finished before timeout");
    expect(messageText(messages[1])).toContain("Subagent task is still pending near the parent request timeout.");
    expect(messageText(messages[1])).toContain("agentId: agent_research");
    expect(messageText(messages[1])).toContain("agentName: Research assistant");
    expect(messageText(messages[1])).toContain("conversationKey: subagent-subagent_2");
  });

  it("stringifies structured subagent results for parent injection", async () => {
    const { SubagentCoordinator } = await import("../functions/harness-processing/subagents.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    const coordinator = new SubagentCoordinator({
      accountId: "account_1",
      agentId: "agent_parent",
      eventId: "event_parent",
      persistModelMessages,
    } as never, {}, Date.now() + 1_000);
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.completions.push(completion("subagent_1", { answer: "done" }));

    await expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain('{"answer":"done"}');
  });
});

function completion(taskId: string, response: unknown): TestCompletion {
  return {
    taskId,
    agentId: `agent_${taskId}`,
    name: `Subagent ${taskId}`,
    conversationKey: `conversation_${taskId}`,
    status: "completed",
    response,
  };
}

function messageText(message: UserModelMessage | undefined): string {
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  const part = content[0];
  return part?.type === "text" ? part.text : "";
}

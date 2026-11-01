import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ai from "ai";
import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import * as asyncAgentResults from "../src/harness/async-agent-result.ts";
import type { SweptHandback } from "@broods/convex/model/subagentResults";
import type { AsyncAgentResultRecord } from "../src/harness/async-agent-result.ts";
import * as hookDispatcher from "../src/harness/hook-dispatcher.ts";
import type { ReentryTarget } from "../src/harness/integrations.ts";
import type { SubagentResumeOutcome } from "../src/harness/subagents.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import * as log from "../src/shared/log.ts";
import type { NatsPublisher } from "../src/shared/nats.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../src/shared/runtime-keys.ts";
import { setStorageForTests } from "../src/shared/storage.ts";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
  // Persistent child keys are tagged with a key derived from it.
  process.env.STAGE_TICKET_SECRET = "stage-secret";
});

interface TestCompletion {
  taskId: string;
  eventId: string;
  agentId: string;
  conversationKey: string;
  status: "completed" | "failed" | "awaiting_input";
  response?: unknown;
  error?: string;
  question?: string;
  visibleResult?: unknown;
}

// The two streamText callbacks the ephemeral test drives.
interface StreamTextStandInOptions {
  prepareStep(args: {
    messages: ModelMessage[];
    responseMessages: ModelMessage[];
  }): Promise<unknown>;
  onEnd(args: {
    response: { messages: ModelMessage[] };
    responseMessages: ModelMessage[];
    text: string;
    finishReason: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    steps: unknown[];
    toolCalls: unknown[];
  }): Promise<void>;
}

interface CoordinatorInternals {
  completions: TestCompletion[];
  pending: Map<string, Promise<void>>;
  recorded: Set<string>;
  pendingMetadata: Map<
    string,
    Omit<TestCompletion, "status" | "response" | "error">
  >;
  completeTask: (completion: TestCompletion) => Promise<void>;
  completeSuccessfulRun: (
    childSession: unknown,
    task: unknown,
    finalResponse: unknown,
  ) => Promise<void>;
  completeAskedRun: (
    childSession: unknown,
    task: unknown,
    message: {
      text: string;
      exchangeId: string;
      followUp: boolean;
      waitSeconds?: number;
    },
  ) => Promise<void>;
  createChildTurnContext(
    childSession: unknown,
    task: unknown,
    incoming: ModelMessage[],
  ): Promise<unknown>;
  notifyCompletion(): void;
  runTask(
    task: unknown,
    parentContext?: unknown,
    publisher?: NatsPublisher,
  ): Promise<void>;
  resolveTask(
    task: { prompt: string; conversationKey?: string },
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[],
  ): Promise<{
    taskId: string;
    eventId: string;
    agentId: string;
    agentConfig: AgentConfig;
    publicConversationKey: string;
    conversationKey: string;
    persistent: boolean;
    resuming: boolean;
  }>;
  startTask(task: unknown, parentContext?: unknown): void;
  admitChildConversation(
    task: unknown,
    promptMessage: UserModelMessage,
  ): Promise<number>;
  drainChildConversation(childSession: unknown, task: unknown): Promise<void>;
}

describe("SubagentCoordinator", () => {
  it("persists attach identities before returning the early dispatch result", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const timeline: string[] = [];
    runtime.mutate = mock(async (name: string) => {
      timeline.push(`persist:${name}`);

      return true;
    }) as never;
    const lifecycle = {
      emit: mock(async (event: string) => {
        timeline.push(`lifecycle:${event}`);
      }),
    };
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true } },
      Date.now() + 1_000,
      { lifecycle: lifecycle as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async () => {
      timeline.push("run:child");
    });

    try {
      const result = await coordinator.dispatch([{ prompt: "research" }], []);
      const task = result.tasks[0];
      if (!task) {
        throw new Error("Expected one subagent dispatch");
      }

      expect(task.taskId.startsWith("subagent~")).toBe(true);
      // A persistent virtual child is named by its key, not its task.
      const keyUuid = /^subagent-persistent-([0-9a-f-]{36})-/.exec(
        task.conversationKey,
      )?.[1];
      expect(task.agentId).toBe(`virtual_subagent_${keyUuid}`);
      // The dispatch hands the parent a run id, not the task's own event id.
      expect(task.statusPath).toMatch(/^\/v1\/runs\/run_[0-9a-f]{32}$/);
      expect(timeline.slice(0, 3)).toEqual([
        "persist:createAsyncAgentResult",
        "lifecycle:subagent.task.started",
        "run:child",
      ]);
      expect(coordinator.waitForIdle()).resolves.toBe("idle");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("pipes reasoning, text, tool, and structured output parts unchanged", async () => {
    const { pipeSubagentNatsStream } =
      await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const parts = [
      { type: "reasoning-delta", text: "thinking" },
      { type: "text-delta", text: "answer" },
      { type: "tool-call", toolName: "search" },
    ];
    const stream = {
      stream: new ReadableStream({
        start: function (controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
      ensureFinalized: async () => {},
      finalResponse: () => ({ answer: 42 }),
      hasStructuredOutput: () => true,
    };

    await pipeSubagentNatsStream(stream as never, publisher);

    expect(publisher.events).toEqual([
      ...parts,
      { type: "structured-output", output: { answer: 42 } },
    ]);
  });

  it("does not create a stream publisher by default", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const publisherFactory = mock(() => publisher);
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true } },
      Date.now() + 1_000,
      { publisherFactory: publisherFactory as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async () => {});

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(publisherFactory).not.toHaveBeenCalled();
    expect(publisher.timeline).toEqual([]);
  });

  it("keeps a child's observability scope when the parent's pass clears its own", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const otel = await import("../src/shared/otel.ts");
    const scope = {
      accountId: "account_1",
      project: "demo",
      stage: "development",
      endpointId: "endpoint_1",
      agentId: "agent_parent",
      conversationKey: "tg:42",
      traceId: "trace_parent",
      otelContext: {} as never,
      secretValues: [],
    };
    let parentCleared!: () => void;
    const cleared = new Promise<void>((resolve) => {
      parentCleared = resolve;
    });
    const seen: (string | undefined)[] = [];

    await otel.runWithObservabilityScope(async () => {
      const coordinator = new SubagentCoordinator(
        parentSession(),
        { subagent: { enabled: true } },
        Date.now() + 1_000,
      );
      const internals = coordinator as unknown as CoordinatorInternals;
      internals.runTask = mock(async () => {
        otel.setObservabilityContext({ ...scope, traceId: "trace_child" });
        await cleared;
        seen.push(otel.getObservabilityContext()?.traceId);
      });

      internals.startTask(resolvedTask());
      expect(otel.getObservabilityContext()?.traceId).toBe("trace_parent");
      otel.setObservabilityContext(null);
      parentCleared();
      await coordinator.waitForIdle();
    }, scope);

    expect(seen).toEqual(["trace_child"]);
  });

  it("publishes enabled child parts, terminal marker, and flushes after settlement", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, stream: true } },
      Date.now() + 1_000,
      { publisherFactory: (() => publisher) as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async (_task, _parentContext, streamPublisher) => {
      await streamPublisher?.publish({
        type: "reasoning-delta",
        text: "thinking",
      });
      await streamPublisher?.publish({ type: "text-delta", text: "answer" });
      await streamPublisher?.publish({
        type: "tool-call",
        toolName: "search",
      });
      publisher.timeline.push("settle:completed");
    });

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(publisher.events.map((event) => event.type)).toEqual([
      "reasoning-delta",
      "text-delta",
      "tool-call",
      "done",
    ]);
    expect(publisher.timeline).toEqual([
      "publish:reasoning-delta",
      "publish:text-delta",
      "publish:tool-call",
      "settle:completed",
      "publish:done",
      "close",
    ]);
  });

  it("publishes one failure and flushes after durable failure settlement", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, stream: true } },
      Date.now() + 1_000,
      { publisherFactory: (() => publisher) as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async () => {
      throw new Error("child failed");
    });
    internals.completeTask = mock(async (completion) => {
      publisher.timeline.push(`settle:${completion.status}`);
    });

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(publisher.events).toEqual([
      { type: "error", error: "child failed" },
      { type: "done" },
    ]);
    expect(publisher.timeline).toEqual([
      "settle:failed",
      "publish:error",
      "publish:done",
      "close",
    ]);
  });

  it("does not duplicate a failure already present in the child stream", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, stream: true } },
      Date.now() + 1_000,
      { publisherFactory: (() => publisher) as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async (_task, _parentContext, streamPublisher) => {
      await streamPublisher?.publish({
        type: "error",
        error: "provider failed",
      });
      throw new Error("provider failed");
    });
    internals.completeTask = mock(async () => {});

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(publisher.events).toEqual([
      { type: "error", error: "provider failed" },
      { type: "done" },
    ]);
  });

  it("keeps publisher and flush failures best-effort after child success", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = {
      publish: mock(async () => {
        throw new Error("NATS unavailable");
      }),
      close: mock(async () => {
        throw new Error("flush unavailable");
      }),
    };
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, stream: true } },
      Date.now() + 1_000,
      { publisherFactory: (() => publisher) as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async (_task, _parentContext, streamPublisher) => {
      await streamPublisher?.publish({ type: "text-delta", text: "answer" });
    });
    internals.completeTask = mock(async () => {});

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(internals.completeTask).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.close).toHaveBeenCalledTimes(1);
  });

  it("waits for all pending subagents before draining parent messages", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]) => [],
    );
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "acct:account_1:agent:agent_parent:api:event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.pending.set("subagent_1", new Promise(() => {}));
    internals.pending.set("subagent_2", new Promise(() => {}));
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

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(coordinator.pendingCount).toBe(0);

    expect(coordinator.drainCompletionsToParent()).resolves.toBe(2);
    // Both results go in one transcript write.
    expect(persistModelMessages).toHaveBeenCalledTimes(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0])).toContain("first result");
    expect(messageText(messages[1])).toContain("second result");
  });

  it("wakes the parent with a child's question before the rest finish", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (
        _messages: UserModelMessage[],
        _onSaved?: (saved: number) => void,
        _dedupeKeys?: string[],
      ): Promise<never[]> => [],
    );
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "acct:account_1:agent:agent_parent:api:event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 10_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    for (const taskId of ["subagent_1", "subagent_2"]) {
      internals.pending.set(taskId, new Promise<void>(() => {}));
      internals.pendingMetadata.set(taskId, {
        taskId: taskId,
        eventId: `event_${taskId}`,
        agentId: "agent_research",
        conversationKey: `child_${taskId}`,
      });
    }

    await internals.completeTask({
      taskId: "subagent_1",
      eventId: "event_subagent_1",
      agentId: "agent_research",
      conversationKey: "child_subagent_1",
      status: "awaiting_input",
      question: "Which account?",
    });
    expect(await coordinator.waitForIdle()).toBe("question");
    const [question] = await coordinator.takeParentMessages();
    expect(messageText(question)).toContain("Which account?");
    expect(messageText(question)).toContain(
      "conversationKey: child_subagent_1",
    );
    expect(messageText(question)).toContain(
      'message-agents to "agent_research/child_subagent_1"',
    );
    expect(persistModelMessages.mock.calls[0]?.[2]).toEqual([
      "subagent:event_subagent_1:awaiting_input",
    ]);
  });

  it("keeps queued results when a step's write to the parent fails", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]): Promise<never[]> => [],
    );
    persistModelMessages.mockRejectedValueOnce(new Error("convex down"));
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.completions.push(completion("subagent_1", "finished"));

    // A step boundary's write: the next step retries what it did not save.
    expect(coordinator.takeParentMessages()).rejects.toThrow("convex down");
    expect(coordinator.takeParentMessages()).resolves.toHaveLength(1);
    expect(messageText(persistModelMessages.mock.calls[1]?.[0]?.[0])).toContain(
      "finished",
    );
  });

  it("puts back only the results a failed step write did not save", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (
        _messages: UserModelMessage[],
        _onSaved?: (saved: number) => void,
      ): Promise<never[]> => [],
    );
    // A write too large for one append saves its first append, then fails.
    persistModelMessages.mockImplementationOnce(
      async (_messages, onSaved): Promise<never[]> => {
        onSaved?.(1);
        throw new Error("convex down");
      },
    );
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.completions.push(completion("subagent_1", "first"));
    internals.completions.push(completion("subagent_2", "second"));

    // A step boundary's write: the next step retries what it did not save.
    expect(coordinator.takeParentMessages()).rejects.toThrow("convex down");
    expect(persistModelMessages.mock.calls[0]?.[0]).toHaveLength(2);
    expect(coordinator.takeParentMessages()).resolves.toHaveLength(1);
    const retried = persistModelMessages.mock.calls[1]?.[0] ?? [];
    expect(retried).toHaveLength(1);
    expect(messageText(retried[0])).toContain("second");
  });

  it("stores a result and a question once when the append commits but its reply is lost", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const { Session } = await import("../src/harness/session.ts");
    const originalMutate = runtime.mutate.bind(runtime);
    // Convex's append: a row whose dedupe key is already stored is skipped.
    const stored: {
      dedupeKey?: string;
      event: { message: UserModelMessage };
    }[] = [];
    let replies = 0;
    runtime.mutate = mock(
      async (
        _name: string,
        args: { events: (typeof stored)[number][] },
      ): Promise<null> => {
        for (const row of args.events) {
          if (
            row.dedupeKey === undefined ||
            !stored.some(({ dedupeKey }) => dedupeKey === row.dedupeKey)
          ) {
            stored.push(row);
          }
        }
        replies += 1;
        if (replies === 1) throw new Error("reply lost");

        return null;
      },
    ) as never;
    try {
      const coordinator = new SubagentCoordinator(
        new Session({
          eventId: "event_parent",
          conversationKey: "conversation_parent",
          accountId: "account_1",
          agentId: "agent_parent",
          ownerGeneration: 1,
        }),
        {},
        Date.now() + 10_000,
      );
      const internals = coordinator as unknown as CoordinatorInternals;
      internals.completions.push(completion("subagent_1", "finished"));
      internals.pending.set("subagent_2", new Promise<void>(() => {}));
      internals.pendingMetadata.set("subagent_2", {
        taskId: "subagent_2",
        eventId: "event_subagent_2",
        agentId: "agent_research",
        conversationKey: "child",
      });
      await internals.completeTask({
        taskId: "subagent_2",
        eventId: "event_subagent_2",
        agentId: "agent_research",
        conversationKey: "child",
        status: "awaiting_input",
        question: "Which account?",
      });
      expect(await coordinator.waitForIdle()).toBe("question");

      expect(coordinator.takeParentMessages()).rejects.toThrow("reply lost");
      expect(await coordinator.drainCompletionsToParent()).toBe(2);
      const texts = stored.map(({ event }) => messageText(event.message));
      expect(texts.filter((text) => text.includes("finished"))).toHaveLength(1);
      expect(
        texts.filter((text) => text.includes("Which account?")),
      ).toHaveLength(1);
    } finally {
      runtime.mutate = originalMutate;
    }
  });

  it("resumes the parent once with each finished result a failed expiry write did not save", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(true);
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (
        _messages: UserModelMessage[],
        _onSaved?: (saved: number) => void,
      ): Promise<never[]> => [],
    );
    // The expiry write saves its first append, then fails.
    persistModelMessages.mockImplementationOnce(
      async (_messages, onSaved): Promise<never[]> => {
        onSaved?.(1);
        throw new Error("convex down");
      },
    );
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
        _message: UserModelMessage,
        _resultEventId: string,
      ): Promise<SubagentResumeOutcome> => "queued",
    );
    const session = parentSession({
      persistModelMessages: persistModelMessages,
    });
    const coordinator = new SubagentCoordinator(session, {}, Date.now() + 10, {
      lifecycle: { emit: async (): Promise<void> => {} },
      resumeParent: resumeParent,
    });
    const task = (taskId: string) => ({
      taskId: taskId,
      eventId: `event_${taskId}`,
      agentId: "agent_research",
      conversationKey: `subagent-${taskId}`,
    });
    coordinator["completions"].push(
      { ...task("subagent_1"), status: "completed", response: "saved" },
      { ...task("subagent_2"), status: "completed", response: "unsaved" },
      { ...task("subagent_3"), status: "failed", error: "unsaved failure" },
    );
    const running = task("subagent_4");
    coordinator["pending"].set(running.taskId, new Promise((): void => {}));
    coordinator["pendingMetadata"].set(running.taskId, running);

    try {
      expect(await coordinator.waitForIdle()).toBe("timeout");
      // Awaited, so the resumes the failure starts land before the checks.
      expect(
        await coordinator
          .drainCompletionsAndDetachToParent()
          .catch((error: unknown): string => String(error)),
      ).toBe("Error: convex down");
      // The still-running child reports back on its own when it finishes.
      await coordinator["completeTask"]({
        ...running,
        status: "completed",
        response: "late report",
      });

      // No pass drains after the expiry write: every result not saved reaches
      // the parent as its own turn, once, fenced by its own result row.
      expect(
        resumeParent.mock.calls.map(
          ([parent, taskId, message, resultEventId]) => [
            parent === session,
            taskId,
            resultEventId,
            messageText(message).split("Result:\n")[1],
          ],
        ),
      ).toEqual([
        [true, "subagent_2", "event_subagent_2", "unsaved"],
        [true, "subagent_3", "event_subagent_3", "unsaved failure"],
        [true, "subagent_4", "event_subagent_4", "late report"],
      ]);
      // Each unsaved result is left for the recovery sweep should its resume fail.
      for (const eventId of ["event_subagent_2", "event_subagent_3"]) {
        expect(mutate).toHaveBeenCalledWith("markAsyncAgentHandback", {
          eventId: eventId,
          handback: "detached",
        });
      }
      expect(mutate).not.toHaveBeenCalledWith("markAsyncAgentHandback", {
        eventId: "event_subagent_1",
        handback: "detached",
      });
      // Nothing is left queued to be written or resumed again.
      expect(await coordinator.drainCompletionsToParent()).toBe(0);
      expect(persistModelMessages).toHaveBeenCalledTimes(1);
    } finally {
      mutate.mockRestore();
    }
  });

  it("resumes the parent with each result the pass's last write did not save, and detaches the children still working", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(true);
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
      ): Promise<SubagentResumeOutcome> => "queued",
    );
    const coordinator = new SubagentCoordinator(
      parentSession({
        persistModelMessages: mock(async (): Promise<never> => {
          throw new Error("convex down");
        }),
      }),
      {},
      Date.now() + 60_000,
      { resumeParent: resumeParent },
    );
    coordinator["completions"].push({
      taskId: "subagent_1",
      eventId: "event_subagent_1",
      agentId: "agent_research",
      conversationKey: "subagent-subagent_1",
      status: "completed",
      response: "idle report",
    });
    // A child still working.
    const asking = {
      taskId: "subagent_2",
      eventId: "event_subagent_2",
      agentId: "agent_research",
      conversationKey: "subagent-subagent_2",
    };
    coordinator["pending"].set(asking.taskId, new Promise((): void => {}));
    coordinator["pendingMetadata"].set(asking.taskId, asking);

    try {
      expect(
        await coordinator
          .drainCompletionsToParent()
          .catch((error: unknown): string => String(error)),
      ).toBe("Error: convex down");
      // The working child is detached, so its result resumes the parent too.
      await coordinator["completeTask"]({
        ...asking,
        status: "completed",
        response: "after the failure",
      });
      expect(resumeParent.mock.calls.map(([, taskId]) => taskId)).toEqual([
        "subagent_1",
        "subagent_2",
      ]);
      for (const eventId of ["event_subagent_1", "event_subagent_2"]) {
        expect(mutate).toHaveBeenCalledWith("markAsyncAgentHandback", {
          eventId: eventId,
          handback: "detached",
        });
      }
      expect(await coordinator.drainCompletionsToParent()).toBe(0);
    } finally {
      mutate.mockRestore();
    }
  });

  it("leaves a dropped completion pending when the detach write and the resume both fail", async () => {
    const mutate = spyOn(runtime, "mutate").mockRejectedValue(
      new Error("convex down"),
    );
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const resumeParent = mock(
      async (): Promise<SubagentResumeOutcome> => "capacity",
    );
    const coordinator = new SubagentCoordinator(
      parentSession({
        persistModelMessages: mock(async (): Promise<never> => {
          throw new Error("append failed");
        }),
      }),
      {},
      Date.now() + 60_000,
      { resumeParent: resumeParent },
    );
    coordinator["completions"].push({
      ...lateChild(),
      status: "completed",
      response: "dropped",
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // Only the append's own error surfaces; the detach write and the
      // refused resume are logged and swallowed.
      expect(
        await coordinator
          .drainCompletionsToParent()
          .catch((error: unknown): string => String(error)),
      ).toBe("Error: append failed");
      await Bun.sleep(0);
      expect(mutate.mock.calls).toEqual([
        [
          "markAsyncAgentHandback",
          { eventId: "event_subagent_1", handback: "detached" },
        ],
      ]);
      expect(resumeParent).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      // Nothing is left queued here: the row, still pending, is the sweep's.
      expect(await coordinator.drainCompletionsToParent()).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      mutate.mockRestore();
    }
  });

  it("writes no running notice for a child that finishes while the detach records it", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]): Promise<never[]> => [],
    );
    let finish = (): void => {};
    const coordinator = new SubagentCoordinator(
      parentSession({ persistModelMessages: persistModelMessages }),
      { subagent: { enabled: true } },
      Date.now() + 1_000,
    );
    coordinator["runTask"] = mock(
      (): Promise<void> =>
        new Promise<void>((resolve): void => {
          finish = resolve;
        }),
    );
    // The child finishes, and leaves the coordinator, while the detach awaits
    // its hand-back write.
    const mutate = spyOn(runtime, "mutate").mockImplementation(
      async (name): Promise<true> => {
        if (name === "markAsyncAgentHandback") {
          finish();
          while (coordinator.runningCount > 0) await Bun.sleep(1);
        }

        return true;
      },
    );
    try {
      await coordinator.dispatch([{ prompt: "research" }], []);

      expect(await coordinator.drainCompletionsAndDetachToParent()).toBe(0);
      expect(persistModelMessages).not.toHaveBeenCalled();
    } finally {
      mutate.mockRestore();
    }
  });

  it("ends the wait when a heartbeat finds the run lost", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      {},
      Date.now() + 10,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.pending.set("subagent_1", new Promise<void>(() => {}));

    expect(
      coordinator.waitForIdle({
        onHeartbeat: async (): Promise<void> => {
          throw new Error("ownership lost");
        },
      }),
    ).rejects.toThrow("ownership lost");
  });

  it("emits heartbeats while waiting and batches completed results with still-running notices", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]) => [],
    );
    const onHeartbeat = mock((_pendingCount: number) => {});
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 10,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.completions.push(
      completion("subagent_1", "finished before timeout"),
    );
    internals.pending.set("subagent_2", new Promise(() => {}));
    internals.pendingMetadata.set("subagent_2", {
      taskId: "subagent_2",
      eventId: "event_subagent_2",
      agentId: "agent_research",
      conversationKey: "subagent-subagent_2",
    });

    expect(coordinator.waitForIdle({ onHeartbeat: onHeartbeat })).resolves.toBe(
      "timeout",
    );
    expect(onHeartbeat).toHaveBeenCalledWith(1);

    expect(coordinator.drainCompletionsAndDetachToParent()).resolves.toBe(2);
    expect(persistModelMessages).toHaveBeenCalledTimes(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0])).toContain("finished before timeout");
    expect(messageText(messages[1])).toContain("status: running");
    expect(messageText(messages[1])).toContain("do not redo this task");
    expect(messageText(messages[1])).not.toContain("failed");
    expect(messageText(messages[1])).toContain("agentId: agent_research");
    expect(messageText(messages[1])).toContain(
      "conversationKey: subagent-subagent_2",
    );
  });

  it("resumes the parent with a result that lands after the parent stopped waiting", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(true);
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
        _message: UserModelMessage,
        _resultEventId: string,
      ): Promise<SubagentResumeOutcome> => "queued",
    );
    const session = parentSession();
    const coordinator = new SubagentCoordinator(session, {}, Date.now(), {
      lifecycle: { emit: async (): Promise<void> => {} },
      resumeParent: resumeParent,
    });
    const late = lateChild();
    coordinator["pending"].set(late.taskId, new Promise((): void => {}));
    coordinator["pendingMetadata"].set(late.taskId, late);

    try {
      expect(await coordinator.drainCompletionsAndDetachToParent()).toBe(1);
      expect(coordinator.pendingCount).toBe(0);
      // The parent's run still ends waiting on it.
      expect(coordinator.runningCount).toBe(1);

      await coordinator["completeTask"]({ ...late, status: "completed" });

      expect(resumeParent).toHaveBeenCalledTimes(1);
      const [parent, taskId, message, resultEventId] =
        resumeParent.mock.calls[0]!;
      expect(parent).toBe(session);
      expect(taskId).toBe(late.taskId);
      // Convex admits it only while the parent has not read this row.
      expect(resultEventId).toBe(late.eventId);
      expect(messageText(message)).toContain("status: completed");
      expect(messageText(message)).toContain("the late answer");
      // Nothing queues for a parent pass that will never drain it.
      expect(await coordinator.drainCompletionsToParent()).toBe(0);
    } finally {
      mutate.mockRestore();
    }
  });

  it("keeps a result the parent already has seen when its child detaches on a follow-up", async (): Promise<void> => {
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      {},
      Date.now() + 60_000,
      { lifecycle: { emit: async (): Promise<void> => {} } },
    );
    const answered = lateChild();
    const running = {
      ...lateChild(),
      taskId: "subagent_2",
      eventId: "event_2",
    };
    for (const child of [answered, running]) {
      coordinator["pending"].set(child.taskId, new Promise((): void => {}));
      coordinator["pendingMetadata"].set(child.taskId, child);
    }

    try {
      // The first turn's result goes in; the same task then drains a follow-up.
      await coordinator["completeTask"]({ ...answered, status: "completed" });
      expect(await coordinator.drainCompletionsToParent()).toBe(1);
      await coordinator.drainCompletionsAndDetachToParent();

      // Only the child the parent has nothing from is left to the sweep.
      expect(markHandback.mock.calls).toEqual([["event_2", "detached"]]);
    } finally {
      markHandback.mockRestore();
    }
  });

  it("walks every page of lost results and retries a full conversation or a still queued resume without rerunning its hook", async (): Promise<void> => {
    const rows = [lostRow("event_full"), lostRow("event_other")];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
        cursor: string | null;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        const unseen = rows.filter(
          (row): boolean =>
            row.handback === options.handback && row.status === options.status,
        );
        // One row a page, so the second is only reached through the cursor.
        const index = options.cursor === null ? 0 : 1;

        return {
          page: unseen.slice(index, index + 1),
          cursor: "next",
          isDone: index + 1 >= unseen.length,
        };
      },
    );
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    let hookRuns = 0;
    const hooks = spyOn(
      hookDispatcher,
      "createAgentHookDispatcher",
    ).mockResolvedValue({
      hasHooksFor: (): boolean => true,
      runMutation: async (): Promise<Record<string, unknown>> => {
        hookRuns += 1;

        return { visibleResult: `rewritten ${hookRuns}` };
      },
    });
    const info = spyOn(log, "logInfo");
    // The first conversation's queue is full on the first pass, and on the
    // second its resume is a duplicate of one still queued, which stores the
    // row when applied or is admitted again once it expired.
    const refusals: SubagentResumeOutcome[] = ["capacity", "duplicate"];
    const resumed: Array<{ eventId: string; message: string }> = [];
    const resumeParent = async (
      _parent: unknown,
      _taskId: string,
      message: UserModelMessage,
      resultEventId: string,
    ): Promise<SubagentResumeOutcome> => {
      const refusal =
        resultEventId === rows[0]!.eventId ? refusals.shift() : undefined;
      if (refusal) return refusal;
      resumed.push({ eventId: resultEventId, message: messageText(message) });
      rows.splice(
        rows.findIndex((row): boolean => row.eventId === resultEventId),
        1,
      );

      return "queued";
    };
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(lostParent, resumeParent);
      expect(resumed).toEqual([
        {
          eventId: lostRow("event_other").eventId,
          message: expect.stringContaining("rewritten 2"),
        },
      ]);
      await resumeLostSubagentResults(lostParent, resumeParent);
      expect(resumed).toHaveLength(1);
      await resumeLostSubagentResults(lostParent, resumeParent);

      // The retry carries the first pass's rewrite; the hook ran once a row.
      expect(hookRuns).toBe(2);
      expect(resumed[1]).toEqual({
        eventId: lostRow("event_full").eventId,
        message: expect.stringContaining("rewritten 1"),
      });
      expect(markHandback).not.toHaveBeenCalled();
      // A resume is logged only once a conversation admitted it.
      expect(
        info.mock.calls.filter(
          ([message]): boolean =>
            message === "Resumed the parent with a lost subagent result",
        ),
      ).toHaveLength(2);
    } finally {
      pages.mockRestore();
      markHandback.mockRestore();
      hooks.mockRestore();
      info.mockRestore();
    }
  });

  it("holds a resume it queued, so the next pass reuses its message instead of rerunning the hook", async (): Promise<void> => {
    // The row stays listed: a queued resume stores it only when applied.
    const rows = [lostRow("event_queued")];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => ({
        page: rows.filter(
          (row): boolean =>
            row.handback === options.handback && row.status === options.status,
        ),
        cursor: "end",
        isDone: true,
      }),
    );
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    let hookRuns = 0;
    const hooks = spyOn(
      hookDispatcher,
      "createAgentHookDispatcher",
    ).mockResolvedValue({
      hasHooksFor: (): boolean => true,
      runMutation: async (): Promise<Record<string, unknown>> => {
        hookRuns += 1;

        return { visibleResult: `rewritten ${hookRuns}` };
      },
    });
    const outcomes: SubagentResumeOutcome[] = ["queued", "duplicate"];
    const messages: string[] = [];
    const resumeParent = async (
      _parent: unknown,
      _taskId: string,
      message: UserModelMessage,
    ): Promise<SubagentResumeOutcome> => {
      messages.push(messageText(message));

      return outcomes.shift()!;
    };
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(lostParent, resumeParent);
      await resumeLostSubagentResults(lostParent, resumeParent);

      expect(hookRuns).toBe(1);
      expect(messages).toEqual([
        expect.stringContaining("rewritten 1"),
        expect.stringContaining("rewritten 1"),
      ]);
      expect(markHandback).not.toHaveBeenCalled();
    } finally {
      pages.mockRestore();
      markHandback.mockRestore();
      hooks.mockRestore();
    }
  });

  it("the sweep resumes a pending hand-back only past the parent's hold window", async (): Promise<void> => {
    const now = Date.now();
    const minutes = (count: number): string =>
      new Date(now - count * 60 * 1000).toISOString();
    // Both rows finished with no run detaching them. The young one's parent
    // may still be draining it; the old one has no live parent run left.
    const rows: AsyncAgentResultRecord[] = [
      { ...lostRow("event_young"), handback: "pending", updatedAt: minutes(5) },
      { ...lostRow("event_old"), handback: "pending", updatedAt: minutes(30) },
    ];
    const windows: Array<{ handback: SweptHandback; updatedBefore: string }> =
      [];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
        updatedBefore: string;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        windows.push({
          handback: options.handback,
          updatedBefore: options.updatedBefore,
        });

        return {
          page: rows.filter(
            (row): boolean =>
              row.handback === options.handback &&
              row.status === options.status &&
              row.updatedAt < options.updatedBefore,
          ),
          cursor: "end",
          isDone: true,
        };
      },
    );
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    const info = spyOn(log, "logInfo");
    const resumed: string[] = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        lostParent,
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
          resultEventId: string,
        ): Promise<SubagentResumeOutcome> => {
          resumed.push(resultEventId);

          return "queued";
        },
      );

      expect(resumed).toEqual([lostRow("event_old").eventId]);
      expect(markHandback).not.toHaveBeenCalled();
      // A pending result waits out the parent's whole hold, longer than the
      // grace a detached one gets.
      const before = (handback: SweptHandback): string =>
        windows.find((window): boolean => window.handback === handback)!
          .updatedBefore;
      expect(before("pending") < before("detached")).toBe(true);
      expect(before("pending") < minutes(15)).toBe(true);
      // Each one is counted: a parent run dropped it without a trace.
      expect(
        info.mock.calls
          .filter(
            ([message]): boolean =>
              message === "Subagent result left pending past the parent's hold",
          )
          .map(([, data]) => data),
      ).toEqual([
        {
          eventId: lostRow("event_old").eventId,
          ageMs: expect.any(Number),
          outcome: "completed",
        },
      ]);
    } finally {
      pages.mockRestore();
      markHandback.mockRestore();
      info.mockRestore();
    }
  });

  it("fails a pending child still running past the bound and detaches it, so the next pass delivers it after the grace", async (): Promise<void> => {
    const now = Date.now();
    const minutes = (count: number): string =>
      new Date(now - count * 60 * 1000).toISOString();
    // Both parents and their pod died before any detach: the young child may
    // still be running on its budget, the old one cannot be.
    const rows: AsyncAgentResultRecord[] = [
      {
        ...lostRow("event_young"),
        handback: "pending",
        status: "processing",
        response: undefined,
        updatedAt: minutes(5),
      },
      {
        ...lostRow("event_dead"),
        handback: "pending",
        status: "processing",
        response: undefined,
        updatedAt: minutes(40),
      },
    ];
    const windows: Array<{ handback: SweptHandback; status: string }> = [];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
        updatedBefore: string;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        windows.push({ handback: options.handback, status: options.status });

        return {
          page: rows.filter(
            (row): boolean =>
              row.handback === options.handback &&
              row.status === options.status &&
              row.updatedAt < options.updatedBefore,
          ),
          cursor: "end",
          isDone: true,
        };
      },
    );
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    const record = spyOn(
      asyncAgentResults,
      "recordAsyncAgentResult",
    ).mockResolvedValue();
    const resumed: string[] = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        lostParent,
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
          resultEventId: string,
        ): Promise<SubagentResumeOutcome> => {
          resumed.push(resultEventId);

          return "queued";
        },
      );

      // The pending window covers processing rows like the others.
      expect(windows).toContainEqual({
        handback: "pending",
        status: "processing",
      });
      // Failed and detached in one write, so a crash between the two never
      // leaves a failed row waiting out another hold.
      expect(record.mock.calls).toEqual([
        [
          lostRow("event_dead").eventId,
          { status: "failed", error: expect.stringContaining("restarted") },
          { onlyWhileProcessing: true, handback: "detached" },
        ],
      ]);
      expect(markHandback).not.toHaveBeenCalled();
      expect(resumed).toEqual([]);
    } finally {
      pages.mockRestore();
      markHandback.mockRestore();
      record.mockRestore();
    }
  });

  it("the sweep resumes the parent with a lost child question", async (): Promise<void> => {
    const row: AsyncAgentResultRecord = {
      ...lostRow("event_question"),
      status: "awaiting_input",
      response: undefined,
      question: "Which region?",
    };
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => ({
        page:
          options.handback === row.handback && options.status === row.status
            ? [row]
            : [],
        cursor: "end",
        isDone: true,
      }),
    );
    const messages: UserModelMessage[] = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        lostParent,
        async (
          _parent: unknown,
          _taskId: string,
          message: UserModelMessage,
        ): Promise<SubagentResumeOutcome> => {
          messages.push(message);

          return "owner";
        },
      );

      expect(messages).toHaveLength(1);
      expect(messageText(messages[0])).toContain("Which region?");
      expect(messageText(messages[0])).toContain("Subagent message");
    } finally {
      pages.mockRestore();
    }
  });

  it("gives up once on lost results no resume can deliver, and fails only a still-running dead child", async (): Promise<void> => {
    const otherAccountTask = createSubagentTaskId(
      scopedDirectEventId("account_2", "agent_parent", "event_parent"),
    );
    const rows: AsyncAgentResultRecord[] = [
      lostRow("event_gone"),
      lostRow("event_conflict"),
      {
        ...lostRow("event_foreign"),
        eventId: scopedDirectEventId(
          "account_1",
          "agent_child",
          otherAccountTask,
        ),
      },
      { ...lostRow("event_dead"), status: "processing", response: undefined },
    ];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (options: {
        handback: SweptHandback;
        status: string;
      }): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => ({
        page: rows.filter(
          (row): boolean =>
            row.handback === options.handback && row.status === options.status,
        ),
        cursor: "end",
        isDone: true,
      }),
    );
    const markHandback = spyOn(
      asyncAgentResults,
      "markAsyncAgentHandback",
    ).mockResolvedValue(false);
    const record = spyOn(
      asyncAgentResults,
      "recordAsyncAgentResult",
    ).mockResolvedValue();
    const resumed: string[] = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        async (
          accountId: string,
          agentId: string,
          conversationKey: string,
        ): Promise<ReentryTarget | null> =>
          conversationKey ===
          lostRow("event_gone").subagent?.parentConversationKey
            ? null
            : lostParent(accountId, agentId, conversationKey),
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
          resultEventId: string,
        ): Promise<SubagentResumeOutcome> => {
          resumed.push(resultEventId);

          return "conflict";
        },
      );

      expect(resumed).toEqual([lostRow("event_conflict").eventId]);
      expect(markHandback.mock.calls).toHaveLength(3);
      expect(markHandback.mock.calls).toEqual(
        expect.arrayContaining(
          rows
            .slice(0, 3)
            .map(({ eventId }): [string, "stored"] => [eventId, "stored"]),
        ),
      );
      // An outcome that lands after the list is never overwritten.
      expect(record.mock.calls).toEqual([
        [
          rows[3]!.eventId,
          { status: "failed", error: expect.stringContaining("restarted") },
          { onlyWhileProcessing: true },
        ],
      ]);
    } finally {
      pages.mockRestore();
      markHandback.mockRestore();
      record.mockRestore();
    }
  });

  it("does not call a child running when its result is in the same batch", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      {},
      Date.now(),
    );
    // Finished, but still settling its lease, so it is still pending.
    const finished = lateChild();
    coordinator["completions"].push({ ...finished, status: "completed" });
    coordinator["pending"].set(finished.taskId, new Promise((): void => {}));
    coordinator["pendingMetadata"].set(finished.taskId, finished);

    expect(await coordinator.drainCompletionsAndDetachToParent()).toBe(1);
    expect(coordinator.runningCount).toBe(0);
  });

  it("stringifies structured subagent results for parent injection", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]) => [],
    );
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "event_parent",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async (): Promise<string> => "renewed",
      } as never,
      {},
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.completions.push(completion("subagent_1", { answer: "done" }));

    expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain('{"answer":"done"}');
  });

  it("resolves persistent conversation keys for new and resumed subagents", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "acct:account_1:agent:agent_parent:api:event_parent",
        persistModelMessages: mock(async () => []),
      } as never,
      {
        subagent: {
          enabled: true,
          mode: "persistent",
        },
      },
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    const created = await internals.resolveTask({ prompt: "start" }, [], []);
    expect(created.taskId.startsWith("subagent~")).toBe(true);
    expect(created.eventId).toContain(`:api:${created.taskId}`);
    const keyUuid = /^subagent-persistent-([0-9a-f-]{36})-/.exec(
      created.publicConversationKey,
    )?.[1];
    expect(created.agentId).toBe(`virtual_subagent_${keyUuid}`);
    expect(
      created.publicConversationKey.startsWith("subagent-persistent-"),
    ).toBe(true);
    expect(created.conversationKey).toContain(
      `api:${created.publicConversationKey}`,
    );
    expect(created.persistent).toBe(true);
    expect(created.resuming).toBe(false);

    const resumed = await internals.resolveTask(
      {
        prompt: "continue",
        conversationKey: created.publicConversationKey,
      },
      [],
      [],
    );
    expect(resumed.publicConversationKey).toBe(created.publicConversationKey);
    // The resumed virtual child is the same child, on the same history.
    expect(resumed.taskId).not.toBe(created.taskId);
    expect(resumed.agentId).toBe(created.agentId);
    expect(resumed.conversationKey).toBe(created.conversationKey);
    expect(resumed.persistent).toBe(true);
    expect(resumed.resuming).toBe(true);

    // A key the runtime never minted could name another caller's direct-API
    // conversation with the child agent.
    expect(
      internals.resolveTask(
        { prompt: "recount", conversationKey: "user-123" },
        [],
        [],
      ),
    ).rejects.toThrow("must be one run_subagent returned to this agent");
    // The minted form alone is a name any direct-API caller can pick: only
    // core's tag over this account and parent makes it resumable.
    const forged = created.publicConversationKey.replace(
      /-[0-9a-f]{32}$/,
      `-${"0".repeat(32)}`,
    );
    for (const conversationKey of ["subagent-persistent-alice", forged]) {
      expect(
        internals.resolveTask(
          { prompt: "recount", conversationKey: conversationKey },
          [],
          [],
        ),
      ).rejects.toThrow("must be one run_subagent returned to this agent");
    }
  });

  it("runs a virtual child on subagent.model with the parent's tools", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const parent: AgentConfig = {
      model: {
        provider: "deepseek",
        modelId: "deepseek-flash",
        temperature: 0,
      },
      tools: { webSearch: { enabled: true } },
      sandboxes: ["sandbox_1"],
      denyTools: ["bash"],
      policies: ["policy_room"],
      subagent: { enabled: true, model: { modelId: "deepseek-v4-pro" } },
    };
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "acct:account_1:agent:agent_parent:api:event_parent",
      } as never,
      parent,
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    const { agentConfig } = await internals.resolveTask(
      { prompt: "count" },
      [],
      [],
    );

    expect(agentConfig).toEqual({
      ...parent,
      model: {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        temperature: 0,
      },
      subagent: { ...parent.subagent, enabled: false },
    });
  });

  it("admits a persistent child conversation to own a fencing generation", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const candidates: Record<string, unknown>[] = [];
    runtime.mutate = mock(
      async (name: string, args: Record<string, unknown>) => {
        candidates.push({ name: name, ...args });

        return { outcome: "owner", ownerGeneration: 7 };
      },
    ) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 1_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    try {
      const generation = await internals.admitChildConversation(
        persistentChildTask(),
        { role: "user", content: [{ type: "text", text: "research" }] },
      );

      expect(generation).toBe(7);
      const candidate = candidates[0];
      expect(candidate?.name).toBe("acceptIngress");
      expect(candidate?.accountId).toBe("account_1");
      expect(candidate?.agentId).toBe("agent_child");
      expect(candidate?.conversationKey).toBe(
        "acct:account_1:agent:agent_child:api:subagent-persistent-1",
      );
      // A busy child conversation must surface to the parent, never queue.
      expect(candidate?.requestedMode).toBe("reject");
      expect(candidate?.delivery).toMatchObject({
        kind: "async",
        publicEventId: "subagent~task_1",
        publicConversationKey: "subagent-persistent-1",
        statusUrl: `/v1/runs/${CHILD_RUN_ID}`,
      });
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("records a child's wait on its parent as its awaiting_input outcome and queues it for the parent", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    const task = persistentChildTask();
    internals.pending.set(task.taskId, new Promise<void>(() => {}));
    const settleIngress = mock(
      async (_status: string, _settlement: unknown): Promise<boolean> => true,
    );
    const persistModelMessages = mock(
      async (_messages: unknown[]): Promise<void> => {},
    );
    const childSession = {
      persistModelMessages: persistModelMessages,
      settleIngress: settleIngress,
      takeNextIngress: async (): Promise<null> => null,
      releaseConversationLease: async (): Promise<void> => {},
    };

    await internals.completeAskedRun(childSession, task, {
      text: "Which region?",
      exchangeId: "ex_1",
      followUp: false,
      waitSeconds: 3600,
    });

    // Pruning drops the message-agents call from later turns; this line survives.
    expect(persistModelMessages.mock.calls[0]?.[0]).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I messaged my parent and am waiting for the reply (exchange ex_1): Which region?",
          },
        ],
      },
    ]);

    expect(settleIngress.mock.calls[0]?.[1]).toMatchObject({
      asyncResult: {
        eventIds: [task.eventId],
        outcome: { status: "awaiting_input", question: "Which region?" },
      },
    });
    expect(internals.completions).toEqual([
      expect.objectContaining({
        taskId: task.taskId,
        status: "awaiting_input",
        question: "Which region?",
      }),
    ]);
    expect(await coordinator.waitForIdle()).toBe("question");
  });

  it("settles and hands off an admitted child when turn context creation fails", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const mutations: string[] = [];
    runtime.mutate = mock(async (name: string) => {
      mutations.push(name);

      return null;
    }) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.admitChildConversation = mock(async () => 7);
    internals.createChildTurnContext = mock(async () => {
      throw new Error("turn context failed");
    });

    try {
      expect(internals.runTask(persistentChildTask())).rejects.toThrow(
        "turn context failed",
      );
      expect(mutations).toContain("settleIngress");
      expect(mutations).toContain("takeNextIngress");
      expect(mutations).not.toContain("releaseIngressOwner");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("preserves the original child failure when queued draining also fails", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    runtime.mutate = mock(async () => null) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.admitChildConversation = mock(async () => 7);
    internals.createChildTurnContext = mock(async () => {
      throw new Error("provider failed");
    });
    internals.drainChildConversation = mock(async () => {
      throw new Error("queued drain failed");
    });

    try {
      expect(internals.runTask(persistentChildTask())).rejects.toThrow(
        "provider failed",
      );
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("settles a completed child's envelope and row together, and keeps the row when that settle and the drain fail", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const mutations: string[] = [];
    runtime.mutate = mock(async (name: string) => {
      mutations.push(name);

      return true;
    }) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    const completeTask = mock(async () => {});
    const drainChildConversation = mock(async () => {
      throw new Error("queued drain failed");
    });
    const settleIngress = mock(
      async (_status: string, _options: unknown): Promise<boolean> => {
        throw new Error("settlement failed");
      },
    );
    internals.completeTask = completeTask;
    internals.drainChildConversation = drainChildConversation;
    const task = persistentChildTask();

    try {
      expect(
        internals.completeSuccessfulRun(
          { settleIngress: settleIngress } as never,
          task,
          "finished",
        ),
      ).resolves.toBeUndefined();
      expect(settleIngress).toHaveBeenCalledWith("completed", {
        result: "finished",
        asyncResult: {
          eventIds: [task.eventId],
          outcome: { status: "completed", response: "finished" },
        },
      });
      expect(mutations).toContain("updateAsyncAgentResult");
      expect(completeTask).toHaveBeenCalledTimes(1);
      expect(settleIngress).toHaveBeenCalledTimes(1);
      expect(drainChildConversation).toHaveBeenCalledTimes(1);
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("keeps a completed child completed when its finish hook and webhook fail", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const mutations: string[] = [];
    runtime.mutate = mock(async (name: string) => {
      mutations.push(name);

      return true;
    }) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      {
        lifecycle: {
          emit: mock(async () => {
            throw new Error("webhook delivery failed");
          }),
        } as never,
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.pending.set("subagent~task_1", Promise.resolve());
    coordinator.attachHooks({
      runMutation: async () => {
        throw new Error("hook record unreadable");
      },
    } as never);

    try {
      // Rejecting here would reach runTask's failure path, which marks the
      // already durable completed result failed and erases its response.
      expect(
        internals.completeTask({
          taskId: "subagent~task_1",
          eventId: "acct:account_1:agent:agent_child:api:subagent~task_1",
          agentId: "agent_child",
          conversationKey: "subagent-persistent-1",
          status: "completed",
          response: "finished",
        }),
      ).resolves.toBeUndefined();
      // A broken hook loses its override, never the child's answer.
      expect(internals.completions).toHaveLength(1);
      expect(internals.completions[0]?.response).toBe("finished");
      expect(mutations).not.toContain("updateAsyncAgentResult");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("runs a queued envelope in-process so its result reaches the parent", async () => {
    const releaseConversationLease = mock(async () => {});
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    const runTask = mock(async () => {});
    internals.runTask = runTask;

    await internals.drainChildConversation(
      {
        releaseConversationLease: releaseConversationLease,
        takeNextIngress: async () => ({
          eventId: "queued-event",
          events: [{ role: "user", content: "follow up" }],
          ownerGeneration: 9,
        }),
      } as never,
      persistentChildTask(),
    );

    expect(runTask).toHaveBeenCalledTimes(1);
    const [followUp, , , preOwned] = runTask.mock.calls[0] as unknown as [
      { eventId: string; taskId: string; resuming: boolean },
      unknown,
      unknown,
      { ownerGeneration: number; events: unknown[] },
    ];
    // Same taskId keeps the follow-up attached to the parent's pending task, so
    // completeTask still injects its result back into the parent.
    expect(followUp.taskId).toBe("subagent~task_1");
    expect(followUp.eventId).toBe("queued-event");
    expect(followUp.resuming).toBe(true);
    expect(preOwned.ownerGeneration).toBe(9);
    expect(releaseConversationLease).not.toHaveBeenCalled();
  });

  it("records a queued child failure against its own event", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const updates: Record<string, unknown>[] = [];
    runtime.mutate = mock(
      async (name: string, args: Record<string, unknown>) => {
        updates.push({ name: name, ...args });

        return null;
      },
    ) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.pending.set("subagent~task_1", Promise.resolve());
    internals.runTask = mock(async () => {
      throw new Error("queued child failed");
    });

    try {
      expect(
        internals.drainChildConversation(
          {
            takeNextIngress: async () => ({
              eventId: "queued-event",
              events: [{ role: "user", content: "follow up" }],
              ownerGeneration: 9,
            }),
          } as never,
          persistentChildTask(),
        ),
      ).rejects.toThrow("queued child failed");
      expect(updates).toContainEqual({
        name: "updateAsyncAgentResult",
        eventId: "queued-event",
        status: "failed",
        error: "queued child failed",
      });
      expect(await coordinator.drainCompletionsToParent()).toBe(1);
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("keeps a stopped child's progress out of the parent transcript", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    runtime.mutate = mock(async () => true) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as {
      completeTask(completion: unknown): Promise<void>;
      pending: Map<string, Promise<void>>;
    };
    const failure = {
      taskId: "subagent~task_1",
      eventId: "acct:account_1:agent:agent_child:api:subagent~task_1",
      agentId: "agent_child",
      conversationKey: "subagent-persistent-1",
      status: "failed",
    };

    try {
      for (const stopped of [
        "Stopped by user at the model boundary",
        "Stopped by the parent agent at the model boundary",
      ]) {
        internals.pending.set("subagent~task_1", Promise.resolve());
        await internals.completeTask({ ...failure, error: stopped });

        expect(await coordinator.drainCompletionsToParent()).toBe(0);
      }

      // A genuine failure is still reported, so the parent can react to it.
      internals.pending.set("subagent~task_1", Promise.resolve());
      await internals.completeTask({ ...failure, error: "provider exploded" });

      expect(await coordinator.drainCompletionsToParent()).toBe(1);
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("releases the child lease when nothing is queued behind it", async () => {
    const releaseConversationLease = mock(async () => {});
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      {
        releaseConversationLease: releaseConversationLease,
        takeNextIngress: async () => null,
      } as never,
      persistentChildTask(),
    );

    expect(releaseConversationLease).toHaveBeenCalledTimes(1);
  });

  it("transfers the queue to a worker once the parent wait budget has passed", async () => {
    const scopes: Record<string, unknown>[] = [];
    const releaseConversationLease = mock(async () => {});
    const takeNextIngress = mock(async () => null);
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() - 1,
      {
        lifecycle: { emit: mock(async () => {}) } as never,
        dispatchNextIngress: async (_session, scope) => {
          scopes.push(scope as unknown as Record<string, unknown>);

          return true;
        },
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      {
        releaseConversationLease: releaseConversationLease,
        takeNextIngress: takeNextIngress,
      } as never,
      persistentChildTask(),
    );

    expect(scopes[0]).toMatchObject({
      accountId: "account_1",
      agentId: "agent_child",
      conversationKey:
        "acct:account_1:agent:agent_child:api:subagent-persistent-1",
      publicConversationKey: "subagent-persistent-1",
      // A queued control carries no config ref: it runs on the child's config.
      subagentConfig: persistentChildTask().agentConfig,
    });
    // No live parent turn to inject into, so it must not run in-process.
    expect(takeNextIngress).not.toHaveBeenCalled();
    // Ownership moved to the queued envelope, so releasing would strand it.
    expect(releaseConversationLease).not.toHaveBeenCalled();
  });

  it("releases the child lease when the expired-budget transfer fails", async () => {
    const releaseConversationLease = mock(async () => {});
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() - 1,
      {
        lifecycle: { emit: mock(async () => {}) } as never,
        dispatchNextIngress: async () => {
          throw new Error("worker unavailable");
        },
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      { releaseConversationLease: releaseConversationLease } as never,
      persistentChildTask(),
    );

    expect(releaseConversationLease).toHaveBeenCalledTimes(1);
  });

  it("releases the child lease when an expired-budget transfer finds no work", async () => {
    const releaseConversationLease = mock(async () => {});
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() - 1,
      {
        lifecycle: { emit: mock(async () => {}) } as never,
        dispatchNextIngress: async () => false,
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      { releaseConversationLease: releaseConversationLease } as never,
      persistentChildTask(),
    );

    expect(releaseConversationLease).toHaveBeenCalledTimes(1);
  });

  it("refuses to run a persistent child whose conversation is busy", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    runtime.mutate = mock(async () => ({ outcome: "rejected" })) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 1_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    try {
      expect(
        internals.admitChildConversation(persistentChildTask(), {
          role: "user",
          content: [{ type: "text", text: "research" }],
        }),
      ).rejects.toThrow("Subagent conversation is not available: rejected");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("runs an ephemeral child through its first step without storing it", async () => {
    const originalMutation = runtime.mutate.bind(runtime);
    const originalQuery = runtime.query.bind(runtime);
    const mutations: string[] = [];
    const queries: string[] = [];
    runtime.mutate = mock(async (name: string) => {
      mutations.push(name);

      return true;
    }) as never;
    runtime.query = mock(async (name: string) => {
      queries.push(name);

      return null;
    }) as never;
    setStorageForTests({
      taskUsage: { record: async (): Promise<void> => {} },
    } as never);
    // No call may leave the process if the streamText stand-in is bypassed.
    globalThis.fetch = mock(async () => {
      throw new Error("network is blocked in this test");
    }) as never;
    // harness.test.ts leaves its own fake streamText on the shared "ai" module,
    // so the real one is out of reach here. This one runs the loop's first
    // prepareStep, where the hand-built child used to throw.
    const previousStreamText = ai.streamText;
    const streamText = mock((options: StreamTextStandInOptions) => {
      const stream = new ReadableStream({
        start: async (controller): Promise<void> => {
          await options.prepareStep({
            messages: [{ role: "user", content: "research" }],
            responseMessages: [],
          });
          await options.onEnd({
            response: { messages: [{ role: "assistant", content: "done" }] },
            responseMessages: [{ role: "assistant", content: "done" }],
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            steps: [],
            toolCalls: [],
          });
          controller.close();
        },
      });

      return {
        stream: stream,
        consumeStream: async (): Promise<void> => {
          const reader = stream.getReader();
          while (!(await reader.read()).done) {}
        },
      };
    });
    await mock.module("ai", () => ({ ...ai, streamText: streamText }));
    const { Session } = await import("../src/harness/session.ts");
    const boundary = spyOn(Session.prototype, "stepBoundary");
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "ephemeral" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.completeSuccessfulRun = mock(async () => {});

    try {
      await internals.runTask({
        ...resolvedTask(),
        agentConfig: {
          provider: { google: { apiKey: "test-key" } },
          model: { provider: "google", modelId: "gemini-test" },
        },
      });

      expect(boundary).toHaveBeenCalledTimes(1);
      expect(internals.completeSuccessfulRun).toHaveBeenCalledTimes(1);
      expect(mutations).toEqual([]);
      expect(queries).not.toContain("listConversationEvents");
    } finally {
      boundary.mockRestore();
      await mock.module("ai", () => ({
        ...ai,
        streamText: previousStreamText,
      }));
      globalThis.fetch = originalFetch;
      setStorageForTests(null);
      runtime.mutate = originalMutation;
      runtime.query = originalQuery;
    }
  });

  it("tells a child its budget and stops it with the parent's user stop", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(true);
    const { USER_STOP_MESSAGE } = await import("../src/harness/harness.ts");
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "ephemeral" } },
      Date.now() + 60_000,
      { lifecycle: { emit: async (): Promise<void> => {} } },
    );
    let instructions = "";
    let stopReason: unknown;
    const previousStreamText = ai.streamText;
    const streamText = mock(
      (options: {
        abortSignal: AbortSignal;
        instructions: Array<{ content: string }>;
      }): { stream: ReadableStream; consumeStream(): Promise<void> } => {
        instructions = options.instructions
          .map((message): string => message.content)
          .join("\n");
        coordinator.stopChildren();
        stopReason = options.abortSignal.reason;

        return {
          stream: new ReadableStream({ start: (c): void => c.close() }),
          consumeStream: async (): Promise<void> => {},
        };
      },
    );
    await mock.module("ai", (): Record<string, unknown> => ({
      ...ai,
      streamText: streamText,
    }));

    try {
      await coordinator["runTask"]({
        ...resolvedTask(),
        runId: CHILD_RUN_ID,
        isolatedSandbox: false,
        agentConfig: {
          provider: { google: { apiKey: "test-key" } },
          model: { provider: "google", modelId: "gemini-test" },
        },
      }).catch((): void => {});

      expect(instructions).toContain("15-minute budget");
      expect(stopReason).toEqual(new Error(USER_STOP_MESSAGE));
    } finally {
      await mock.module("ai", (): Record<string, unknown> => ({
        ...ai,
        streamText: previousStreamText,
      }));
      mutate.mockRestore();
    }
  });

  it("stops the children when the parent is stopped while it waits", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession({
        renewConversationLease: async (): Promise<string> => "stopped",
      }),
      {},
      // The first heartbeat comes at the wait budget.
      Date.now() + 50,
    );
    coordinator["pending"].set("subagent_1", new Promise((): void => {}));
    // The heartbeat ends this wait; a stopped child leaves on its own.
    coordinator["childStop"].signal.addEventListener("abort", (): void => {
      coordinator["pending"].delete("subagent_1");
      coordinator["notifyCompletion"]();
    });

    expect(await coordinator.waitForIdle()).toBe("idle");
    expect(coordinator["childStop"].signal.aborted).toBe(true);
  });

  it("rejects coordinator-level conversation keys in ephemeral mode", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      {
        accountId: "account_1",
        agentId: "agent_parent",
        eventId: "event_parent",
        persistModelMessages: mock(async () => []),
      } as never,
      {
        subagent: {
          enabled: true,
          mode: "ephemeral",
        },
      },
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    expect(
      internals.resolveTask(
        {
          prompt: "continue",
          conversationKey: "subagent-persistent-existing",
        },
        [],
        [],
      ),
    ).rejects.toThrow(
      "Subagent conversationKey is only supported in persistent mode",
    );
  });
});

function completion(taskId: string, response: unknown): TestCompletion {
  return {
    taskId: taskId,
    eventId: `event_${taskId}`,
    agentId: `agent_${taskId}`,
    conversationKey: `conversation_${taskId}`,
    status: "completed",
    response: response,
  };
}

// A child's identity and the result it finishes with, typed for the coordinator.
function lateChild(): {
  taskId: string;
  eventId: string;
  agentId: string;
  conversationKey: string;
  response: string;
} {
  return {
    taskId: "subagent_1",
    eventId: "event_subagent_1",
    agentId: "agent_subagent_1",
    conversationKey: "conversation_subagent_1",
    response: "the late answer",
  };
}

const LOST_TASK_IDS = new Map<string, string>();

// A finished subagent row a parent stopped waiting on, the same for each
// `name`: its task, and so its parent conversation, is its own.
describe("message-agents in the coordinator", () => {
  const UUID = "11111111-2222-4333-8444-555555555555";

  async function persistentCoordinator(
    mutate: (name: string, args: Record<string, unknown>) => unknown,
  ) {
    spyOn(runtime, "mutate").mockImplementation(
      mock(async (name: string, args: Record<string, unknown>) =>
        mutate(name, args),
      ) as never,
    );
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      { lifecycle: { emit: mock(async () => {}) } as never },
    );
    const key: string = coordinator["mintChildKey"]("account_1", UUID);
    const dispatched: Array<Record<string, unknown>> = [];
    coordinator.dispatch = mock(
      async (tasks: Array<Record<string, unknown>>) => {
        dispatched.push(...tasks);

        return { tasks: [] };
      },
    ) as never;

    return {
      coordinator: coordinator,
      internals: coordinator as unknown as CoordinatorInternals,
      address: `virtual_subagent_${UUID}/${key}`,
      key: key,
      dispatched: dispatched,
    };
  }

  function agentMessage(overrides: Record<string, unknown> = {}) {
    return {
      text: "status?",
      exchangeId: "ex_1",
      followUp: false,
      ...overrides,
    };
  }

  it("steers a running child, then stops waiting on it at the wait's end", async () => {
    const accepted: Array<Record<string, unknown>> = [];
    const { coordinator, internals, address, key } =
      await persistentCoordinator((name, args) => {
        if (name === "acceptIngress") accepted.push(args);

        return name === "acceptIngress" ? { outcome: "queued" } : true;
      });
    internals.pending.set("subagent_1", new Promise<void>(() => {}));
    internals.pendingMetadata.set("subagent_1", {
      taskId: "subagent_1",
      eventId: "event_1",
      agentId: `virtual_subagent_${UUID}`,
      conversationKey: key,
    });

    expect(
      await coordinator.messageChild(
        address,
        agentMessage({ waitSeconds: 0.02 }),
      ),
    ).toMatchObject({ status: "delivered", exchangeId: "ex_1" });
    expect(accepted[0]).toMatchObject({
      activeOwnerOnly: true,
      requestedMode: "steer",
      conversationKey: `acct:account_1:agent:virtual_subagent_${UUID}:api:${key}`,
    });
    expect(await coordinator.waitForIdle()).toBe("idle");
    expect(internals.completions).toEqual([
      expect.objectContaining({ taskId: "subagent_1", status: "running" }),
    ]);
  });

  it("resumes an idle child, and refuses once the family spent its wake budget", async () => {
    const { coordinator, address, dispatched } = await persistentCoordinator(
      (name) => (name === "acceptIngress" ? { outcome: "not_running" } : true),
    );

    expect(
      await coordinator.messageChild(address, agentMessage()),
    ).toMatchObject({ status: "resumed" });
    expect(dispatched[0]).toEqual({
      conversationKey: address.slice(address.indexOf("/") + 1),
      prompt: expect.stringContaining("status?"),
    });
    for (let index = 1; index < 40; index += 1) {
      await coordinator.messageChild(address, agentMessage());
    }
    expect(
      await coordinator.messageChild(address, agentMessage()),
    ).toMatchObject({ status: "not_delivered" });
    expect(dispatched).toHaveLength(40);
  });

  it("refuses an address this parent did not mint", async () => {
    const { coordinator } = await persistentCoordinator(() => true);

    expect(
      coordinator.messageChild(
        `virtual_subagent_${UUID}/subagent-persistent-${UUID}-${"0".repeat(32)}`,
        agentMessage(),
      ),
    ).rejects.toThrow("not the address of one of your persistent subagents");
    expect(
      coordinator.messageChild("no-slash", agentMessage()),
    ).rejects.toThrow("not the address");
  });

  it("wakes a child its parent left unanswered past the wait, unless the parent messages it first", async () => {
    const { internals, coordinator, address, dispatched } =
      await persistentCoordinator((name) =>
        name === "acceptIngress" ? { outcome: "not_running" } : true,
      );
    const task = {
      ...persistentChildTask(),
      agentId: `virtual_subagent_${UUID}`,
      publicConversationKey: address.slice(address.indexOf("/") + 1),
    };
    const childSession = {
      persistModelMessages: async (): Promise<void> => {},
      settleIngress: async (): Promise<boolean> => true,
      takeNextIngress: async (): Promise<null> => null,
      releaseConversationLease: async (): Promise<void> => {},
    };

    await internals.completeAskedRun(
      childSession,
      task,
      agentMessage({ waitSeconds: 0.02 }),
    );
    await Bun.sleep(60);
    expect(dispatched).toEqual([
      {
        conversationKey: task.publicConversationKey,
        prompt: expect.stringContaining("No reply from your parent"),
      },
    ]);

    await internals.completeAskedRun(
      childSession,
      task,
      agentMessage({ waitSeconds: 0.05 }),
    );
    await coordinator.messageChild(address, agentMessage({ text: "go ahead" }));
    await Bun.sleep(80);
    expect(dispatched.map(({ prompt }) => String(prompt))).toEqual([
      expect.stringContaining("No reply from your parent"),
      expect.stringContaining("go ahead"),
    ]);
  });

  it("hands a child's note to the parent's next step, and refuses it once passes ended", async () => {
    const { coordinator, internals, key } = await persistentCoordinator(
      () => true,
    );
    internals.pendingMetadata.set("subagent_1", {
      taskId: "subagent_1",
      eventId: "event_1",
      agentId: `virtual_subagent_${UUID}`,
      conversationKey: key,
    });

    expect(
      coordinator.noteFromChild(
        "subagent_1",
        agentMessage({ text: "halfway" }),
      ),
    ).toMatchObject({ status: "delivered" });
    const [note] = await coordinator.takeParentMessages();
    expect(messageText(note)).toContain("halfway");
    expect(messageText(note)).toContain(`virtual_subagent_${UUID}/${key}`);

    coordinator.closePasses();
    expect(
      coordinator.noteFromChild("subagent_1", agentMessage()),
    ).toMatchObject({ status: "not_delivered" });
  });
});

function lostRow(name: string): AsyncAgentResultRecord {
  const taskId =
    LOST_TASK_IDS.get(name) ??
    createSubagentTaskId(
      scopedDirectEventId("account_1", "agent_parent", "event_parent"),
    );
  LOST_TASK_IDS.set(name, taskId);
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  return {
    accountId: "account_1",
    eventId: scopedDirectEventId("account_1", "agent_child", taskId),
    conversationKey: scopedDirectConversationKey(
      "account_1",
      "agent_child",
      `subagent-${name}`,
    ),
    subagent: {
      parentConversationKey: scopedDirectConversationKey(
        "account_1",
        "agent_parent",
        name,
      ),
    },
    handback: "detached",
    status: "completed",
    response: `the answer of ${name}`,
    createdAt: longAgo,
    updatedAt: longAgo,
    expiresAt: Date.now() + 60_000,
  };
}

// Every lost result's parent agent still exists.
async function lostParent(
  _accountId: string,
  _agentId: string,
  conversationKey: string,
): Promise<ReentryTarget> {
  return { agentConfig: {}, conversationKey: conversationKey };
}

const CHILD_RUN_ID = `run_${"c".repeat(32)}`;

function persistentChildTask() {
  return {
    taskId: "subagent~task_1",
    runId: CHILD_RUN_ID,
    eventId: "acct:account_1:agent:agent_child:api:subagent~task_1",
    agentId: "agent_child",
    agentConfig: {},
    publicConversationKey: "subagent-persistent-1",
    conversationKey:
      "acct:account_1:agent:agent_child:api:subagent-persistent-1",
    prompt: "research",
    inheritedContext: false,
    parentMessages: [],
    parentEphemeralSystem: [],
    persistent: true,
    resuming: false,
  };
}

function parentSession(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "account_1",
    agentId: "agent_parent",
    eventId: "acct:account_1:agent:agent_parent:api:event_parent",
    persistModelMessages: mock(async () => []),
    renewConversationLease: async (): Promise<string> => "renewed",
    ...overrides,
  } as never;
}

function recordingPublisher(): NatsPublisher & {
  events: Record<string, unknown>[];
  timeline: string[];
} {
  const events: Record<string, unknown>[] = [];
  const timeline: string[] = [];

  return {
    events: events,
    timeline: timeline,
    publish: async (data) => {
      events.push(data);
      timeline.push(`publish:${String(data.type)}`);
    },
    close: async () => {
      timeline.push("close");
    },
  };
}

function resolvedTask() {
  return {
    taskId: "subagent_1",
    eventId: "account_1:agent_child:subagent_1",
    agentId: "agent_child",
    agentConfig: {},
    publicConversationKey: "subagent-subagent_1",
    conversationKey: "account_1:agent_child:api:subagent-subagent_1",
    prompt: "research",
    inheritedContext: false,
    parentMessages: [],
    parentEphemeralSystem: [],
    persistent: false,
    resuming: false,
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

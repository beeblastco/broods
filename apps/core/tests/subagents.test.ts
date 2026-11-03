import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
  type Mock,
} from "bun:test";
import * as ai from "ai";
import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import * as asyncAgentResults from "../src/harness/async-agent-result.ts";
import type { SweptHandback } from "@broods/convex/model/subagentResults";
import type { AsyncAgentResultRecord } from "../src/harness/async-agent-result.ts";
import * as harness from "../src/harness/harness.ts";
import type { AgentLoopOptions } from "../src/harness/harness.ts";
import * as hookDispatcher from "../src/harness/hook-dispatcher.ts";
import * as ingress from "../src/harness/ingress.ts";
import type { IngressCandidate } from "../src/harness/ingress.ts";
import type { ReentryTarget } from "../src/harness/integrations.ts";
import { Session } from "../src/harness/session.ts";
import type {
  SubagentCoordinator,
  SubagentCoordinatorDependencies,
  SubagentResumeOutcome,
} from "../src/harness/subagents.ts";
import type { AgentMessage } from "../src/harness/tools/utils.ts";
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
  readonly outbox: Array<{ completion?: TestCompletion }>;
  enqueue(completion: TestCompletion): void;
  pending: Map<string, Promise<void>>;
  recorded: Set<string>;
  pendingMetadata: Map<
    string,
    Omit<TestCompletion, "status" | "response" | "error">
  >;
  completeTask: (completion: TestCompletion) => Promise<void>;
  completeRun: (
    childSession: unknown,
    task: unknown,
    finish: { status: "completed"; response: unknown },
  ) => Promise<TestCompletion>;
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
  ): Promise<TestCompletion | void>;
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
  ): Promise<{ ownerGeneration: number; charged: boolean }>;
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
      const keyUuid = /^subagent-persistent-([0-9a-f-]{36})-/.exec(
        task.conversationKey,
      )?.[1];
      expect(task.agentId).toBe(`virtual_subagent_${keyUuid}`);
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

      return completedTurn();
    });
    internals.completeTask = mock(async (): Promise<void> => {});

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

      return completedTurn();
    });
    internals.completeTask = mock(async () => {});

    internals.startTask(resolvedTask());

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(internals.completeTask).toHaveBeenCalledWith(
      completedTurn(),
      coordinator,
    );
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
      internals.enqueue(completion("subagent_1", "first result"));
      internals.pending.delete("subagent_1");
      internals.notifyCompletion();
    }, 5);
    setTimeout(() => {
      internals.enqueue(completion("subagent_2", "second result"));
      internals.pending.delete("subagent_2");
      internals.notifyCompletion();
    }, 15);

    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(coordinator.pendingCount).toBe(0);

    expect(coordinator.drainCompletionsToParent()).resolves.toBe(2);
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
    expect(await coordinator.waitForIdle()).toBe("message");
    const [question] = await coordinator.takeParentMessages();
    expect(messageText(question)).toContain("Which account?");
    expect(messageText(question)).toContain(
      "conversationKey: child_subagent_1",
    );
    expect(messageText(question)).toContain(
      'message-agents to "agent_research/child_subagent_1"',
    );
    expect(question?.dedupeKey).toBe(
      "subagent:event_subagent_1:awaiting_input",
    );
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
    internals.enqueue(completion("subagent_1", "finished"));

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
        _options?: { onSaved?: (saved: number) => void },
      ): Promise<never[]> => [],
    );
    // A write too large for one append saves its first append, then fails.
    persistModelMessages.mockImplementationOnce(
      async (_messages, options): Promise<never[]> => {
        options?.onSaved?.(1);
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
    internals.enqueue(completion("subagent_1", "first"));
    internals.enqueue(completion("subagent_2", "second"));

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
      internals.enqueue(completion("subagent_1", "finished"));
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
      expect(await coordinator.waitForIdle()).toBe("message");

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
        _options?: { onSaved?: (saved: number) => void },
      ): Promise<never[]> => [],
    );
    persistModelMessages.mockImplementationOnce(
      async (_messages, options): Promise<never[]> => {
        options?.onSaved?.(1);
        throw new Error("convex down");
      },
    );
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
        _message: UserModelMessage,
        _resultEventId: string | undefined,
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
    coordinator["enqueue"]({
      ...task("subagent_1"),
      status: "completed",
      response: "saved",
    });
    coordinator["enqueue"]({
      ...task("subagent_2"),
      status: "completed",
      response: "unsaved",
    });
    coordinator["enqueue"]({
      ...task("subagent_3"),
      status: "failed",
      error: "unsaved failure",
    });
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
      await coordinator["completeTask"]({
        ...running,
        status: "completed",
        response: "late report",
      });

      // No pass drains after the expiry write: each unsaved result resumes the parent once.
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
        _message: UserModelMessage,
        _resultEventId: string | undefined,
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
    coordinator["enqueue"]({
      taskId: "subagent_1",
      eventId: "event_subagent_1",
      agentId: "agent_research",
      conversationKey: "subagent-subagent_1",
      status: "completed",
      response: "idle report",
    });
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
    coordinator["enqueue"]({
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
      (): Promise<never> =>
        new Promise<never>((resolve): void => {
          finish = (): void => resolve(completedTurn() as never);
        }),
    );
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

    internals.enqueue(completion("subagent_1", "finished before timeout"));
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
        _resultEventId: string | undefined,
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
      // Saving it under the result's key stores the result.
      expect(message).toMatchObject({
        dedupeKey: `subagent:${late.eventId}:completed`,
      });
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
    ).mockResolvedValue(undefined);
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
      await coordinator["completeTask"]({ ...answered, status: "completed" });
      expect(await coordinator.drainCompletionsToParent()).toBe(1);
      await coordinator.drainCompletionsAndDetachToParent();

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
    ).mockResolvedValue(undefined);
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
    // The first row is refused for capacity, then as a duplicate of a resume still queued.
    const refusals: SubagentResumeOutcome[] = ["capacity", "duplicate"];
    const resumed: Array<{ eventId?: string; message: string }> = [];
    const resumeParent = async (
      _parent: unknown,
      _taskId: string,
      message: UserModelMessage,
      resultEventId: string | undefined,
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

      expect(hookRuns).toBe(2);
      expect(resumed[1]).toEqual({
        eventId: lostRow("event_full").eventId,
        message: expect.stringContaining("rewritten 1"),
      });
      expect(markHandback).not.toHaveBeenCalled();
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
    ).mockResolvedValue(undefined);
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
    // Neither row was detached; only the young one's parent may still be draining it.
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
    ).mockResolvedValue(undefined);
    const info = spyOn(log, "logInfo");
    const resumed: Array<string | undefined> = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        lostParent,
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
          resultEventId: string | undefined,
        ): Promise<SubagentResumeOutcome> => {
          resumed.push(resultEventId);

          return "queued";
        },
      );

      expect(resumed).toEqual([lostRow("event_old").eventId]);
      expect(markHandback).not.toHaveBeenCalled();
      const before = (handback: SweptHandback): string =>
        windows.find((window): boolean => window.handback === handback)!
          .updatedBefore;
      expect(before("pending") < before("detached")).toBe(true);
      expect(before("pending") < minutes(15)).toBe(true);
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
    // Parents and pod died before any detach; only the young child may still be running.
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
    ).mockResolvedValue(undefined);
    const record = spyOn(
      asyncAgentResults,
      "recordAsyncAgentResult",
    ).mockResolvedValue();
    const resumed: Array<string | undefined> = [];
    const { resumeLostSubagentResults } =
      await import("../src/harness/subagents.ts");

    try {
      await resumeLostSubagentResults(
        lostParent,
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
          resultEventId: string | undefined,
        ): Promise<SubagentResumeOutcome> => {
          resumed.push(resultEventId);

          return "queued";
        },
      );

      expect(windows).toContainEqual({
        handback: "pending",
        status: "processing",
      });
      // One write, so a crash never leaves a failed row waiting out another hold.
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
    ).mockResolvedValue(undefined);
    const record = spyOn(
      asyncAgentResults,
      "recordAsyncAgentResult",
    ).mockResolvedValue();
    const resumed: Array<string | undefined> = [];
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
          resultEventId: string | undefined,
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
    coordinator["enqueue"]({ ...finished, status: "completed" });
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

    internals.enqueue(completion("subagent_1", { answer: "done" }));

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
    expect(resumed.taskId).not.toBe(created.taskId);
    expect(resumed.agentId).toBe(created.agentId);
    expect(resumed.conversationKey).toBe(created.conversationKey);
    expect(resumed.persistent).toBe(true);
    expect(resumed.resuming).toBe(true);

    // An unminted key could name another caller's direct-API conversation with the child.
    expect(
      internals.resolveTask(
        { prompt: "recount", conversationKey: "user-123" },
        [],
        [],
      ),
    ).rejects.toThrow("must be one run_subagent returned to this agent");
    // A minted-form key is pickable too: only core's tag over account and parent resumes it.
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
    internals.createChildTurnContext = async (): Promise<never> => {
      throw new Error("provider down");
    };

    try {
      internals.startTask(persistentChildTask());
      await coordinator.waitForIdle();

      const candidate = candidates[0];
      expect(candidate?.name).toBe("acceptIngress");
      expect(candidate?.accountId).toBe("account_1");
      expect(candidate?.agentId).toBe("agent_child");
      expect(candidate?.ownerTaskId).toBe("subagent~task_1");
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

  it("settles and releases an admitted child when turn context creation fails", async () => {
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
    internals.admitChildConversation = mock(async () => ({
      ownerGeneration: 7,
      charged: false,
    }));
    internals.createChildTurnContext = mock(async () => {
      throw new Error("turn context failed");
    });

    try {
      expect(internals.runTask(persistentChildTask())).rejects.toThrow(
        "turn context failed",
      );
      expect(mutations).toContain("settleIngress");
      expect(mutations).toContain("releaseIngressOwner");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("settles a completed child's envelope and row together, and keeps the row when that settle and the release fail", async () => {
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
    const releaseConversationLease = mock(async (): Promise<never> => {
      throw new Error("release failed");
    });
    const settleIngress = mock(
      async (_status: string, _options: unknown): Promise<boolean> => {
        throw new Error("settlement failed");
      },
    );
    const task = persistentChildTask();

    try {
      expect(
        await internals.completeRun(
          {
            settleIngress: settleIngress,
            releaseConversationLease: releaseConversationLease,
          },
          task,
          { status: "completed", response: "finished" },
        ),
      ).toMatchObject({ taskId: task.taskId, status: "completed" });
      expect(settleIngress).toHaveBeenCalledWith("completed", {
        result: "finished",
        asyncResult: {
          eventIds: [task.eventId],
          outcome: { status: "completed", response: "finished" },
        },
      });
      expect(mutations).toContain("updateAsyncAgentResult");
      expect(settleIngress).toHaveBeenCalledTimes(1);
      expect(releaseConversationLease).toHaveBeenCalledTimes(1);
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
      // Rejecting would let runTask mark the durable completed result failed, erasing it.
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
      expect(internals.outbox).toHaveLength(1);
      expect(internals.outbox[0]?.completion?.response).toBe("finished");
      expect(mutations).not.toContain("updateAsyncAgentResult");
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

      internals.pending.set("subagent~task_1", Promise.resolve());
      await internals.completeTask({ ...failure, error: "provider exploded" });

      expect(await coordinator.drainCompletionsToParent()).toBe(1);
    } finally {
      runtime.mutate = originalMutation;
    }
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
      ).rejects.toThrow("Subagent conversation is busy (rejected)");
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
    globalThis.fetch = mock(async () => {
      throw new Error("network is blocked in this test");
    }) as never;
    // harness.test.ts leaves its fake streamText on the shared "ai" module, so the real one is
    // out of reach; this stand-in runs the loop's first prepareStep.
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
    internals.completeRun = mock(async (): Promise<TestCompletion> =>
      completedTurn(),
    );

    try {
      await internals.runTask({
        ...resolvedTask(),
        agentConfig: {
          provider: { google: { apiKey: "test-key" } },
          model: { provider: "google", modelId: "gemini-test" },
        },
      });

      expect(boundary).toHaveBeenCalledTimes(1);
      expect(internals.completeRun).toHaveBeenCalledTimes(1);
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
        lastTurn: false,
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
  const UUID = "22222222-3333-4444-8555-666666666666";
  const PARENT_CONVERSATION = "acct:account_1:agent:agent_parent:api:conv_1";
  const PARENT_EVENT = "acct:account_1:agent:agent_parent:api:event_parent";
  const CHILD_AGENT = `virtual_subagent_${UUID}`;

  interface ParentRun {
    coordinator: SubagentCoordinator;
    resume: Mock<SubagentCoordinator["resumeChild"]>;
    key: string;
    address: string;
    turns: Map<string, number>;
  }

  // A parent run's coordinator: `eventId` names the run, the conversation is
  // shared, and `turns` is its lineage's durable message-turn count. Its
  // `resume` starts a turn unless a test says the child is busy.
  async function parentRun(options: {
    eventId?: string;
    conversationKey?: string;
    turns?: Map<string, number>;
    resumeParent?: SubagentCoordinatorDependencies["resumeParent"];
  }): Promise<ParentRun> {
    const turns = options.turns ?? new Map<string, number>();
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession({
        conversationKey: options.conversationKey ?? PARENT_CONVERSATION,
        eventId: options.eventId ?? PARENT_EVENT,
        claimMessageTurn: async (limit: number): Promise<boolean> => {
          const spent = turns.get("lineage") ?? 0;
          if (spent >= limit) return false;
          turns.set("lineage", spent + 1);

          return true;
        },
        releaseMessageTurn: async (): Promise<void> => {
          turns.set("lineage", (turns.get("lineage") ?? 1) - 1);
        },
      }),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 60_000,
      {
        lifecycle: { emit: mock(async (): Promise<void> => {}) },
        ...(options.resumeParent ? { resumeParent: options.resumeParent } : {}),
      },
    );
    const resume = spyOn(coordinator, "resumeChild").mockImplementation(
      async (_child, prompt) => resumed("owner", `subagent~${prompt.length}`),
    );
    const key: string = coordinator["mintChildKey"]("account_1", UUID);

    return {
      coordinator: coordinator,
      resume: resume,
      key: key,
      address: `${CHILD_AGENT}/${key}`,
      turns: turns,
    };
  }

  // What resumeChild returns for an admission that made turn `taskId`.
  function resumed(
    outcome: "owner" | "queued" | "capacity",
    taskId: string,
  ): Awaited<ReturnType<SubagentCoordinator["resumeChild"]>> {
    return {
      outcome: outcome,
      task: {
        taskId: taskId,
        agentId: CHILD_AGENT,
        conversationKey: "key",
        runId: CHILD_RUN_ID,
        statusPath: `/v1/runs/${CHILD_RUN_ID}`,
        status: "running" as const,
      },
    };
  }

  function childTask(publicKey: string): ReturnType<
    typeof persistentChildTask
  > & {
    isolatedSandbox: boolean;
    lastTurn: boolean;
  } {
    return {
      taskId: "subagent~task_1",
      runId: CHILD_RUN_ID,
      eventId: scopedDirectEventId("account_1", CHILD_AGENT, "subagent~task_1"),
      agentId: CHILD_AGENT,
      agentConfig: {},
      publicConversationKey: publicKey,
      conversationKey: scopedDirectConversationKey(
        "account_1",
        CHILD_AGENT,
        publicKey,
      ),
      prompt: "research",
      inheritedContext: false,
      parentMessages: [],
      parentEphemeralSystem: [],
      persistent: true,
      resuming: false,
      isolatedSandbox: false,
      lastTurn: false,
    };
  }

  function childSession(task: ReturnType<typeof childTask>): Session {
    const session = new Session({
      eventId: task.eventId,
      conversationKey: task.conversationKey,
      accountId: "account_1",
      agentId: task.agentId,
    });
    spyOn(session, "persistModelMessages").mockResolvedValue([]);
    spyOn(session, "settleIngress").mockResolvedValue(true);
    spyOn(session, "takeNextIngress").mockResolvedValue(null);
    spyOn(session, "releaseConversationLease").mockResolvedValue(undefined);

    return session;
  }

  function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
    return {
      text: "Which region?",
      exchangeId: "ex_1",
      followUp: false,
      ...overrides,
    };
  }

  // A persistent child of this parent, keyed `key`, whose turn ran as `taskId`.
  function waitingChild(
    key: string,
    taskId = "subagent_1",
  ): {
    taskId: string;
    eventId: string;
    agentId: string;
    conversationKey: string;
  } {
    return {
      taskId: taskId,
      eventId: scopedDirectEventId("account_1", CHILD_AGENT, taskId),
      agentId: CHILD_AGENT,
      conversationKey: key,
    };
  }

  // Queues `child`'s question for the parent's next write, as its latest turn ends.
  async function askedParent(
    coordinator: SubagentCoordinator,
    child: ReturnType<typeof waitingChild>,
  ): Promise<void> {
    coordinator["detached"].set(child.taskId, child);
    await coordinator["completeTask"]({
      ...child,
      status: "awaiting_input",
      question: "Which region?",
    });
  }

  // Child turns that start for real: each is admitted, then fails before its first step.
  function runChildren(coordinator: SubagentCoordinator): void {
    spyOn(asyncAgentResults, "createPendingAsyncAgentResult").mockResolvedValue(
      true,
    );
    spyOn(asyncAgentResults, "recordAsyncAgentResult").mockResolvedValue(
      undefined,
    );
    spyOn(Session.prototype, "settleIngress").mockResolvedValue(true);
    spyOn(Session.prototype, "releaseConversationLease").mockResolvedValue(
      undefined,
    );
    coordinator["createChildTurnContext"] = async (): Promise<never> => {
      throw new Error("provider down");
    };
  }

  beforeEach((): void => {
    spyOn(asyncAgentResults, "markAsyncAgentHandback").mockResolvedValue(
      undefined,
    );
  });

  afterEach((): void => {
    mock.restore();
  });

  it("records a child's wait on its parent and lets its conversation go before handing the question on", async (): Promise<void> => {
    const { coordinator, key } = await parentRun({});
    const task = childTask(key);
    const session = childSession(task);
    const settle = spyOn(session, "settleIngress").mockResolvedValue(true);
    const persist = spyOn(session, "persistModelMessages").mockResolvedValue(
      [],
    );
    const release = spyOn(session, "releaseConversationLease");

    // The caller hands it to the parent, so a reply that comes at once finds the child idle.
    expect(
      await coordinator["completeRun"](session, task, {
        status: "awaiting_input",
        message: message({ waitSeconds: 600 }),
      }),
    ).toMatchObject({
      taskId: task.taskId,
      status: "awaiting_input",
      question: "Which region?",
      exchangeId: "ex_1",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(coordinator["outbox"]).toHaveLength(0);
    // Pruning drops the message-agents call from later turns; this line survives.
    expect(persist).toHaveBeenCalledWith([
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
    expect(settle).toHaveBeenCalledWith(
      "completed",
      expect.objectContaining({
        asyncResult: {
          eventIds: [task.eventId],
          outcome: {
            status: "awaiting_input",
            question: "Which region?",
          },
        },
      }),
    );
  });

  it("resumes an idle child on its own conversation with the parent's message", async (): Promise<void> => {
    const { coordinator, key, address, resume } = await parentRun({});

    // The turn it started can be stopped and polled like run_subagent's.
    expect(
      await coordinator.messageChild(address, message({ text: "eu-west" })),
    ).toMatchObject({
      status: "resumed",
      taskId: expect.stringMatching(/^subagent~/),
      runId: CHILD_RUN_ID,
      statusPath: `/v1/runs/${CHILD_RUN_ID}`,
    });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: CHILD_AGENT,
        publicConversationKey: key,
      }),
      expect.stringContaining("eu-west"),
      true,
    );
  });

  it("refuses an address this parent did not mint", async (): Promise<void> => {
    const { coordinator } = await parentRun({});

    expect(
      coordinator.messageChild(
        `${CHILD_AGENT}/subagent-persistent-${UUID}-${"0".repeat(32)}`,
        message(),
      ),
    ).rejects.toThrow("not the address of one of your persistent subagents");
    expect(coordinator.messageChild("no-slash", message())).rejects.toThrow(
      "not the address",
    );
  });

  it("refuses a child that another conversation of the same agent started", async (): Promise<void> => {
    const { address } = await parentRun({});
    const other = await parentRun({
      conversationKey: "acct:account_1:agent:agent_parent:api:conv_2",
    });

    expect(
      other.coordinator.messageChild(address, message({ waitSeconds: 60 })),
    ).rejects.toThrow("not the address of one of your persistent subagents");
  });

  it("gives back the message turn of a message whose admission throws", async (): Promise<void> => {
    const { coordinator, address, resume, turns } = await parentRun({});
    resume.mockRestore();
    spyOn(ingress, "acceptIngress").mockRejectedValue(new Error("convex down"));

    expect(coordinator.messageChild(address, message())).rejects.toThrow(
      "convex down",
    );
    await Bun.sleep(0);

    expect(turns.get("lineage")).toBe(0);
  });

  it("charges only messages that start a turn to the turn budget", async (): Promise<void> => {
    const { coordinator, address, resume, turns } = await parentRun({});
    resume.mockRestore();
    runChildren(coordinator);
    const accept = spyOn(ingress, "acceptIngress").mockResolvedValue({
      outcome: "rejected",
    });
    for (let sent = 0; sent < 50; sent += 1) {
      await coordinator.messageChild(address, message({ waitSeconds: 60 }));
    }
    expect(turns.get("lineage")).toBe(0);

    accept.mockResolvedValue({ outcome: "owner", ownerGeneration: 1 });
    for (let sent = 0; sent < 40; sent += 1) {
      await coordinator.messageChild(address, message({ waitSeconds: 60 }));
      await coordinator.waitForIdle();
    }
    expect(
      await coordinator.messageChild(address, message({ waitSeconds: 60 })),
    ).toMatchObject({ status: "not_delivered" });
  });

  it("keeps the turn budget across the parent runs of one lineage", async (): Promise<void> => {
    const first = await parentRun({});
    for (let sent = 0; sent < 40; sent += 1) {
      await first.coordinator.messageChild(
        first.address,
        message({ waitSeconds: 60 }),
      );
    }
    const later = await parentRun({
      eventId: `${PARENT_EVENT}:async-subagent:abc`,
      turns: first.turns,
    });

    expect(
      await later.coordinator.messageChild(
        first.address,
        message({ waitSeconds: 60 }),
      ),
    ).toMatchObject({ status: "not_delivered" });
    expect(later.resume).not.toHaveBeenCalled();
  });

  it("admits a child's note to the parent's conversation before it says delivered, and refuses it once passes ended", async (): Promise<void> => {
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
        _message: UserModelMessage,
        _resultEventId: string | undefined,
      ): Promise<SubagentResumeOutcome> => "queued",
    );
    const { coordinator, key } = await parentRun({
      resumeParent: resumeParent,
    });
    const child = waitingChild(key);
    coordinator["detached"].set(child.taskId, child);

    expect(
      await coordinator.noteFromChild(
        child.taskId,
        message({ text: "halfway" }),
      ),
    ).toMatchObject({ status: "delivered" });
    const [, taskId, note, resultEventId] = resumeParent.mock.calls[0] ?? [];
    expect(taskId).toMatch(/^subagent~/);
    expect(messageText(note)).toContain("halfway");
    expect(messageText(note)).toContain(`${CHILD_AGENT}/${key}`);
    // No result row: the admission alone keeps it.
    expect(resultEventId).toBeUndefined();

    await coordinator.closePasses();
    expect(
      await coordinator.noteFromChild(child.taskId, message()),
    ).toMatchObject({ status: "not_delivered" });
    expect(resumeParent).toHaveBeenCalledTimes(1);
  });

  it("gives back the message turn of a note the parent's conversation does not take", async (): Promise<void> => {
    const resumeParent = mock(
      async (): Promise<SubagentResumeOutcome> => "capacity",
    );
    const { coordinator, key, turns } = await parentRun({
      resumeParent: resumeParent,
    });
    coordinator["pendingMetadata"].set("subagent_1", waitingChild(key));

    expect(
      await coordinator.noteFromChild("subagent_1", message()),
    ).toMatchObject({ status: "not_delivered" });
    resumeParent.mockRejectedValue(new Error("convex down"));
    expect(
      await coordinator.noteFromChild("subagent_1", message()),
    ).toMatchObject({ status: "not_delivered" });

    expect(turns.get("lineage")).toBe(0);
  });

  it("spends no message turn on a note refused because the passes ended, even as they end", async (): Promise<void> => {
    const resumeParent = mock(
      async (): Promise<SubagentResumeOutcome> => "owner",
    );
    const { coordinator, key, turns } = await parentRun({
      resumeParent: resumeParent,
    });
    const child = waitingChild(key);
    coordinator["detached"].set(child.taskId, child);
    await coordinator.closePasses();

    expect(
      await coordinator.noteFromChild(child.taskId, message()),
    ).toMatchObject({ status: "not_delivered" });
    expect(turns.get("lineage")).toBeUndefined();

    const reopened = await parentRun({ resumeParent: resumeParent });
    reopened.coordinator["detached"].set(child.taskId, child);
    // The passes end while the claim is in flight.
    spyOn(
      reopened.coordinator["parentSession"],
      "claimMessageTurn",
    ).mockImplementationOnce(async (): Promise<boolean> => {
      reopened.coordinator["closed"] = true;
      reopened.turns.set("lineage", 1);

      return true;
    });
    expect(
      await reopened.coordinator.noteFromChild(child.taskId, message()),
    ).toMatchObject({ status: "not_delivered" });
    expect(reopened.turns.get("lineage")).toBe(0);
    expect(resumeParent).not.toHaveBeenCalled();
  });

  it("wakes a child whose question the parent's passes left unanswered, once", async (): Promise<void> => {
    const { coordinator, key, resume, turns } = await parentRun({});
    await askedParent(coordinator, waitingChild(key));
    await coordinator.takeParentMessages();

    await coordinator.closePasses();
    await coordinator.closePasses();

    expect(resume.mock.calls).toEqual([
      [
        expect.objectContaining({ publicConversationKey: key }),
        expect.stringContaining("No reply from your parent"),
        true,
      ],
    ]);
    expect(turns.get("lineage")).toBe(1);
  });

  it("wakes no child the parent replied to, by message or by run_subagent", async (): Promise<void> => {
    const { coordinator, key, address, resume, turns } = await parentRun({});
    resume.mockRestore();
    // Each reply's turn ends before the passes do, so the child is idle again.
    runChildren(coordinator);
    const accept = spyOn(ingress, "acceptIngress").mockResolvedValue({
      outcome: "owner",
      ownerGeneration: 1,
    });
    const other = coordinator["mintChildKey"]("account_1", crypto.randomUUID());
    await askedParent(coordinator, waitingChild(key));
    await askedParent(coordinator, waitingChild(other, "subagent_2"));
    await coordinator.takeParentMessages();

    await coordinator.messageChild(address, message({ text: "eu-west" }));
    await coordinator.dispatch(
      [{ prompt: "eu-west", conversationKey: other }],
      [],
    );
    await coordinator.waitForIdle();
    await coordinator.closePasses();

    expect(
      accept.mock.calls.map(([candidate]): string =>
        messageText(candidate.events[0] as UserModelMessage),
      ),
    ).toEqual([expect.stringContaining("eu-west"), "eu-west"]);
    // A run_subagent resume takes a message turn like a message does.
    expect(turns.get("lineage")).toBe(2);
  });

  it("fails a run_subagent resume once the run spent its message turns, and keeps its question", async (): Promise<void> => {
    const { coordinator, key, resume } = await parentRun({
      turns: new Map([["lineage", 40]]),
    });
    runChildren(coordinator);
    const accept = spyOn(ingress, "acceptIngress");
    await askedParent(coordinator, waitingChild(key));
    await coordinator.takeParentMessages();

    await coordinator.dispatch([{ prompt: "go on", conversationKey: key }], []);
    expect(await coordinator.waitForIdle()).toBe("idle");

    expect(accept).not.toHaveBeenCalled();
    const [failure] = await coordinator.takeParentMessages();
    expect(messageText(failure)).toContain("already started 40 turns");
    await coordinator.closePasses();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("gives back the message turn and keeps the question of a run_subagent resume whose admission fails", async (): Promise<void> => {
    const { coordinator, key, resume, turns } = await parentRun({});
    runChildren(coordinator);
    spyOn(ingress, "acceptIngress").mockRejectedValue(new Error("convex down"));
    await askedParent(coordinator, waitingChild(key));
    await coordinator.takeParentMessages();

    await coordinator.dispatch([{ prompt: "go on", conversationKey: key }], []);
    await coordinator.waitForIdle();

    expect(turns.get("lineage")).toBe(0);
    await coordinator.closePasses();
    expect(resume.mock.calls[0]?.[1]).toContain("No reply from your parent");
  });

  it("still wakes a child once its run spent its message turns, with no line to its parent", async (): Promise<void> => {
    const { coordinator, key, resume } = await parentRun({
      turns: new Map([["lineage", 40]]),
    });
    await askedParent(coordinator, waitingChild(key));
    await coordinator.takeParentMessages();

    await coordinator.closePasses();

    expect(resume.mock.calls[0]?.slice(1)).toEqual([
      expect.stringContaining("no message turns left"),
      false,
    ]);
  });

  it("wakes no child after the parent's user stop", async (): Promise<void> => {
    const { coordinator, key, resume } = await parentRun({});
    await askedParent(coordinator, waitingChild(key));
    await coordinator.takeParentMessages();

    coordinator.stopChildren();
    await coordinator.closePasses();

    expect(resume).not.toHaveBeenCalled();
  });

  it("hands a detached child's question to the live pass, and wakes it only once the passes end", async (): Promise<void> => {
    const resumeParent = mock(
      async (): Promise<SubagentResumeOutcome> => "owner",
    );
    const { coordinator, key, resume } = await parentRun({
      resumeParent: resumeParent,
    });
    const child = waitingChild(key);
    coordinator["detached"].set(child.taskId, child);

    await coordinator["completeTask"]({
      ...child,
      status: "awaiting_input",
      question: "Which region?",
    });
    expect(await coordinator.waitForIdle()).toBe("message");
    await coordinator.takeParentMessages();
    expect(resume).not.toHaveBeenCalled();
    await coordinator.closePasses();

    expect(resumeParent).not.toHaveBeenCalled();
    expect(resume.mock.calls[0]?.[1]).toContain("No reply from your parent");
  });

  it("tells the parent a question that comes after its passes ended, and wakes the child at once", async (): Promise<void> => {
    const resumeParent = mock(
      async (): Promise<SubagentResumeOutcome> => "owner",
    );
    const { coordinator, key, resume, turns } = await parentRun({
      resumeParent: resumeParent,
    });
    const child = waitingChild(key);
    coordinator["detached"].set(child.taskId, child);
    await coordinator.closePasses();

    await coordinator["completeTask"]({
      ...child,
      status: "awaiting_input",
      question: "Which region?",
    });

    expect(resumeParent).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[1]).toContain("No reply from your parent");
    // The parent's new turn and the child's each take a message turn.
    expect(turns.get("lineage")).toBe(2);
  });

  it("resumes the parent with a later turn's result under that turn's own row", async (): Promise<void> => {
    const resumeParent = mock(
      async (
        _parent: unknown,
        _taskId: string,
      ): Promise<SubagentResumeOutcome> => "owner",
    );
    const { coordinator, key, turns } = await parentRun({
      resumeParent: resumeParent,
    });
    coordinator.attachHooks({ runMutation: async () => undefined } as never);
    const first = waitingChild(key, createSubagentTaskId(PARENT_EVENT));
    const laterTurn = createSubagentTaskId(PARENT_EVENT);
    coordinator["detached"].set(first.taskId, first);

    await coordinator["completeTask"]({
      ...first,
      status: "completed",
      response: "first",
    });
    // A later turn runs under its first turn's taskId, on its own row.
    await coordinator["completeTask"]({
      ...first,
      eventId: scopedDirectEventId("account_1", CHILD_AGENT, laterTurn),
      status: "completed",
      response: "second",
    });

    expect(resumeParent.mock.calls.map(([, taskId]) => taskId)).toEqual([
      first.taskId,
      laterTurn,
    ]);
    // A result is no message: it takes no message turn.
    expect(turns.get("lineage")).toBeUndefined();
  });

  it("charges a child's note to the message turns, and refuses it once they are spent", async (): Promise<void> => {
    const { coordinator, key, turns } = await parentRun({
      turns: new Map([["lineage", 39]]),
      resumeParent: async (): Promise<SubagentResumeOutcome> => "queued",
    });
    coordinator["pendingMetadata"].set("subagent_1", waitingChild(key));

    expect(
      await coordinator.noteFromChild("subagent_1", message({ text: "a" })),
    ).toMatchObject({ status: "delivered" });
    expect(turns.get("lineage")).toBe(40);
    expect(
      await coordinator.noteFromChild("subagent_1", message({ text: "b" })),
    ).toMatchObject({
      status: "not_delivered",
      note: expect.stringContaining("already started 40 turns"),
    });
  });

  it("settles and releases a child admitted for a message whose turn fails to start", async (): Promise<void> => {
    const { coordinator, key, resume } = await parentRun({});
    resume.mockRestore();
    spyOn(ingress, "acceptIngress").mockResolvedValue({
      outcome: "owner",
      ownerGeneration: 7,
    });
    coordinator["launch"] = mock(async (): Promise<never> => {
      throw new Error("row write failed");
    });
    const settle = spyOn(Session.prototype, "settleIngress").mockResolvedValue(
      true,
    );
    const release = spyOn(
      Session.prototype,
      "releaseConversationLease",
    ).mockResolvedValue(undefined);
    const child = await coordinator.resolveAddress(`${CHILD_AGENT}/${key}`);

    expect(coordinator.resumeChild(child, "eu-west", false)).rejects.toThrow(
      "row write failed",
    );
    await Bun.sleep(0);

    expect(settle).toHaveBeenCalledWith("failed", {
      error: "row write failed",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("a message to a live child", () => {
    interface ChildTurn {
      prompt: string;
      options: AgentLoopOptions;
      answer(text: string): void;
      ask(text: string): void;
    }

    interface ChildRuntime {
      turns: ChildTurn[];
      // Each child conversation's owner task id.
      owners: Map<string, string | undefined>;
    }

    // Stopped after each test: a child still live here would be live in the next test too.
    const running: SubagentCoordinator[] = [];

    afterEach(async (): Promise<void> => {
      for (const coordinator of running.splice(0)) {
        coordinator.stopChildren();
        await until((): boolean => coordinator.runningCount === 0);
      }
    });

    // Durable ingress in memory, and child turns the test ends by hand.
    function childRuntime(coordinators: SubagentCoordinator[]): ChildRuntime {
      running.push(...coordinators);
      const runtimeState: ChildRuntime = {
        turns: [],
        owners: new Map(),
      };
      let generation = 0;
      spyOn(ingress, "acceptIngress").mockImplementation(
        async (
          candidate: IngressCandidate,
        ): Promise<ingress.IngressAdmission> => {
          const key = candidate.conversationKey;
          if (runtimeState.owners.get(key) !== undefined) {
            return { outcome: "rejected" };
          }
          runtimeState.owners.set(key, candidate.ownerTaskId ?? "");
          generation += 1;

          return { outcome: "owner", ownerGeneration: generation };
        },
      );
      spyOn(Session.prototype, "releaseConversationLease").mockImplementation(
        async function (this: Session): Promise<void> {
          runtimeState.owners.set(this.conversationKey, undefined);
        },
      );
      spyOn(Session.prototype, "settleIngress").mockResolvedValue(true);
      spyOn(Session.prototype, "persistModelMessages").mockResolvedValue([]);
      spyOn(
        asyncAgentResults,
        "createPendingAsyncAgentResult",
      ).mockResolvedValue(true);
      spyOn(asyncAgentResults, "recordAsyncAgentResult").mockResolvedValue(
        undefined,
      );
      for (const coordinator of coordinators) {
        coordinator["createChildTurnContext"] = async (
          _session: unknown,
          _task: unknown,
          incoming: ModelMessage[],
        ): Promise<never> => ({ messages: incoming }) as never;
        coordinator.attachHooks({
          runMutation: async (): Promise<undefined> => undefined,
        } as never);
      }
      spyOn(harness, "runAgentLoop").mockImplementation(
        async (
          _session,
          turnContext,
          _config,
          reply,
          options: AgentLoopOptions | undefined,
        ): Promise<harness.AgentLoopStream> => {
          let question: AgentMessage | undefined;
          let end: (answer: string | undefined) => void = (): void => {};
          const ended = new Promise<string | undefined>(
            (resolve, reject): void => {
              end = resolve;
              options?.abortSignal?.addEventListener("abort", (): void =>
                reject(options.abortSignal?.reason),
              );
            },
          );
          runtimeState.turns.push({
            prompt: messageText(turnContext.messages[0] as UserModelMessage),
            options: options ?? {},
            answer: (text: string): void => end(text),
            ask: (text: string): void => {
              question = message({ text: text });
              end(undefined);
            },
          });

          return {
            consumeStream: async (): Promise<void> => {
              const answer = await ended;
              if (answer !== undefined) await reply?.onFinalText(answer);
            },
            didFail: (): boolean => false,
            failureText: (): null => null,
            parentQuestion: (): AgentMessage | undefined => question,
          } as never;
        },
      );

      return runtimeState;
    }

    async function until(condition: () => boolean): Promise<void> {
      for (let tries = 0; tries < 200 && !condition(); tries += 1) {
        await Bun.sleep(1);
      }
      expect(condition()).toBe(true);
    }

    // A persistent child of `run`, started by run_subagent and still in its first turn.
    async function liveChild(
      run: ParentRun,
      runtimeState: ChildRuntime,
    ): Promise<{ taskId: string; address: string; conversationKey: string }> {
      run.resume.mockRestore();
      const { tasks } = await run.coordinator.dispatch(
        [{ prompt: "research" }],
        [],
      );
      const [task] = tasks;
      await until((): boolean => runtimeState.turns.length === 1);

      return {
        taskId: task?.taskId ?? "",
        address: task?.address ?? "",
        conversationKey: scopedDirectConversationKey(
          "account_1",
          task?.agentId ?? "",
          task?.conversationKey ?? "",
        ),
      };
    }

    it("steers a live child at its next step, without cutting a wait short", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);

      expect(
        await run.coordinator.messageChild(
          child.address,
          message({ waitSeconds: 0.02 }),
        ),
      ).toMatchObject({ status: "delivered", exchangeId: "ex_1" });
      const steered =
        (await runtimeState.turns[0]?.options.subagentWatch?.takeParentMessages()) ??
        [];

      expect(steered.map(messageText)).toEqual([
        expect.stringContaining("Which region?"),
      ]);
      expect(run.coordinator["waitDeadlines"].size).toBe(0);
      expect(run.coordinator.pendingCount).toBe(1);
    });

    it("tells a later parent run that a child an earlier run left running replies later", async (): Promise<void> => {
      const earlier = await parentRun({});
      const later = await parentRun({
        eventId: `${PARENT_EVENT}:async-subagent:abc`,
      });
      const runtimeState = childRuntime([earlier.coordinator]);
      const child = await liveChild(earlier, runtimeState);

      expect(
        await later.coordinator.messageChild(
          child.address,
          message({ waitSeconds: 60 }),
        ),
      ).toMatchObject({
        status: "delivered",
        note: expect.stringContaining("arrives as a later message"),
      });
      expect(later.coordinator.pendingCount).toBe(0);
      expect(await later.coordinator.waitForIdle()).toBe("idle");
    });

    it("starts at most one turn when two senders find the child idle: the later one's message reaches that turn", async (): Promise<void> => {
      const run = await parentRun({});
      run.resume.mockRestore();
      const runtimeState = childRuntime([run.coordinator]);

      // Sent in one step, as parallel tool calls.
      expect(
        await Promise.all([
          run.coordinator.messageChild(
            run.address,
            message({ text: "a reply" }),
          ),
          run.coordinator.messageChild(
            run.address,
            message({ text: "no reply in time" }),
          ),
        ]),
      ).toMatchObject([{ status: "resumed" }, { status: "delivered" }]);
      await until((): boolean => runtimeState.turns.length === 1);
      const steered =
        (await runtimeState.turns[0]?.options.subagentWatch?.takeParentMessages()) ??
        [];

      expect(runtimeState.turns[0]?.prompt).toContain("a reply");
      expect(steered.map(messageText)).toEqual([
        expect.stringContaining("no reply in time"),
      ]);
      expect(run.turns.get("lineage")).toBe(1);
    });

    it("runs a message that reaches a finishing child as its task's next turn, under the task's id", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);

      await run.coordinator.messageChild(
        child.address,
        message({ text: "eu-west" }),
      );
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);

      expect(runtimeState.turns[1]?.prompt).toContain("eu-west");
      // stop_subagent stops the owner whose task id it names.
      expect(runtimeState.owners.get(child.conversationKey)).toBe(child.taskId);
    });

    it("hands back a later turn's result after the parent stops waiting on its task", async (): Promise<void> => {
      const resumeParent = mock(
        async (
          _parent: unknown,
          _taskId: string,
          _message: UserModelMessage,
        ): Promise<SubagentResumeOutcome> => "owner",
      );
      const run = await parentRun({ resumeParent: resumeParent });
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);

      await run.coordinator.messageChild(child.address, message());
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);
      await run.coordinator.drainCompletionsAndDetachToParent();
      runtimeState.turns[1]?.answer("second");
      await until((): boolean => resumeParent.mock.calls.length === 1);

      expect(messageText(resumeParent.mock.calls[0]?.[2])).toContain("second");
    });

    it("never queues a message on a child conversation another runtime holds", async (): Promise<void> => {
      const run = await parentRun({});
      run.resume.mockRestore();
      const runtimeState = childRuntime([run.coordinator]);
      const child = await run.coordinator.resolveAddress(run.address);
      runtimeState.owners.set(child.conversationKey, "subagent~elsewhere");

      expect(
        await run.coordinator.messageChild(run.address, message()),
      ).toMatchObject({
        status: "not_delivered",
        note: expect.stringMatching(/try again/i),
      });
      await run.coordinator.dispatch(
        [{ prompt: "go on", conversationKey: run.key }],
        [],
      );
      await run.coordinator.waitForIdle();

      expect(run.turns.get("lineage")).toBe(0);
    });

    it("wakes no child whose question a later message reached", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);

      await run.coordinator.messageChild(
        child.address,
        message({ text: "eu-west" }),
      );
      runtimeState.turns[0]?.ask("Which region?");
      await until((): boolean => runtimeState.turns.length === 2);
      runtimeState.turns[1]?.answer("done");
      await run.coordinator.waitForIdle();
      await run.coordinator.takeParentMessages();
      await run.coordinator.closePasses();
      await Bun.sleep(5);

      expect(
        runtimeState.turns.map((turn): string => turn.prompt).join("\n"),
      ).not.toContain("No reply from your parent");
    });

    it("charges a later turn to the run that sent the message, not the one that started the task", async (): Promise<void> => {
      const older = await parentRun({ turns: new Map([["lineage", 40]]) });
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);

      await newer.coordinator.messageChild(child.address, message());
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);

      expect(newer.turns.get("lineage")).toBe(1);
      expect(older.turns.get("lineage")).toBe(40);
      // Paid for, so the child keeps its line to its parent.
      expect(runtimeState.turns[1]?.options.parentLink).toBeDefined();
    });

    it("runs a later turn its sender cannot pay for with no line to the parent, instead of failing it", async (): Promise<void> => {
      const run = await parentRun({ turns: new Map([["lineage", 40]]) });
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);

      await run.coordinator.messageChild(
        child.address,
        message({ text: "eu-west" }),
      );
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);

      expect(runtimeState.turns[1]?.prompt).toContain("eu-west");
      expect(runtimeState.turns[1]?.options.parentLink).toBeUndefined();
      expect(run.turns.get("lineage")).toBe(40);
    });

    it("refuses a message that waited on a turn whose admission another runtime refused", async (): Promise<void> => {
      const run = await parentRun({});
      run.resume.mockRestore();
      const runtimeState = childRuntime([run.coordinator]);
      const child = await run.coordinator.resolveAddress(run.address);
      runtimeState.owners.set(child.conversationKey, "subagent~elsewhere");

      expect(
        await Promise.all([
          run.coordinator.messageChild(run.address, message({ text: "a" })),
          run.coordinator.messageChild(run.address, message({ text: "b" })),
        ]),
      ).toMatchObject([
        { status: "not_delivered" },
        { status: "not_delivered" },
      ]);
      expect(run.turns.get("lineage")).toBe(0);
    });

    it("starts no later turn, and keeps its message turn, when the parent stops during its claim", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);
      const claim = spyOn(run.coordinator["parentSession"], "claimMessageTurn");

      await run.coordinator.messageChild(child.address, message());
      claim.mockImplementation(async (): Promise<boolean> => {
        run.coordinator.stopChildren();
        run.turns.set("lineage", (run.turns.get("lineage") ?? 0) + 1);

        return true;
      });
      runtimeState.turns[0]?.answer("first");
      await run.coordinator.waitForIdle();
      await Bun.sleep(5);

      expect(runtimeState.turns).toHaveLength(1);
      expect(run.turns.get("lineage")).toBe(0);
    });

    it("refuses a message that waited on a later turn whose admission another runtime took", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);
      const claim = spyOn(run.coordinator["parentSession"], "claimMessageTurn");
      let pay = (_paid: boolean): void => {};
      claim.mockImplementationOnce(
        (): Promise<boolean> =>
          new Promise((resolve): void => {
            pay = resolve;
          }),
      );

      await run.coordinator.messageChild(child.address, message({ text: "a" }));
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => claim.mock.calls.length === 1);
      const late = run.coordinator.messageChild(
        child.address,
        message({ text: "b" }),
      );
      await Bun.sleep(1);
      runtimeState.owners.set(child.conversationKey, "subagent~elsewhere");
      pay(true);

      expect(await late).toMatchObject({ status: "not_delivered" });
      expect(runtimeState.turns).toHaveLength(1);
    });

    it("refuses a message sent while a new child's admission is pending, once another runtime takes it", async (): Promise<void> => {
      const run = await parentRun({});
      run.resume.mockRestore();
      const runtimeState = childRuntime([run.coordinator]);
      const child = await run.coordinator.resolveAddress(run.address);
      let admit = (_admission: ingress.IngressAdmission): void => {};
      spyOn(ingress, "acceptIngress").mockImplementationOnce(
        (): Promise<ingress.IngressAdmission> =>
          new Promise((resolve): void => {
            admit = resolve;
          }),
      );

      await run.coordinator.dispatch(
        [{ prompt: "research", conversationKey: run.key }],
        [],
      );
      const sent = run.coordinator.messageChild(run.address, message());
      await Bun.sleep(1);
      runtimeState.owners.set(child.conversationKey, "subagent~elsewhere");
      admit({ outcome: "rejected" });

      expect(await sent).toMatchObject({ status: "not_delivered" });
      await run.coordinator.waitForIdle();
      const failures = await run.coordinator.takeParentMessages();
      expect(failures).toHaveLength(1);
      expect(runtimeState.turns).toHaveLength(0);
    });

    it("stops a later turn with the run that sent its message", async (): Promise<void> => {
      const older = await parentRun({});
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);

      await newer.coordinator.messageChild(child.address, message());
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);
      newer.coordinator.stopChildren();

      expect(runtimeState.turns[1]?.options.abortSignal?.aborted).toBe(true);
    });

    it("starts no later turn for a message whose run stopped before the turn ended", async (): Promise<void> => {
      const older = await parentRun({});
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);

      await newer.coordinator.messageChild(child.address, message());
      newer.coordinator.stopChildren();
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => older.coordinator.runningCount === 0);

      expect(runtimeState.turns).toHaveLength(1);
      expect(newer.turns.get("lineage")).toBeUndefined();
    });

    it("lets a later turn note the parent on the turns of the run that pays for it", async (): Promise<void> => {
      const resumeParent = mock(
        async (): Promise<SubagentResumeOutcome> => "queued",
      );
      const older = await parentRun({
        turns: new Map([["lineage", 40]]),
        resumeParent: resumeParent,
      });
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
        resumeParent: resumeParent,
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);

      await newer.coordinator.messageChild(child.address, message());
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);

      expect(
        await runtimeState.turns[1]?.options.parentLink?.note(
          message({ text: "halfway" }),
        ),
      ).toMatchObject({ status: "delivered" });
      expect(newer.turns.get("lineage")).toBe(2);
      expect(older.turns.get("lineage")).toBe(40);
    });

    it("wakes no child whose question another run of the parent answered during the wake's claim", async (): Promise<void> => {
      const older = await parentRun({});
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);
      newer.resume.mockRestore();
      runtimeState.turns[0]?.ask("Which region?");
      expect(await older.coordinator.waitForIdle()).toBe("message");
      await older.coordinator.takeParentMessages();
      await until((): boolean => older.coordinator.runningCount === 0);
      spyOn(
        older.coordinator["parentSession"],
        "claimMessageTurn",
      ).mockImplementationOnce(async (): Promise<boolean> => {
        await newer.coordinator.messageChild(
          child.address,
          message({ text: "eu-west" }),
        );
        await until((): boolean => runtimeState.turns.length === 2);
        runtimeState.turns[1]?.answer("done");
        await until((): boolean => newer.coordinator.runningCount === 0);
        older.turns.set("lineage", 1);

        return true;
      });

      await older.coordinator.closePasses();
      await Bun.sleep(5);

      expect(runtimeState.turns).toHaveLength(2);
      expect(older.turns.get("lineage")).toBe(0);
    });

    it("answers a message that waited on a later turn whose result row failed to write", async (): Promise<void> => {
      const run = await parentRun({});
      const runtimeState = childRuntime([run.coordinator]);
      const child = await liveChild(run, runtimeState);
      let fail = (_error: Error): void => {};
      spyOn(
        asyncAgentResults,
        "createPendingAsyncAgentResult",
      ).mockImplementationOnce(
        (): Promise<boolean> =>
          new Promise((_resolve, reject): void => {
            fail = reject;
          }),
      );

      await run.coordinator.messageChild(child.address, message({ text: "a" }));
      runtimeState.turns[0]?.answer("first");
      await Bun.sleep(5);
      const late = run.coordinator.messageChild(
        child.address,
        message({ text: "b" }),
      );
      await Bun.sleep(1);
      fail(new Error("row write failed"));

      expect(
        await Promise.race([
          late.then((result): string => result.status),
          Bun.sleep(500).then((): string => "still waiting"),
        ]),
      ).not.toBe("still waiting");
    });

    it("hands a later turn's question to the open run that paid for it, and wakes the child only once that run closes", async (): Promise<void> => {
      const older = await parentRun({});
      const newer = await parentRun({
        eventId: "acct:account_1:agent:agent_parent:api:event_newer",
      });
      const runtimeState = childRuntime([older.coordinator, newer.coordinator]);
      const child = await liveChild(older, runtimeState);
      newer.resume.mockRestore();
      await older.coordinator.closePasses();

      await newer.coordinator.messageChild(child.address, message());
      runtimeState.turns[0]?.answer("first");
      await until((): boolean => runtimeState.turns.length === 2);
      runtimeState.turns[1]?.ask("Which region?");
      await until((): boolean => older.coordinator.runningCount === 0);
      await Bun.sleep(5);

      expect(runtimeState.turns).toHaveLength(2);
      expect(
        (await newer.coordinator.takeParentMessages()).map(messageText),
      ).toEqual([expect.stringContaining("Which region?")]);
      await newer.coordinator.closePasses();
      await until((): boolean => runtimeState.turns.length === 3);
      expect(runtimeState.turns[2]?.prompt).toContain(
        "No reply from your parent",
      );
    });

    it("keeps one note's ids across its tries, so a note admitted before a failure is delivered once", async (): Promise<void> => {
      const resumeParent = mock(
        async (
          _parent: unknown,
          _taskId: string,
        ): Promise<SubagentResumeOutcome> => {
          throw new Error("row write failed after the admission");
        },
      );
      const { coordinator, key, turns } = await parentRun({
        resumeParent: resumeParent,
      });
      coordinator["pendingMetadata"].set("subagent_1", waitingChild(key));

      expect(
        await coordinator.noteFromChild("subagent_1", message()),
      ).toMatchObject({ status: "not_delivered" });
      expect(turns.get("lineage")).toBe(0);
      // The model sends it again; the first try's admission is found under the same ids.
      resumeParent.mockResolvedValueOnce("conflict");
      expect(
        await coordinator.noteFromChild(
          "subagent_1",
          message({ exchangeId: "ex_2" }),
        ),
      ).toMatchObject({ status: "delivered" });
      expect(turns.get("lineage")).toBe(1);
      expect(
        new Set(resumeParent.mock.calls.map(([, taskId]): string => taskId))
          .size,
      ).toBe(1);

      // Admitted, then its next write failed: the same ids again answer duplicate.
      resumeParent.mockRejectedValueOnce(new Error("row write failed"));
      resumeParent.mockResolvedValueOnce("duplicate");
      expect(
        await coordinator.noteFromChild("subagent_1", message()),
      ).toMatchObject({ status: "delivered" });
      expect(turns.get("lineage")).toBe(2);
      const [third, fourth] = resumeParent.mock.calls
        .slice(-2)
        .map(([, taskId]): string => taskId);
      expect(third).toBe(fourth);
    });

    it("gives two notes of one step their own ids", async (): Promise<void> => {
      const resumeParent = mock(
        async (
          _parent: unknown,
          _taskId: string,
        ): Promise<SubagentResumeOutcome> => "queued",
      );
      const { coordinator, key } = await parentRun({
        resumeParent: resumeParent,
      });
      coordinator["pendingMetadata"].set("subagent_1", waitingChild(key));

      await Promise.all([
        coordinator.noteFromChild("subagent_1", message({ text: "found X" })),
        coordinator.noteFromChild("subagent_1", message({ text: "found Y" })),
      ]);

      expect(
        new Set(resumeParent.mock.calls.map(([, taskId]): string => taskId))
          .size,
      ).toBe(2);
    });
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
    conversationKey: "acct:account_1:agent:agent_parent:api:conv_1",
    persistModelMessages: mock(async () => []),
    renewConversationLease: async (): Promise<string> => "renewed",
    claimMessageTurn: async (): Promise<boolean> => true,
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

// What a turn of `resolvedTask()` hands its parent when it answers.
function completedTurn(): TestCompletion {
  return {
    taskId: "subagent_1",
    eventId: "account_1:agent_child:subagent_1",
    agentId: "agent_child",
    conversationKey: "subagent-subagent_1",
    status: "completed",
    response: "answer",
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

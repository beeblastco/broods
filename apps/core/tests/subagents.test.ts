/**
 * Subagent coordinator tests.
 * Cover parent-result batching without running provider models.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { NatsPublisher } from "../src/shared/nats.ts";

beforeEach(() => {
  process.env.CONVERSATIONS_TABLE_NAME = "conversations";
  process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
  process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-result";
});

interface TestCompletion {
  taskId: string;
  agentId: string;
  conversationKey: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

interface CoordinatorInternals {
  completions: TestCompletion[];
  pending: Map<string, Promise<void>>;
  pendingMetadata: Map<
    string,
    Omit<TestCompletion, "status" | "response" | "error">
  >;
  completeTask(completion: TestCompletion): Promise<void>;
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
    const originalMutation = runtime.mutate;
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
      lifecycle as never,
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
      expect(task.agentId).toBe(`virtual_subagent_${task.taskId}`);
      expect(task.conversationKey.startsWith("subagent-")).toBe(true);
      expect(task.statusPath).toBe(
        `/status/${encodeURIComponent(task.taskId)}?agentId=${encodeURIComponent(task.agentId)}`,
      );
      expect(timeline.slice(0, 3)).toEqual([
        "persist:createAsyncAgentResult",
        "lifecycle:subagent.task.started",
        "run:child",
      ]);
      await expect(coordinator.waitForIdle()).resolves.toBe("idle");
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
        start(controller) {
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
      undefined,
      publisherFactory as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async () => {});

    internals.startTask(resolvedTask());

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(publisherFactory).not.toHaveBeenCalled();
    expect(publisher.timeline).toEqual([]);
  });

  it("publishes enabled child parts, terminal marker, and flushes after settlement", async () => {
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const publisher = recordingPublisher();
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, stream: true } },
      Date.now() + 1_000,
      undefined,
      (() => publisher) as never,
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

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
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
      undefined,
      (() => publisher) as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async () => {
      throw new Error("child failed");
    });
    internals.completeTask = mock(async (completion) => {
      publisher.timeline.push(`settle:${completion.status}`);
    });

    internals.startTask(resolvedTask());

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
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
      undefined,
      (() => publisher) as never,
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

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
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
      undefined,
      (() => publisher) as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    internals.runTask = mock(async (_task, _parentContext, streamPublisher) => {
      await streamPublisher?.publish({ type: "text-delta", text: "answer" });
    });
    internals.completeTask = mock(async () => {});

    internals.startTask(resolvedTask());

    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
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
        persistModelMessages,
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
        persistModelMessages,
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
      agentId: "agent_research",
      conversationKey: "subagent-subagent_2",
    });

    await expect(coordinator.waitForIdle({ onHeartbeat })).resolves.toBe(
      "timeout",
    );
    expect(onHeartbeat).toHaveBeenCalledWith(1);

    await expect(
      coordinator.drainCompletionsAndTimeoutsToParent(),
    ).resolves.toBe(2);
    expect(persistModelMessages).toHaveBeenCalledTimes(1);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0])).toContain("finished before timeout");
    expect(messageText(messages[1])).toContain(
      "Subagent task is still pending near the parent request timeout.",
    );
    expect(messageText(messages[1])).toContain("agentId: agent_research");
    expect(messageText(messages[1])).toContain(
      "conversationKey: subagent-subagent_2",
    );
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
        persistModelMessages,
      } as never,
      {},
      Date.now() + 1_000,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    internals.completions.push(completion("subagent_1", { answer: "done" }));

    await expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);
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
    expect(created.agentId).toContain(created.taskId);
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
        conversationKey: "subagent-persistent-existing",
      },
      [],
      [],
    );
    expect(resumed.publicConversationKey).toBe("subagent-persistent-existing");
    expect(resumed.conversationKey).toContain(
      "api:subagent-persistent-existing",
    );
    expect(resumed.persistent).toBe(true);
    expect(resumed.resuming).toBe(true);
  });

  it("admits a persistent child conversation to own a fencing generation", async () => {
    const originalMutation = runtime.mutate;
    const candidates: Record<string, unknown>[] = [];
    runtime.mutate = mock(async (name: string, args: Record<string, unknown>) => {
      candidates.push({ name: name, ...args });
      return { outcome: "owner", ownerGeneration: 7 };
    }) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 1_000,
      { emit: mock(async () => {}) } as never,
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
        statusUrl:
          "/status/subagent~task_1?agentId=agent_child",
      });
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
      { emit: mock(async () => {}) } as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;
    const runTask = mock(async () => {});
    internals.runTask = runTask;

    await internals.drainChildConversation(
      {
        releaseConversationLease,
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

  it("keeps a stopped child's progress out of the parent transcript", async () => {
    const originalMutation = runtime.mutate;
    runtime.mutate = mock(async () => true) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true } },
      Date.now() + 60_000,
      { emit: mock(async () => {}) } as never,
    );
    const internals = coordinator as unknown as {
      completeTask(completion: unknown): Promise<void>;
      pending: Map<string, Promise<void>>;
    };
    const failure = {
      taskId: "subagent~task_1",
      agentId: "agent_child",
      conversationKey: "subagent-persistent-1",
      status: "failed",
    };

    try {
      internals.pending.set("subagent~task_1", Promise.resolve());
      await internals.completeTask({
        ...failure,
        error: "Stopped by user at the model boundary",
      });

      expect(await coordinator.drainCompletionsToParent()).toBe(0);

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
      { emit: mock(async () => {}) } as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      {
        releaseConversationLease,
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
      { emit: mock(async () => {}) } as never,
      undefined,
      async (_session, scope) => {
        scopes.push(scope as unknown as Record<string, unknown>);
        return true;
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      { releaseConversationLease, takeNextIngress } as never,
      persistentChildTask(),
    );

    expect(scopes[0]).toMatchObject({
      accountId: "account_1",
      agentId: "agent_child",
      conversationKey:
        "acct:account_1:agent:agent_child:api:subagent-persistent-1",
      publicConversationKey: "subagent-persistent-1",
    });
    // No live parent turn to inject into, so it must not run in-process.
    expect(takeNextIngress).not.toHaveBeenCalled();
    // Ownership moved to the queued envelope, so releasing would strand it.
    expect(releaseConversationLease).not.toHaveBeenCalled();
  });

  it("releases the child lease when the expired-budget transfer finds nothing", async () => {
    const releaseConversationLease = mock(async () => {});
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() - 1,
      { emit: mock(async () => {}) } as never,
      undefined,
      async () => {
        throw new Error("worker unavailable");
      },
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    await internals.drainChildConversation(
      { releaseConversationLease } as never,
      persistentChildTask(),
    );

    expect(releaseConversationLease).toHaveBeenCalledTimes(1);
  });

  it("refuses to run a persistent child whose conversation is busy", async () => {
    const originalMutation = runtime.mutate;
    runtime.mutate = mock(async () => ({ outcome: "rejected" })) as never;
    const { SubagentCoordinator } = await import("../src/harness/subagents.ts");
    const coordinator = new SubagentCoordinator(
      parentSession(),
      { subagent: { enabled: true, mode: "persistent" } },
      Date.now() + 1_000,
      { emit: mock(async () => {}) } as never,
    );
    const internals = coordinator as unknown as CoordinatorInternals;

    try {
      await expect(
        internals.admitChildConversation(persistentChildTask(), {
          role: "user",
          content: [{ type: "text", text: "research" }],
        }),
      ).rejects.toThrow("Subagent conversation is not available: rejected");
    } finally {
      runtime.mutate = originalMutation;
    }
  });

  it("carries the parent deployment scope into the ephemeral child session", async () => {
    const { createEphemeralChildSession } =
      await import("../src/harness/subagents.ts");
    const childSession = {
      accountId: "account_1",
      agentId: "virtual_subagent_x",
      conversationKey: "conv-key",
      eventId: "event-x",
      endpointId: "env-1d88x06b",
      projectSlug: "channel-telegram",
      environmentSlug: "development",
      filesystemNamespace: () => "ns",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      loadSkillPrompt: async () => "",
      createEphemeralTurnContext: async () => ({ system: [] }),
    } as never;

    const ephemeral = createEphemeralChildSession(childSession, []);

    // Without the deployment scope, runAgentLoop stamps empty project/environment/
    // endpoint_id on the subtask span: publishSpan early-returns (no live span) AND
    // the dashboard's project+environment-scoped Tempo backfill never matches it, so
    // subagents are invisible in tracing and a reload doesn't bring them back.
    expect(ephemeral.endpointId).toBe("env-1d88x06b");
    expect(ephemeral.projectSlug).toBe("channel-telegram");
    expect(ephemeral.environmentSlug).toBe("development");
    expect(ephemeral.accountId).toBe("account_1");
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

    await expect(
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
    taskId,
    agentId: `agent_${taskId}`,
    conversationKey: `conversation_${taskId}`,
    status: "completed",
    response,
  };
}

function persistentChildTask() {
  return {
    taskId: "subagent~task_1",
    eventId: "acct:account_1:agent:agent_child:api:subagent~task_1",
    agentId: "agent_child",
    agentConfig: {},
    publicConversationKey: "subagent-persistent-1",
    conversationKey: "acct:account_1:agent:agent_child:api:subagent-persistent-1",
    prompt: "research",
    inheritedContext: false,
    parentMessages: [],
    parentEphemeralSystem: [],
    persistent: true,
    resuming: false,
  };
}

function parentSession() {
  return {
    accountId: "account_1",
    agentId: "agent_parent",
    eventId: "acct:account_1:agent:agent_parent:api:event_parent",
    persistModelMessages: mock(async () => []),
  } as never;
}

function recordingPublisher(): NatsPublisher & {
  events: Record<string, unknown>[];
  timeline: string[];
} {
  const events: Record<string, unknown>[] = [];
  const timeline: string[] = [];
  return {
    events,
    timeline,
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

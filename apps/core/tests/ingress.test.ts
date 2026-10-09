import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  dispatchInProcessWorker,
  drainInProcessWorkers,
  handleChannelRequest,
  handler,
} from "../src/harness/handler.ts";
import {
  acceptIngress,
  interruptLiveOwners,
  loadAppliedIngressConfig,
  prepareSessionMessage,
  releaseIngressOwner,
  takeNextIngress,
  type AppliedIngress,
  type ConversationDispatchTarget,
  type IngressCandidate,
} from "../src/harness/ingress.ts";
import * as harness from "../src/harness/harness.ts";
import type { AgentReplyHooks } from "../src/harness/harness.ts";
import * as ingress from "../src/harness/ingress.ts";
import type {
  ChannelInboundEvent,
  DirectInboundEvent,
} from "../src/harness/integrations.ts";
import type { PendingQuestionSummary } from "../src/harness/questions.ts";
import { Session } from "../src/harness/session.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { ChannelRecord } from "../src/shared/domain/channel-record.ts";
import {
  getStorage,
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";

const originalMutate = runtime.mutate.bind(runtime);
const originalQuery = runtime.query.bind(runtime);

afterEach(() => {
  runtime.mutate = originalMutate;
  runtime.query = originalQuery;
});

function agentRecord(config: AgentConfig): AgentRecord {
  return {
    accountId: "acct_test",
    agentId: "agent_test",
    name: "agent",
    config: config,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function candidate(): IngressCandidate {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    eventId: "event-1",
    runId: "run_" + "a".repeat(32),
    conversationKey: "acct:acct_1:agent:agent_1:api:conversation-1",
    events: [{ role: "user", content: "hello" }],
    requestedMode: "followup",
    idempotencyKey: "event-1",
    delivery: {
      kind: "http",
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
    },
  };
}

function channelRecord(agentId: string): ChannelRecord {
  return {
    accountId: "acct_test",
    channelRecordId: "rec_1",
    platform: "telegram",
    externalId: "target-chat",
    name: "chat",
    config: { agentBindings: [{ agentId: agentId, isDefault: true }] },
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("ingress admission payloads", () => {
  it("remembers channel delivery as a session target", async (): Promise<void> => {
    let call: Record<string, unknown> | undefined;
    runtime.mutate = (async (
      _name: string,
      args: Record<string, unknown>,
    ): Promise<{ outcome: "owner"; ownerGeneration: number }> => {
      call = args;

      return { outcome: "owner", ownerGeneration: 1 };
    }) as never;
    await acceptIngress({
      ...candidate(),
      configRef: {
        channel: { channelName: "telegram", channelRecordId: "rec_1" },
      },
      channelTarget: { channelRecordId: "rec_1" },
      delivery: {
        kind: "channel",
        channel: "telegram",
        identity: { userId: "U2", userRoles: ["dev"] },
        source: { chatId: "chat-1" },
      },
    });

    // The rows to rebuild from, never the resolved config and its secrets.
    expect(call?.channelTarget).toEqual({
      channelRecordId: "rec_1",
      channelName: "telegram",
      source: { chatId: "chat-1" },
    });
    expect(call?.configRef).toEqual({
      channel: { channelName: "telegram", channelRecordId: "rec_1" },
    });
    expect(call).not.toHaveProperty("agentConfig");
    // The sender rides on the envelope so a queued turn is policed as its own
    // author, not as whoever owned the run when it was queued.
    expect(call?.delivery).toEqual(
      expect.objectContaining({
        identity: { userId: "U2", userRoles: ["dev"] },
      }),
    );
  });

  it("persists per-request execution context and covers it in the digest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);

      return { outcome: "queued" };
    }) as never;

    await acceptIngress({
      ...candidate(),
      configRef: { model: { temperature: 0.1 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });
    await acceptIngress({
      ...candidate(),
      configRef: { model: { temperature: 0.9 } },
    });
    await acceptIngress(candidate());

    const [first, second, third] = calls;
    expect(first!.configRef).toEqual({ model: { temperature: 0.1 } });
    expect(first!.ephemeralSystem).toEqual([
      { role: "system", content: "one-turn override" },
    ]);
    // Different model/system overrides must never collapse into the same
    // idempotent payload identity.
    expect(first!.payloadDigest).not.toBe(second!.payloadDigest);
    expect(second!.payloadDigest).not.toBe(third!.payloadDigest);
    // Queue byte accounting includes the persisted execution context.
    expect(first!.sizeBytes as number).toBeGreaterThan(
      third!.sizeBytes as number,
    );
  });

  it("keeps the digest stable when no overrides are supplied", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);

      return { outcome: "owner", ownerGeneration: 1 };
    }) as never;

    await acceptIngress(candidate());
    await acceptIngress(candidate());
    expect(calls[0]!.payloadDigest).toBe(calls[1]!.payloadDigest);
  });
});

describe("settling with takeNext", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  it("still settles the turn when takeNext fails", async (): Promise<void> => {
    spyOn(ingress, "takeNextIngress").mockRejectedValue(
      new Error("takeNext failed"),
    );
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    const session = new Session({
      eventId: "event-1",
      conversationKey: candidate().conversationKey,
      accountId: "acct_1",
      agentId: "agent_1",
      agentConfig: {},
      ownerGeneration: 1,
    });

    const error = await session
      .takeNextIngress({ status: "completed", result: "answer" })
      .catch((err: unknown): unknown => err);

    // The rolled-back settle is written on its own, so the caller's failure
    // settle that follows finds the envelope terminal and keeps the answer.
    expect(error).toEqual(new Error("takeNext failed"));
    expect(settle).toHaveBeenCalledWith({
      conversationKey: candidate().conversationKey,
      ownerEventId: "event-1",
      ownerGeneration: 1,
      status: "completed",
      result: "answer",
    });
  });
});

describe("step boundary", (): void => {
  it("stores the step, renews and claims steers in one fenced mutation that proves ownership", async (): Promise<void> => {
    const calls: [string, Record<string, unknown>][] = [];
    const steering: AppliedIngress = {
      eventId: "event-1",
      events: [{ role: "user", content: "new direction" }],
      delivery: candidate().delivery,
      requestedMode: "steer",
      appliedMode: "steer",
      appliedToEventId: "event-1",
      contributingEventIds: ["steer-1"],
      ownerGeneration: 1,
    };
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push([name, args]);

      return { renewal: "renewed", steering: steering };
    }) as typeof runtime.mutate;
    const reads = mock(async (): Promise<boolean> => true);
    runtime.query = reads as unknown as typeof runtime.query;
    const session = new Session({
      eventId: "event-1",
      conversationKey: candidate().conversationKey,
      agentConfig: {},
      ownerGeneration: 1,
    });

    const boundary = await session.stepBoundary([
      { role: "assistant", content: "step answer" },
    ]);
    await session.assertRecentOwner();

    expect(boundary).toEqual({ renewal: "renewed", steering: steering });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("stepIngressBoundary");
    expect(calls[0]?.[1]).toMatchObject({
      conversationKey: candidate().conversationKey,
      ownerEventId: "event-1",
      ownerGeneration: 1,
      leaseTtlMs: 15 * 60 * 1000,
      events: [
        {
          event: {
            message: { role: "assistant", content: "step answer" },
          },
        },
      ],
    });
    // The renewed boundary answered the owner check: no read.
    expect(reads).not.toHaveBeenCalled();
  });

  it("sends no rows on a step with nothing new, and a stale boundary proves nothing", async (): Promise<void> => {
    const calls: Record<string, unknown>[] = [];
    runtime.mutate = (async (
      _name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push(args);

      return { renewal: "stale", steering: null };
    }) as typeof runtime.mutate;
    const reads = mock(async (): Promise<boolean> => false);
    runtime.query = reads as unknown as typeof runtime.query;
    const session = new Session({
      eventId: "event-1",
      conversationKey: candidate().conversationKey,
      agentConfig: {},
      ownerGeneration: 1,
    });

    expect(await session.stepBoundary([])).toEqual({
      renewal: "stale",
      steering: null,
    });
    expect(calls[0]).not.toHaveProperty("events");
    expect(session.assertRecentOwner()).rejects.toThrow(
      "Stale conversation owner generation",
    );
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe("async turn without model input", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  it("records the failed task when the turn context does not load", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(Session.prototype, "createTurnContext").mockRejectedValue(
      new Error("ArgumentValidationError"),
    );
    const recorded = spyOn(harness, "recordFailedTurn").mockResolvedValue();
    const event: DirectInboundEvent = {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [],
      agentConfig: {},
      ownerGeneration: 1,
    };

    await expect(
      handler({ kind: "direct-api-async-worker", event: event }),
    ).rejects.toThrow("ArgumentValidationError");

    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]?.[0]).toBeInstanceOf(Session);
    expect(recorded.mock.calls[0]?.[2]).toEqual(
      new Error("ArgumentValidationError"),
    );
  });

  it("settles the envelope with its own reason when the cron settle fails", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(Session.prototype, "createTurnContext").mockResolvedValue({
      messages: [{ role: "assistant", content: "already answered" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    });
    spyOn(getStorage().crons, "failRun").mockRejectedValue(
      new Error("cron store down"),
    );
    const event: DirectInboundEvent = {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [],
      agentConfig: {},
      ownerGeneration: 1,
      cronRun: { cronId: "cron_1", runId: "run_1" },
    };

    await handler({ kind: "direct-api-async-worker", event: event }).catch(
      (): null => null,
    );

    expect(settle.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      error: "Request did not produce pending model input",
    });
  });

  it("still settles the cron run when the envelope settle fails", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    spyOn(ingress, "settleIngress").mockRejectedValue(new Error("convex down"));
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(Session.prototype, "createTurnContext").mockResolvedValue({
      messages: [],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    });
    const failRun = spyOn(getStorage().crons, "failRun").mockResolvedValue();
    const event: DirectInboundEvent = {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [],
      agentConfig: {},
      ownerGeneration: 1,
      cronRun: { cronId: "cron_1", runId: "run_1" },
    };

    await handler({ kind: "direct-api-async-worker", event: event }).catch(
      (): null => null,
    );

    // The cron run records the run's own outcome, not the write that failed.
    expect(failRun).toHaveBeenCalledWith(
      "acct_1",
      "cron_1",
      "run_1",
      "Request did not produce pending model input",
    );
  });
});

describe("async turn that throws after it settles", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  it("records pending questions whose write the loop swallowed", async (): Promise<void> => {
    const question: PendingQuestionSummary = {
      statusId: "status-1",
      questions: [],
      answerBy: "2026-09-25T00:00:00.000Z",
    };
    const settle = stubTurn(
      [],
      async (reply): Promise<PendingQuestionSummary[]> => {
        // The harness catches a callback's throw and only marks the step failed.
        await reply.onQuestionsPending?.([question]).catch((): void => {});

        return [question];
      },
    );
    settle.mockRejectedValueOnce(new Error("settle failed"));
    const takeNext = spyOn(ingress, "takeNextIngress").mockResolvedValue(null);

    await handler({
      kind: "direct-api-async-worker",
      event: completedEvent(),
    }).catch((): void => {});

    expect(
      settle.mock.calls.map(([options]) => options.asyncResult?.outcome.status),
    ).toEqual(["awaiting_input", "awaiting_input"]);
    expect(takeNext).toHaveBeenCalledTimes(1);
  });

  it("keeps pending questions when a kept final text follows them", async (): Promise<void> => {
    const question: PendingQuestionSummary = {
      statusId: "status-1",
      questions: [],
      answerBy: "2026-09-25T00:00:00.000Z",
    };
    // An earlier pass's final text is replayed after a later pass asks.
    const settle = stubTurn(
      [],
      async (reply): Promise<PendingQuestionSummary[]> => {
        await reply.onFinalText("answer");
        await reply.onQuestionsPending?.([question]);

        return [question];
      },
    );
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    const completeRun = spyOn(
      getStorage().crons,
      "completeRun",
    ).mockResolvedValue();

    await handler({
      kind: "direct-api-async-worker",
      event: {
        ...completedEvent(),
        cronRun: { cronId: "cron_1", runId: "run_1" },
      },
    });

    expect(
      settle.mock.calls.map(([options]) => options.asyncResult?.outcome.status),
    ).toEqual(["awaiting_input"]);
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("retries the pending questions when their settle fails before a kept final text", async (): Promise<void> => {
    const question: PendingQuestionSummary = {
      statusId: "status-1",
      questions: [],
      answerBy: "2026-09-25T00:00:00.000Z",
    };
    const settle = stubTurn(
      [],
      async (reply): Promise<PendingQuestionSummary[]> => {
        await reply.onFinalText("answer");
        await reply.onQuestionsPending?.([question]).catch((): void => {});

        return [question];
      },
    );
    settle.mockRejectedValueOnce(new Error("settle failed"));
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);

    await handler({
      kind: "direct-api-async-worker",
      event: completedEvent(),
    });

    expect(
      settle.mock.calls.map(([options]) => options.asyncResult?.outcome.status),
    ).toEqual(["awaiting_input", "awaiting_input"]);
  });

  it("records the answer on the polling rows when the settle loses the lease", async (): Promise<void> => {
    const writes: Array<{ name: string; status?: unknown }> = [];
    stubCompletedTurn(writes).mockRejectedValue(
      new Error("Stale conversation owner generation"),
    );
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);

    await handler({
      kind: "direct-api-async-worker",
      event: completedEvent(),
    }).catch((): void => {});

    expect(
      writes.filter((write) => write.name === "updateAsyncAgentResult"),
    ).toEqual([{ name: "updateAsyncAgentResult", status: "completed" }]);
  });

  it("pushes the channel reply before it settles the cron run", async (): Promise<void> => {
    stubCompletedTurn([]);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(getStorage().crons, "completeRun").mockRejectedValue(
      new Error("cron write failed"),
    );
    const replyOwnerCheck = spyOn(
      Session.prototype,
      "assertCurrentOwner",
    ).mockResolvedValue();

    await handler({
      kind: "direct-api-async-worker",
      event: {
        ...completedEvent(),
        cronRun: { cronId: "cron_1", runId: "run_1" },
        replyTarget: { channelName: "slack", source: { channelId: "C1" } },
      },
    }).catch((): void => {});

    expect(replyOwnerCheck).toHaveBeenCalled();
  });

  it("retries a failed cron settle with the recorded outcome", async (): Promise<void> => {
    stubCompletedTurn([]);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    const completeRun = spyOn(getStorage().crons, "completeRun")
      .mockRejectedValueOnce(new Error("cron write failed"))
      .mockResolvedValue();
    const failRun = spyOn(getStorage().crons, "failRun").mockResolvedValue();

    const error = await handler({
      kind: "direct-api-async-worker",
      event: {
        ...completedEvent(),
        cronRun: { cronId: "cron_1", runId: "run_1" },
      },
    }).catch((err: unknown): unknown => err);

    expect(error).toEqual(new Error("cron write failed"));
    expect(completeRun).toHaveBeenCalledTimes(2);
    expect(failRun).not.toHaveBeenCalled();
  });

  it("keeps the completed result when the next dispatch throws", async (): Promise<void> => {
    const writes: Array<{ name: string; status?: unknown }> = [];
    const settle = stubCompletedTurn(writes);
    spyOn(ingress, "takeNextIngress").mockRejectedValue(
      new Error("takeNext failed"),
    );

    const error = await handler({
      kind: "direct-api-async-worker",
      event: completedEvent(),
    }).catch((err: unknown): unknown => err);

    expect(error).toEqual(new Error("takeNext failed"));
    expect(settle.mock.calls.map(([options]) => options.asyncResult)).toEqual([
      {
        eventIds: ["event-1"],
        outcome: { status: "completed", response: "answer" },
      },
    ]);
    expect(
      writes.filter((write) => write.name === "updateAsyncAgentResult"),
    ).toEqual([]);
  });

  /** An async event whose run ends with the final text "answer". */
  function completedEvent(): DirectInboundEvent {
    return {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [],
      agentConfig: {},
      ownerGeneration: 1,
    };
  }

  /** Stubs a turn that ends with the final text "answer"; returns the settle spy. */
  function stubCompletedTurn(
    writes: Array<{ name: string; status?: unknown }>,
  ): ReturnType<typeof spyOn<typeof ingress, "settleIngress">> {
    return stubTurn(
      writes,
      async (reply): Promise<PendingQuestionSummary[]> => {
        await reply.onFinalText("answer");

        return [];
      },
    );
  }

  /**
   * Stubs one model turn that `end` finishes through the loop's reply
   * callbacks, returning the questions it leaves open; returns the settle spy.
   */
  function stubTurn(
    writes: Array<{ name: string; status?: unknown }>,
    end: (reply: AgentReplyHooks) => Promise<PendingQuestionSummary[]>,
  ): ReturnType<typeof spyOn<typeof ingress, "settleIngress">> {
    spyOn(runtime, "mutate").mockImplementation((async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      writes.push({ name: name, status: args.status });

      return null;
    }) as never);
    spyOn(runtime, "query").mockResolvedValue(null as never);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(Session.prototype, "createTurnContext").mockResolvedValue({
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    });
    spyOn(harness, "runAgentLoop").mockImplementation((async (
      _session: unknown,
      _turn: unknown,
      _config: unknown,
      reply: AgentReplyHooks,
    ) => {
      const questions = await end(reply);

      return {
        traceId: (): undefined => undefined,
        consumeStream: async (): Promise<void> => {},
        questionSummaries: (): PendingQuestionSummary[] => questions,
        didFail: (): boolean => false,
        failureText: (): null => null,
      };
    }) as never);

    return settle;
  }
});

describe("channel senders", (): void => {
  const bob = { userId: "U2", userRoles: ["dev"] };
  const queued: AppliedIngress = {
    eventId: "event-2",
    events: [{ role: "user", content: "from bob" }],
    delivery: {
      kind: "channel",
      channel: "slack",
      identity: bob,
      source: { channelId: "C1" },
    },
    requestedMode: "steer",
    appliedMode: "followup",
    appliedToEventId: "event-2",
    contributingEventIds: ["event-2"],
    ownerGeneration: 2,
    configRef: { channel: { channelName: "slack" } },
  };
  let senders: unknown[];

  beforeEach((): void => {
    senders = [];
    // The queued envelope's ref rebuilds its config from this row.
    setStorageForTests({
      agents: { getById: async (): Promise<AgentRecord> => agentRecord({}) },
    } as never);
    runtime.query = (async (name: string): Promise<[] | null> =>
      name === "listPendingAsyncToolResults" ? [] : null) as never;
    // Ends each turn before the model runs; only the session's sender matters.
    spyOn(Session.prototype, "createTurnContext").mockImplementation(
      async function (this: Session): Promise<never> {
        senders.push(
          this.delivery?.kind === "channel"
            ? this.delivery.identity
            : undefined,
        );
        throw new Error("stop before the model");
      },
    );
  });

  afterEach((): void => {
    mock.restore();
    resetStorageForTests();
  });

  function aliceMessage(): ChannelInboundEvent {
    return {
      accountId: "acct_1",
      agentId: "agent_1",
      eventId: "event-1",
      conversationKey: "acct:acct_1:agent:agent_1:slack:C1",
      content: "from alice",
      events: [{ role: "user", content: "from alice" }],
      channelName: "slack",
      identity: { userId: "U1", userRoles: ["admin"] },
      source: { channelId: "C1" },
      channel: {
        sendText: async (): Promise<void> => {},
        sendTyping: async (): Promise<void> => {},
        reactToMessage: async (): Promise<void> => {},
      },
    };
  }

  it("drains a queued message as its own sender", async (): Promise<void> => {
    let taken = false;
    runtime.mutate = (async (name: string): Promise<unknown> => {
      if (name === "acceptIngress") {
        return { outcome: "owner", ownerGeneration: 1 };
      }
      if (name !== "takeNextIngress" || taken) return null;
      taken = true;

      return queued;
    }) as never;

    await handleChannelRequest(aliceMessage());
    await drainInProcessWorkers();

    expect(senders).toEqual([{ userId: "U1", userRoles: ["admin"] }, bob]);
  });

  it("waits for a worker slot like every other run", async (): Promise<void> => {
    runtime.mutate = (async (name: string): Promise<unknown> =>
      name === "acceptIngress"
        ? { outcome: "owner", ownerGeneration: 1 }
        : null) as never;
    const releases: (() => void)[] = [];
    for (let slot = 0; slot < 8; slot += 1) {
      dispatchInProcessWorker(
        "busy",
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
    }

    await handleChannelRequest(aliceMessage());
    await Bun.sleep(5);

    // Admitted, but the turn has not started: all eight slots are taken.
    expect(senders).toEqual([]);
    for (const release of releases) release();
    await drainInProcessWorkers();
    expect(senders).toEqual([{ userId: "U1", userRoles: ["admin"] }]);
  });

  it("ignores a redelivery of an admitted message before storing its files", async (): Promise<void> => {
    const mutations: string[] = [];
    runtime.mutate = (async (name: string): Promise<unknown> => {
      mutations.push(name);

      return null;
    }) as never;
    runtime.query = (async (name: string): Promise<unknown> => {
      if (name === "listPendingAsyncToolResults") return [];

      return name === "getIngressStatusByEventId"
        ? { eventId: "event-1", status: "processing" }
        : null;
    }) as never;

    await handleChannelRequest({
      ...aliceMessage(),
      attachments: [{ type: "image", url: "https://files.test/a.png" }],
    });

    // No admission and no ingestion: the first delivery already did both.
    expect(mutations).toEqual([]);
    expect(senders).toEqual([]);
  });

  it("runs a queued /compact after the turn, in place of a model turn", async (): Promise<void> => {
    let taken = false;
    runtime.mutate = (async (name: string): Promise<unknown> => {
      if (name === "acceptIngress") {
        return { outcome: "owner", ownerGeneration: 1 };
      }
      if (name !== "takeNextIngress" || taken) return null;
      taken = true;

      return {
        ...queued,
        events: [{ role: "user", content: "/compact keep the deploy" }],
      };
    }) as never;
    const compacted: string[] = [];
    const compact = spyOn(
      Session.prototype,
      "compactConversation",
    ).mockImplementation(async (instructions: string): Promise<number> => {
      compacted.push(instructions);

      return 4;
    });
    const replies: string[] = [];
    const message = aliceMessage();

    try {
      await handleChannelRequest({
        ...message,
        channel: {
          ...message.channel,
          sendText: async (text: string): Promise<void> => {
            replies.push(text);
          },
        },
      });
      await drainInProcessWorkers();
    } finally {
      compact.mockRestore();
    }

    // Only alice's turn reached the history; the command never did.
    expect(senders).toEqual([{ userId: "U1", userRoles: ["admin"] }]);
    expect(compacted).toEqual(["keep the deploy"]);
    expect(replies.at(-1)).toBe("Context compacted. 4 message(s) summarized.");
  });

  it("keeps the sender on an envelope recovered for another worker", async (): Promise<void> => {
    runtime.mutate = (async (name: string): Promise<unknown> =>
      name === "acceptIngress"
        ? { outcome: "queued", recovered: queued }
        : null) as never;

    await handleChannelRequest(aliceMessage());
    await drainInProcessWorkers();

    expect(senders).toEqual([bob]);
  });
});

describe("channel commands", (): void => {
  it("runs a redelivered /clear once", async (): Promise<void> => {
    const claims = new Set<string>();
    let clears = 0;
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name === "claimEvent") {
        const fresh = !claims.has(String(args.key));
        claims.add(String(args.key));

        return fresh;
      }
      if (name === "acquireIngressClear") return 1;
      if (name === "clearFencedConversation") {
        clears += 1;

        return { deleted: 0, hasMore: false };
      }

      return null;
    }) as never;
    const replies: string[] = [];
    const command: ChannelInboundEvent = {
      accountId: "acct_1",
      agentId: "agent_1",
      eventId: "event-clear",
      conversationKey: "acct:acct_1:agent:agent_1:discord:C1",
      content: "/clear",
      events: [{ role: "user", content: "/clear" }],
      channelName: "discord",
      commandToken: "/clear",
      source: { channelId: "C1" },
      channel: {
        sendText: async (text: string): Promise<void> => {
          replies.push(text);
        },
        sendTyping: async (): Promise<void> => {},
        reactToMessage: async (): Promise<void> => {},
      },
    };

    await handleChannelRequest(command);
    await handleChannelRequest(command);

    expect(clears).toBe(1);
    expect(replies).toEqual(["Context cleared. Starting fresh."]);
  });

  function compactMessage(replies: string[]): ChannelInboundEvent {
    return {
      accountId: "acct_1",
      agentId: "agent_1",
      eventId: "event-compact",
      conversationKey: "acct:acct_1:agent:agent_1:telegram:C1",
      content: "/compact",
      events: [{ role: "user", content: "/compact" }],
      channelName: "telegram",
      commandToken: "/compact",
      source: { chatId: "C1" },
      channel: {
        sendText: async (text: string): Promise<void> => {
          replies.push(text);
        },
        sendTyping: async (): Promise<void> => {},
        reactToMessage: async (): Promise<void> => {},
      },
    };
  }

  it("compacts right away on an idle conversation and never stores the command", async (): Promise<void> => {
    const settles: unknown[] = [];
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name === "acceptIngress") {
        return { outcome: "owner", ownerGeneration: 1 };
      }
      if (name === "takeNextIngress") settles.push(args.settle);

      return null;
    }) as never;
    const turn = spyOn(Session.prototype, "createTurnContext");
    const compact = spyOn(
      Session.prototype,
      "compactConversation",
    ).mockResolvedValue(7);
    const replies: string[] = [];

    try {
      await handleChannelRequest(compactMessage(replies));
      await drainInProcessWorkers();
    } finally {
      turn.mockRestore();
      compact.mockRestore();
    }

    expect(turn).not.toHaveBeenCalled();
    expect(replies).toEqual(["Context compacted. 7 message(s) summarized."]);
    expect(settles[0]).toMatchObject({ status: "completed" });
  });

  it("says a failed compaction failed and settles the run as failed", async (): Promise<void> => {
    const settles: unknown[] = [];
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name === "acceptIngress") {
        return { outcome: "owner", ownerGeneration: 1 };
      }
      if (name === "takeNextIngress") settles.push(args.settle);

      return null;
    }) as never;
    const compact = spyOn(
      Session.prototype,
      "compactConversation",
    ).mockRejectedValue(new Error("summary model down"));
    const replies: string[] = [];

    try {
      await handleChannelRequest(compactMessage(replies));
      await drainInProcessWorkers();
    } finally {
      compact.mockRestore();
    }

    expect(replies).toEqual(["Something went wrong. Please try again."]);
    expect(settles[0]).toMatchObject({
      status: "failed",
      error: "summary model down",
    });
  });

  it("does not announce an ordinary queued message", async (): Promise<void> => {
    runtime.mutate = (async (name: string): Promise<unknown> =>
      name === "acceptIngress"
        ? { outcome: "queued", status: "queued" }
        : null) as never;
    runtime.query = (async (name: string): Promise<unknown> =>
      name === "listPendingAsyncToolResults" ? [] : null) as never;
    const replies: string[] = [];

    await handleChannelRequest({
      ...compactMessage(replies),
      eventId: "event-hello",
      content: "hello",
      events: [{ role: "user", content: "hello" }],
      commandToken: undefined,
    });

    expect(replies).toEqual([]);
  });

  it("queues /compact behind a running turn and says so", async (): Promise<void> => {
    const admitted: Record<string, unknown>[] = [];
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name !== "acceptIngress") return null;
      admitted.push(args);

      return { outcome: "queued", status: "queued" };
    }) as never;
    const replies: string[] = [];

    await handleChannelRequest({
      accountId: "acct_1",
      agentId: "agent_1",
      eventId: "event-compact",
      conversationKey: "acct:acct_1:agent:agent_1:discord:C1",
      // Discord delivers only the option text of a slash command.
      content: "keep the deploy",
      events: [{ role: "user", content: "keep the deploy" }],
      channelName: "discord",
      commandToken: "/compact",
      source: { channelId: "C1" },
      channel: {
        sendText: async (text: string): Promise<void> => {
          replies.push(text);
        },
        sendTyping: async (): Promise<void> => {},
        reactToMessage: async (): Promise<void> => {},
      },
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.requestedMode).toBe("followup");
    expect(admitted[0]?.events).toEqual([
      { role: "user", content: "/compact keep the deploy" },
    ]);
    expect(replies).toEqual([
      "/compact queued. It runs when the current turn finishes.",
    ]);
  });
});

describe("queued /compact admission", (): void => {
  async function admittedMode(
    overrides: Partial<IngressCandidate>,
  ): Promise<unknown> {
    let mode: unknown;
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name === "acceptIngress") mode = args.requestedMode;

      return { outcome: "queued", status: "queued" };
    }) as never;
    await acceptIngress({ ...candidate(), ...overrides });

    return mode;
  }

  const compact: IngressCandidate["events"] = [
    { role: "user", content: "/compact keep the deploy" },
  ];

  it("waits as a follow-up whatever mode the caller asked for", async (): Promise<void> => {
    for (const mode of ["steer", "collect", "reject", "followup"] as const) {
      expect(await admittedMode({ events: compact, requestedMode: mode })).toBe(
        "followup",
      );
    }
  });

  it("leaves an ordinary message's mode alone", async (): Promise<void> => {
    expect(await admittedMode({ requestedMode: "steer" })).toBe("steer");
  });

  it("is a plain message on a channel that takes no commands", async (): Promise<void> => {
    const delivery = (channel: string): IngressCandidate["delivery"] => ({
      kind: "channel",
      channel: channel,
      source: {},
    });

    expect(
      await admittedMode({
        events: compact,
        requestedMode: "steer",
        delivery: delivery("pancake"),
      }),
    ).toBe("steer");
    expect(
      await admittedMode({
        events: compact,
        requestedMode: "steer",
        delivery: delivery("telegram"),
      }),
    ).toBe("followup");
  });

  it("is a plain message when a file rides with it", async (): Promise<void> => {
    expect(
      await admittedMode({
        events: [
          {
            role: "user",
            content: [
              { type: "text", text: "/compact" },
              { type: "image", image: "https://files.test/a.png" },
            ],
          },
        ],
        requestedMode: "steer",
      }),
    ).toBe("steer");
  });
});

describe("queued /compact on an async run", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  function compactEvent(
    overrides: Partial<DirectInboundEvent> = {},
  ): DirectInboundEvent {
    return {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [{ role: "user", content: "/compact keep the deploy" }],
      agentConfig: {},
      ownerGeneration: 1,
      ...overrides,
    };
  }

  it("summarizes instead of running the model and answers with the summary count", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    const takeNext = spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    const turn = spyOn(Session.prototype, "createTurnContext");
    const compact = spyOn(
      Session.prototype,
      "compactConversation",
    ).mockResolvedValue(5);

    await handler({ kind: "direct-api-async-worker", event: compactEvent() });

    expect(compact).toHaveBeenCalledWith("keep the deploy");
    expect(turn).not.toHaveBeenCalled();
    expect(settle.mock.calls[0]?.[0]).toMatchObject({
      status: "completed",
      result: "Context compacted. 5 message(s) summarized.",
      asyncResult: {
        outcome: {
          status: "completed",
          response: "Context compacted. 5 message(s) summarized.",
        },
      },
    });
    // The queue drains on behind it.
    expect(takeNext).toHaveBeenCalledTimes(1);
  });

  it("fails the run with the summary's own error", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(Session.prototype, "compactConversation").mockRejectedValue(
      new Error("summary model down"),
    );

    await handler({ kind: "direct-api-async-worker", event: compactEvent() });

    expect(settle.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      error: "summary model down",
      asyncResult: {
        outcome: { status: "failed", error: "summary model down" },
      },
    });
  });

  it("runs the model for a /compact a command-less channel sent", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    const turn = spyOn(
      Session.prototype,
      "createTurnContext",
    ).mockResolvedValue({
      messages: [],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    });
    const compact = spyOn(Session.prototype, "compactConversation");

    await handler({
      kind: "direct-api-async-worker",
      event: compactEvent({
        replyTarget: { channelName: "pancake", source: {} },
      }),
    }).catch((): null => null);

    expect(compact).not.toHaveBeenCalled();
    expect(turn).toHaveBeenCalledTimes(1);
  });
});

describe("live owners at shutdown", (): void => {
  const HELD = "acct:acct_1:agent:agent_1:api:held";
  const DONE = "acct:acct_1:agent:agent_1:api:done";
  const MOVED = "acct:acct_1:agent:agent_1:api:moved";

  it("hands back only the leases this process still holds", async (): Promise<void> => {
    const calls: [string, Record<string, unknown>][] = [];
    runtime.mutate = (async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push([name, args]);
      if (name === "acceptIngress") {
        return { outcome: "owner", ownerGeneration: 3 };
      }
      if (name === "takeNextIngress") {
        return { eventId: "moved-next", ownerGeneration: 4 };
      }

      return true;
    }) as never;
    // Leases earlier tests left in the module registry.
    await interruptLiveOwners("reset");
    const owners: [string, string][] = [
      [HELD, "held"],
      [DONE, "done"],
      [MOVED, "moved"],
    ];
    for (const [conversationKey, eventId] of owners) {
      await acceptIngress({
        ...candidate(),
        conversationKey: conversationKey,
        eventId: eventId,
      });
    }
    await releaseIngressOwner({
      conversationKey: DONE,
      ownerEventId: "done",
      ownerGeneration: 3,
    });
    await takeNextIngress({
      conversationKey: MOVED,
      ownerEventId: "moved",
      ownerGeneration: 3,
    });
    calls.length = 0;

    expect(await interruptLiveOwners("restarting")).toBe(2);
    // The released lease is gone; the transferred one is interrupted at its
    // new generation, never the one it moved on from.
    expect(calls).toEqual(
      expect.arrayContaining([
        [
          "settleIngress",
          {
            conversationKey: HELD,
            ownerEventId: "held",
            ownerGeneration: 3,
            status: "failed",
            error: "restarting",
          },
        ],
        [
          "releaseIngressOwner",
          { conversationKey: HELD, ownerEventId: "held", ownerGeneration: 3 },
        ],
        [
          "releaseIngressOwner",
          {
            conversationKey: MOVED,
            ownerEventId: "moved-next",
            ownerGeneration: 4,
          },
        ],
      ]),
    );
    expect(calls).toHaveLength(4);
    expect(await interruptLiveOwners("again")).toBe(0);
  });
});

describe("applied ingress config", (): void => {
  afterEach((): void => {
    resetStorageForTests();
  });

  it("rebuilds a direct envelope from the live agent with its model override, in one read", async (): Promise<void> => {
    const reads: string[] = [];
    setStorageForTests({
      agents: {
        getById: async (_accountId: string, agentId: string) => {
          reads.push(agentId);

          return agentRecord({
            model: { provider: "openai", modelId: "gpt-5", temperature: 0 },
            provider: { openai: { apiKey: "sk-live" } },
          });
        },
      },
    } as never);

    const config = await loadAppliedIngressConfig({
      accountId: "acct_test",
      agentId: "agent_test",
      configRef: { model: { temperature: 0.7 } },
    });

    expect(config.model).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      temperature: 0.7,
    });
    expect(config.provider).toEqual({ openai: { apiKey: "sk-live" } });
    expect(reads).toEqual(["agent_test"]);
  });

  it("rebuilds a channel envelope through its pinned record", async (): Promise<void> => {
    setStorageForTests({
      agents: {
        getById: async (): Promise<AgentRecord> =>
          agentRecord({ channels: { telegram: { botToken: "rotated" } } }),
      },
      channelRecords: {
        getById: async (): Promise<ChannelRecord> =>
          channelRecord("agent_test"),
      },
    } as never);

    const config = await loadAppliedIngressConfig({
      accountId: "acct_test",
      agentId: "agent_test",
      configRef: {
        channel: { channelName: "telegram", channelRecordId: "rec_1" },
      },
    });

    expect(config.channels).toEqual({ telegram: { botToken: "rotated" } });
  });

  it("fails clearly when the agent was deleted while the envelope waited", async (): Promise<void> => {
    setStorageForTests({
      agents: { getById: async (): Promise<null> => null },
    } as never);

    expect(
      loadAppliedIngressConfig({
        accountId: "acct_test",
        agentId: "agent_test",
        configRef: {},
      }),
    ).rejects.toThrow("Agent not found: agent_test");
  });

  it("runs a subagent's ref-less envelope on its scope's config without a read", async (): Promise<void> => {
    setStorageForTests({
      agents: {
        getById: async (): Promise<never> => {
          throw new Error("must not read");
        },
      },
    } as never);
    const subagentConfig: AgentConfig = {
      model: { provider: "openai", modelId: "gpt-5" },
    };

    expect(
      loadAppliedIngressConfig({
        accountId: "acct_test",
        agentId: "agent_test",
        configRef: undefined,
        subagentConfig: subagentConfig,
      }),
    ).resolves.toBe(subagentConfig);
  });

  it("fails any other ref-less envelope instead of running it on a guessed config", async (): Promise<void> => {
    expect(
      loadAppliedIngressConfig({
        accountId: "acct_test",
        agentId: "agent_test",
        configRef: undefined,
      }),
    ).rejects.toThrow("Queued turn was admitted before config refs; retry");
  });
});

describe("session messages", (): void => {
  afterEach((): void => {
    resetStorageForTests();
  });

  it("builds a follow-up for another channel session", async (): Promise<void> => {
    const target: ConversationDispatchTarget = {
      channelName: "telegram",
      source: { chatId: "target-chat" },
    };
    const agentConfig = { channels: { telegram: { botToken: "rotated" } } };
    setStorageForTests({
      agents: {
        getById: async (): Promise<AgentRecord> => agentRecord(agentConfig),
      },
    } as never);
    let queryArgs: Record<string, unknown> | undefined;
    runtime.query = async function <T>(
      name: Parameters<typeof runtime.query>[0],
      args: Record<string, unknown>,
    ): Promise<T> {
      expect(name).toBe("getConversationTarget");
      queryArgs = args;

      return target as T;
    };
    const prepared = await prepareSessionMessage({
      accountId: "acct_test",
      agentId: "agent_test",
      sourceConversationKey: "acct:acct_test:agent:agent_test:tg:source-chat",
      input: {
        conversationKey: "tg:target-chat",
        message: "Please follow up",
      },
    });

    expect(queryArgs).toEqual({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
    });
    expect(prepared.agentConfig).toEqual(agentConfig);
    expect(prepared.candidate).not.toHaveProperty("agentConfig");
    expect(prepared.candidate).toMatchObject({
      configRef: { channel: { channelName: "telegram" } },
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
      delivery: {
        kind: "channel",
        channel: "telegram",
        source: { chatId: "target-chat" },
      },
      requestedMode: "followup",
      events: [
        {
          role: "user",
          content:
            "[Inter-session message from tg:source-chat]\nPlease follow up",
        },
      ],
    });
    expect(prepared.publicConversationKey).toBe("tg:target-chat");
  });

  // The record a session ran through is gone, or now binds another agent.
  for (const [name, refs, record] of [
    [
      "a cross-agent session whose record is gone",
      { credentialAgentId: "agent_holder", channelRecordId: "rec_1" },
      null,
    ],
    [
      "a session whose pinned record is gone",
      { channelRecordId: "rec_1" },
      null,
    ],
    [
      "a session whose record now binds another agent",
      { channelRecordId: "rec_1" },
      channelRecord("agent_other"),
    ],
  ] as const) {
    it(`refuses ${name}`, async (): Promise<void> => {
      runtime.query = (async (): Promise<ConversationDispatchTarget> => ({
        channelName: "telegram",
        source: { chatId: "target-chat" },
        ...refs,
      })) as never;
      setStorageForTests({
        agents: {
          getById: async (): Promise<AgentRecord> => agentRecord({}),
        },
        channelRecords: {
          getById: async (): Promise<ChannelRecord | null> => record,
        },
      } as never);

      const refusal = await prepareSessionMessage({
        accountId: "acct_test",
        agentId: "agent_test",
        sourceConversationKey: "acct:acct_test:agent:agent_test:tg:source-chat",
        input: { conversationKey: "tg:target-chat", message: "hi" },
      }).catch((err: unknown): unknown => err);

      expect(refusal).toEqual(
        new Error("Channel session is no longer bound to this agent"),
      );
    });
  }

  it("rejects the current conversation and another agent's conversation", async (): Promise<void> => {
    const options = {
      accountId: "acct_test",
      agentId: "agent_test",
      sourceConversationKey: "acct:acct_test:agent:agent_test:tg:source-chat",
    };

    expect(
      prepareSessionMessage({
        ...options,
        input: { conversationKey: "tg:source-chat", message: "loop" },
      }),
    ).rejects.toThrow("cannot target the current conversation");
    expect(
      prepareSessionMessage({
        ...options,
        input: {
          conversationKey:
            "acct:acct_test:agent:agent_other:tg:another-conversation",
          message: "cross-agent",
        },
      }),
    ).rejects.toThrow("must belong to the current agent");
  });

  it("refuses a chat that has never messaged the bot", async (): Promise<void> => {
    // No coordinator row means no stored channel target, which is every group
    // the bot was added to but that has not spoken yet.
    runtime.query = async function <T>(): Promise<T> {
      return null as T;
    };

    expect(
      prepareSessionMessage({
        accountId: "acct_test",
        agentId: "agent_test",
        sourceConversationKey:
          "acct:acct_test:agent:agent_test:zalo:zgr-internal",
        input: {
          conversationKey: "zalo:zgr-silent-group",
          message: "Chương trình Trung Thu",
        },
      }),
    ).rejects.toThrow("not an existing channel session");
  });
});

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
  prepareSessionMessage,
  releaseIngressOwner,
  takeNextIngress,
  type AppliedIngress,
  type ConversationDispatchTarget,
  type IngressCandidate,
} from "../src/harness/ingress.ts";
import * as harness from "../src/harness/harness.ts";
import * as ingress from "../src/harness/ingress.ts";
import type {
  ChannelInboundEvent,
  DirectInboundEvent,
} from "../src/harness/integrations.ts";
import { Session } from "../src/harness/session.ts";
import { getStorage } from "../src/shared/storage.ts";

const originalMutate = runtime.mutate;
const originalQuery = runtime.query;

afterEach(() => {
  runtime.mutate = originalMutate;
  runtime.query = originalQuery;
});

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
    const agentConfig = { channels: { telegram: { botToken: "secret" } } };

    await acceptIngress({
      ...candidate(),
      agentConfig: agentConfig,
      delivery: {
        kind: "channel",
        channel: "telegram",
        identity: { userId: "U2", userRoles: ["dev"] },
        source: { chatId: "chat-1" },
      },
    });

    expect(call?.channelTarget).toEqual({
      agentConfig: agentConfig,
      channelName: "telegram",
      source: { chatId: "chat-1" },
    });
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
      agentConfig: { model: { temperature: 0.1 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });
    await acceptIngress({
      ...candidate(),
      agentConfig: { model: { temperature: 0.9 } },
    });
    await acceptIngress(candidate());

    const [first, second, third] = calls;
    expect(first!.agentConfig).toEqual({ model: { temperature: 0.1 } });
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

describe("async turn without model input", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  it("settles the envelope with its own reason when the cron settle fails", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockResolvedValue(null);
    spyOn(Session.prototype, "appendIngressEvents").mockResolvedValue([]);
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
    spyOn(Session.prototype, "appendIngressEvents").mockResolvedValue([]);
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

    expect(failRun).toHaveBeenCalledWith(
      "acct_1",
      "cron_1",
      "run_1",
      "convex down",
    );
  });
});

describe("async turn that throws after it settles", (): void => {
  afterEach((): void => {
    mock.restore();
  });

  it("keeps the completed result when the next dispatch throws", async (): Promise<void> => {
    const writes: Array<{ name: string; status?: unknown }> = [];
    spyOn(runtime, "mutate").mockImplementation((async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      writes.push({ name: name, status: args.status });

      return null;
    }) as never);
    spyOn(runtime, "query").mockResolvedValue(null as never);
    const settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(ingress, "takeNextIngress").mockRejectedValue(
      new Error("takeNext failed"),
    );
    spyOn(Session.prototype, "appendIngressEvents").mockResolvedValue([]);
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
      reply: { onFinalText(response: string): Promise<void> },
    ) => {
      await reply.onFinalText("answer");

      return {
        traceId: (): undefined => undefined,
        consumeStream: async (): Promise<void> => {},
        questionSummaries: (): [] => [],
        didFail: (): boolean => false,
        failureText: (): null => null,
      };
    }) as never);
    const event: DirectInboundEvent = {
      ...candidate(),
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
      events: [],
      agentConfig: {},
      ownerGeneration: 1,
    };

    const error = await handler({
      kind: "direct-api-async-worker",
      event: event,
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
  };
  const originalAppend = Session.prototype.appendIngressEvents;
  let senders: unknown[];

  beforeEach((): void => {
    senders = [];
    runtime.query = (async (name: string): Promise<[] | null> =>
      name === "listPendingAsyncToolResults" ? [] : null) as never;
    // Ends each turn before the model runs; only the session's sender matters.
    Session.prototype.appendIngressEvents = async function (
      this: Session,
    ): Promise<never> {
      senders.push(
        this.delivery?.kind === "channel" ? this.delivery.identity : undefined,
      );
      throw new Error("stop before the model");
    };
  });

  afterEach((): void => {
    Session.prototype.appendIngressEvents = originalAppend;
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

describe("session messages", (): void => {
  it("builds a follow-up for another channel session", async (): Promise<void> => {
    const target: ConversationDispatchTarget = {
      agentConfig: { channels: { telegram: { botToken: "secret" } } },
      channelName: "telegram",
      source: { chatId: "target-chat" },
    };
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
    expect(prepared.candidate).toMatchObject({
      agentConfig: target.agentConfig,
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

  it("rejects the current conversation and another agent's conversation", async (): Promise<void> => {
    const options = {
      accountId: "acct_test",
      agentId: "agent_test",
      sourceConversationKey: "acct:acct_test:agent:agent_test:tg:source-chat",
    };

    await expect(
      prepareSessionMessage({
        ...options,
        input: { conversationKey: "tg:source-chat", message: "loop" },
      }),
    ).rejects.toThrow("cannot target the current conversation");
    await expect(
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

    await expect(
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

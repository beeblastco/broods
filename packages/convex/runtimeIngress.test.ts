/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Creates an isolated Convex test runtime. */
function runtimeTest() {
  return convexTest(schema, modules);
}

/** Creates one active account for ingress tests. */
async function createActiveAccount(t: ReturnType<typeof runtimeTest>) {
  const now = Date.now();

  return await t.run(
    async (ctx) =>
      await ctx.db.insert("accounts", {
        orgId: `org-${crypto.randomUUID()}`,
        username: `user-${crypto.randomUUID()}`,
        secretHash: crypto.randomUUID(),
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
  );
}

/** Builds one fully scoped conversation key. */
function conversationKeyFor(accountId: string): string {
  return `acct:${accountId}:agent:test-agent:api:test-conversation`;
}

/** Builds the common admission arguments for one candidate. */
function admission(options: {
  accountId: Id<"accounts">;
  conversationKey: string;
  eventId: string;
  mode: "reject" | "followup" | "collect" | "steer";
  idempotencyKey?: string;
  payloadDigest?: string;
  sizeBytes?: number;
}) {
  return {
    accountId: options.accountId,
    agentId: "test-agent",
    conversationKey: options.conversationKey,
    eventId: options.eventId,
    idempotencyKey: options.idempotencyKey ?? options.eventId,
    payloadDigest: options.payloadDigest ?? `digest:${options.eventId}`,
    events: [{ role: "user", content: options.eventId }],
    delivery: { kind: "async" },
    requestedMode: options.mode,
    sizeBytes: options.sizeBytes ?? 32,
    leaseTtlMs: 60_000,
    envelopeTtlMs: 60_000,
    statusTtlMs: 7 * 24 * 60 * 60 * 1000,
    maxQueuedCount: 100,
    maxQueuedBytes: 1024 * 1024,
  };
}

describe("runtime ingress", () => {
  test("remembers the latest channel target for session messaging", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const channelTarget = {
      agentConfig: { channels: { telegram: { botToken: "secret" } } },
      channelName: "telegram",
      source: { chatId: "chat-1", messageId: "message-1" },
    };
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "channel-session",
        mode: "followup",
      }),
      channelTarget: channelTarget,
      delivery: {
        kind: "channel",
        channel: "telegram",
        source: channelTarget.source,
      },
    });

    expect(
      await t.query(internal.runtimeIngress.getConversationTarget, {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
      }),
    ).toEqual(channelTarget);
  });

  test("returns only narrowed public deployment ingress provenance from delivery", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "public-owner",
        mode: "reject",
      }),
      delivery: {
        kind: "websocket",
        publicDeploymentIngress: {
          accountId: accountId,
          endpointId: "endpoint-one",
          stageSlug: "development",
          projectSlug: "demo",
          ignored: "not-returned",
        },
      },
    });

    expect(
      (
        await t.query(internal.runtimeIngress.getStatus, {
          accountId: accountId,
          agentId: "test-agent",
          eventId: "public-owner",
        })
      )?.publicDeploymentIngress,
    ).toEqual({
      accountId: accountId,
      endpointId: "endpoint-one",
      stageSlug: "development",
      projectSlug: "demo",
    });
  });

  test("ignores forged public deployment provenance on channel delivery", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "channel-owner",
        mode: "reject",
      }),
      delivery: {
        kind: "channel",
        publicDeploymentIngress: {
          accountId: accountId,
          endpointId: "endpoint-one",
          stageSlug: "development",
          projectSlug: "demo",
        },
      },
    });

    const status = await t.query(internal.runtimeIngress.getStatus, {
      accountId: accountId,
      agentId: "test-agent",
      eventId: "channel-owner",
    });

    // Assert the row was found first: the negative below holds for null too.
    expect(status?.eventId).toBe("channel-owner");
    expect(status).not.toHaveProperty("publicDeploymentIngress");
  });

  for (const [kind, marker] of [
    [
      "http",
      {
        accountId: 42,
        endpointId: "endpoint-one",
        stageSlug: "development",
        projectSlug: "demo",
      },
    ],
    ["async", "client-asserted-marker"],
  ] as const) {
    test(`ignores malformed public deployment provenance on ${kind} delivery`, async () => {
      const t = runtimeTest();
      const accountId = await createActiveAccount(t);
      const eventId = `${kind}-owner`;
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId: accountId,
          conversationKey: `acct:${accountId}:agent:test-agent:api:${eventId}`,
          eventId: eventId,
          mode: "reject",
        }),
        delivery: {
          kind: kind,
          publicDeploymentIngress: marker,
        },
      });

      expect(
        await t.query(internal.runtimeIngress.getStatus, {
          accountId: accountId,
          agentId: "test-agent",
          eventId: eventId,
        }),
      ).not.toHaveProperty("publicDeploymentIngress");
    });
  }

  test("atomically owns, rejects, queues, and deduplicates candidates", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    expect(owner).toMatchObject({
      outcome: "owner",
      ownerGeneration: 1,
      status: "processing",
      sequence: 1,
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({
      requestedMode: "reject",
      appliedMode: "reject",
      appliedToEventId: "owner",
    });
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "rejected",
          mode: "reject",
        }),
      ),
    ).toEqual({ outcome: "rejected" });
    const queued = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued",
        mode: "followup",
      }),
    );
    expect(queued).toMatchObject({
      outcome: "queued",
      status: "queued",
      sequence: 2,
    });
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "queued",
          mode: "followup",
        }),
      ),
    ).toMatchObject({
      outcome: "duplicate",
      eventId: "queued",
      status: "queued",
    });
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "different-event-id",
          idempotencyKey: "queued",
          payloadDigest: "different",
          mode: "followup",
        }),
      ),
    ).toEqual({ outcome: "conflict", eventId: "queued" });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("runtimeIngressEnvelopes").collect(),
    );
    expect(rows.map((row) => row.eventId)).toEqual(["owner", "queued"]);
  });

  test("applies steering at the current fenced owner boundary", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "steer-1",
        mode: "steer",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "steer-2",
        mode: "steer",
      }),
    );
    const applied = await t.mutation(internal.runtimeIngress.applySteering, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
    });
    expect(applied).toMatchObject({
      appliedMode: "steer",
      appliedToEventId: "owner",
      contributingEventIds: ["steer-1", "steer-2"],
    });
    expect(applied?.events.map((event) => event.content)).toEqual([
      "steer-1",
      "steer-2",
    ]);
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "completed",
      result: "done",
    });
    for (const eventId of ["owner", "steer-1", "steer-2"]) {
      expect(
        await t.query(internal.runtimeIngress.getStatus, {
          accountId: accountId,
          agentId: "test-agent",
          eventId: eventId,
        }),
      ).toMatchObject({ status: "completed", result: "done" });
    }
  });

  test("applies only the contiguous FIFO steer prefix", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "steer",
      }),
    );
    for (const [eventId, mode] of [
      ["steer-1", "steer"],
      ["steer-2", "steer"],
      ["followup", "followup"],
      ["steer-later", "steer"],
    ] as const) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: eventId,
          mode: mode,
        }),
      );
    }

    const applied = await t.mutation(internal.runtimeIngress.applySteering, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
    });
    expect(applied?.contributingEventIds).toEqual(["steer-1", "steer-2"]);
    const queued = await t.run(
      async (ctx) =>
        await ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
            q.eq("conversationKey", conversationKey).eq("status", "queued"),
          )
          .collect(),
    );
    expect(queued.map((row) => row.eventId)).toEqual([
      "followup",
      "steer-later",
    ]);
  });

  test("collects contiguous FIFO contributors and falls back missed steer to followup", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    for (const eventId of ["collect-1", "collect-2"]) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: eventId,
          mode: "collect",
        }),
      );
    }
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "late-steer",
        mode: "steer",
      }),
    );
    const collected = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
    });
    expect(collected).toMatchObject({
      eventId: "collect-1",
      appliedMode: "collect",
      contributingEventIds: ["collect-1", "collect-2"],
      ownerGeneration: 2,
    });
    const followup = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "collect-1",
      ownerGeneration: collected!.ownerGeneration,
      leaseTtlMs: 60_000,
    });
    expect(followup).toMatchObject({
      eventId: "late-steer",
      requestedMode: "steer",
      appliedMode: "followup",
      ownerGeneration: 3,
    });
  });

  test("requests a boundary stop and promotes queued work after settlement", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "steer",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued-followup",
        mode: "followup",
      }),
    );

    expect(
      await t.mutation(internal.runtimeIngress.stopOwner, {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
      }),
    ).toEqual({ stopped: true, queuedCount: 1 });
    expect(
      await t.mutation(internal.runtimeIngress.renewOwner, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
      }),
    ).toBe("stopped");
    expect(
      await t.query(internal.runtimeIngress.isCurrentOwner, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
      }),
    ).toBe(true);

    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "failed",
      error: "Stopped by user at the model boundary",
    });
    const next = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
    });
    expect(next).toMatchObject({
      eventId: "queued-followup",
      appliedMode: "followup",
      ownerGeneration: 2,
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({
      status: "failed",
      error: "Stopped by user at the model boundary",
      stoppedByUser: true,
    });
  });

  test("a genuine failure is not flagged stoppedByUser", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    // Fail without any /stop request for this generation.
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "failed",
      error: "Model provider returned 503",
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      (
        await t.query(internal.runtimeIngress.getStatus, {
          accountId: accountId,
          agentId: "test-agent",
          eventId: "owner",
        })
      )?.stoppedByUser,
    ).toBeUndefined();
  });

  test("rejects stale owner writes after a new generation acquires the conversation", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const first = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "first",
        mode: "reject",
      }),
    );
    expect(
      await t.mutation(internal.runtimeIngress.releaseOwner, {
        conversationKey: conversationKey,
        ownerEventId: "first",
        ownerGeneration: first.ownerGeneration!,
      }),
    ).toBe(true);
    const second = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "second",
        mode: "reject",
      }),
    );
    expect(second.ownerGeneration).toBe(2);
    await expect(
      t.mutation(internal.runtimeIngress.appendConversationEvent, {
        conversationKey: conversationKey,
        ownerEventId: "first",
        ownerGeneration: first.ownerGeneration!,
        cursor: "001",
        event: { role: "user", content: "stale" },
      }),
    ).rejects.toThrow("Stale conversation owner generation");
  });

  test("returns capacity without silently dropping accepted FIFO rows", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    const first = {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "one",
        mode: "followup",
        sizeBytes: 60,
      }),
      maxQueuedCount: 1,
      maxQueuedBytes: 100,
    };
    expect(
      await t.mutation(internal.runtimeIngress.accept, first),
    ).toMatchObject({ outcome: "queued" });
    const second = {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "two",
        mode: "followup",
        sizeBytes: 1,
      }),
      maxQueuedCount: 1,
      maxQueuedBytes: 100,
    };
    expect(await t.mutation(internal.runtimeIngress.accept, second)).toEqual({
      outcome: "capacity",
    });
    const queued = await t.run(
      async (ctx) =>
        await ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
            q.eq("conversationKey", conversationKey).eq("status", "queued"),
          )
          .collect(),
    );
    expect(queued.map((row) => row.eventId)).toEqual(["one"]);
  });

  test("maintenance terminalizes expired accepted queue work", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued",
        mode: "followup",
      }),
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_eventId", (q) => q.eq("eventId", "queued"))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    expect(
      await t.mutation(internal.runtimeIngress.maintain, {}),
    ).toMatchObject({ expired: 1 });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "queued",
      }),
    ).toMatchObject({ status: "expired" });
  });

  test("recovers an expired owner by promoting the oldest queued event before a new arrival", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued-first",
        mode: "followup",
      }),
    );
    await t.run(async (ctx) => {
      const coordinator = await ctx.db
        .query("runtimeConversationCoordinators")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", conversationKey),
        )
        .unique();
      await ctx.db.patch(coordinator!._id, { leaseExpiresAt: Date.now() - 1 });
    });

    const arrival = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "late-arrival",
        mode: "followup",
      }),
    );
    expect(arrival).toMatchObject({
      outcome: "queued",
      recovered: {
        eventId: "queued-first",
        appliedMode: "followup",
        ownerGeneration: 2,
      },
    });
    const coordinator = await t.run(
      async (ctx) =>
        await ctx.db
          .query("runtimeConversationCoordinators")
          .withIndex("by_conversationKey", (q) =>
            q.eq("conversationKey", conversationKey),
          )
          .unique(),
    );
    expect(coordinator).toMatchObject({
      ownerEventId: "queued-first",
      ownerGeneration: 2,
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({ status: "expired" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "queued-first",
      }),
    ).toMatchObject({ status: "processing" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "late-arrival",
      }),
    ).toMatchObject({ status: "queued" });
  });

  test("returns the queued envelope's own execution context on takeNext", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued-context",
        mode: "followup",
      }),
      agentConfig: { model: { temperature: 0.9 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });

    const next = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
    });
    expect(next).toMatchObject({
      eventId: "queued-context",
      ownerGeneration: 2,
      agentConfig: { model: { temperature: 0.9 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });
  });

  test("settles the owner and more than one drain batch of steering contributors", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    for (let index = 0; index < 120; index += 1) {
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: `steer-${index}`,
          mode: "steer",
        }),
        maxQueuedCount: 300,
      });
    }
    // Two boundary applications: each drains at most one batch of steer rows.
    for (let round = 0; round < 2; round += 1) {
      await t.mutation(internal.runtimeIngress.applySteering, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
      });
    }

    const settled = await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "completed",
    });
    expect(settled).toBe(121);
    const processing = await t.run(
      async (ctx) =>
        await ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
            q.eq("conversationKey", conversationKey).eq("status", "processing"),
          )
          .collect(),
    );
    expect(processing).toEqual([]);
  });

  test("maintenance expires overdue queued work despite a full batch of retained terminal rows", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 100; index += 1) {
        await ctx.db.insert("runtimeIngressEnvelopes", {
          accountId: accountId,
          agentId: "test-agent",
          conversationKey: conversationKey,
          sequence: index + 1,
          eventId: `terminal-${index}`,
          identity: `identity-terminal-${index}`,
          idempotencyKey: `terminal-${index}`,
          payloadDigest: "digest",
          events: [],
          delivery: { kind: "async" },
          requestedMode: "followup",
          status: "completed",
          sizeBytes: 1,
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
          expiresAt: now - 1,
          statusExpiresAt: now + 60_000,
        });
      }
      await ctx.db.insert("runtimeIngressEnvelopes", {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
        sequence: 500,
        eventId: "overdue-queued",
        identity: "identity-overdue-queued",
        idempotencyKey: "overdue-queued",
        payloadDigest: "digest",
        events: [],
        delivery: { kind: "async" },
        requestedMode: "followup",
        status: "queued",
        sizeBytes: 1,
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
        expiresAt: now - 1,
        statusExpiresAt: now + 60_000,
      });
    });

    expect(
      await t.mutation(internal.runtimeIngress.maintain, {}),
    ).toMatchObject({ expired: 1 });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "overdue-queued",
      }),
    ).toMatchObject({ status: "expired" });
  });
});

describe("maintain (I/O-surgical expiry)", () => {
  /** Inserts one envelope row directly with controlled status/expiry fields. */
  async function seedEnvelope(
    t: ReturnType<typeof runtimeTest>,
    accountId: Id<"accounts">,
    options: {
      eventId: string;
      status: "queued" | "processing" | "completed" | "failed" | "expired";
      expiresAt: number;
      statusExpiresAt: number;
    },
  ) {
    const now = Date.now();

    return await t.run(
      async (ctx) =>
        await ctx.db.insert("runtimeIngressEnvelopes", {
          accountId: accountId,
          agentId: "test-agent",
          conversationKey: conversationKeyFor(accountId),
          sequence: 0,
          eventId: options.eventId,
          identity: `identity:${options.eventId}`,
          idempotencyKey: options.eventId,
          payloadDigest: `digest:${options.eventId}`,
          events: [{ role: "user", content: options.eventId }],
          delivery: { kind: "async" },
          requestedMode: "collect",
          status: options.status,
          sizeBytes: 32,
          createdAt: now,
          updatedAt: now,
          expiresAt: options.expiresAt,
          statusExpiresAt: options.statusExpiresAt,
        }),
    );
  }

  test("expires overdue queued work, deletes retained terminal rows past retention, keeps the rest", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const now = Date.now();
    const past = now - 60_000;
    const future = now + 60_000;

    // Overdue non-terminal → must be expired.
    const overdueQueued = await seedEnvelope(t, accountId, {
      eventId: "overdue-queued",
      status: "queued",
      expiresAt: past,
      statusExpiresAt: future,
    });
    // Terminal, envelope TTL long past but retention still running → the
    // pre-fix scan re-read exactly these rows every minute; they must simply
    // survive untouched.
    const retainedCompleted = await seedEnvelope(t, accountId, {
      eventId: "retained-completed",
      status: "completed",
      expiresAt: past,
      statusExpiresAt: future,
    });
    // Terminal and past retention → must be deleted.
    const doneFailed = await seedEnvelope(t, accountId, {
      eventId: "done-failed",
      status: "failed",
      expiresAt: past,
      statusExpiresAt: past,
    });
    // Non-terminal but not yet due → untouched.
    const freshQueued = await seedEnvelope(t, accountId, {
      eventId: "fresh-queued",
      status: "queued",
      expiresAt: future,
      statusExpiresAt: future,
    });

    const result = await t.mutation(internal.runtimeIngress.maintain, {});
    expect(result.expired).toBe(1);
    expect(result.deleted).toBe(1);

    await t.run(async (ctx) => {
      const expiredRow = await ctx.db.get(overdueQueued);
      expect(expiredRow?.status).toBe("expired");
      expect(expiredRow?.error).toContain("expired before it reached");

      expect((await ctx.db.get(retainedCompleted))?.status).toBe("completed");
      expect(await ctx.db.get(doneFailed)).toBeNull();
      expect((await ctx.db.get(freshQueued))?.status).toBe("queued");
    });
  });
});

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
  test("atomically owns, rejects, queues, and deduplicates candidates", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
        accountId,
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
          accountId,
          conversationKey,
          eventId: "rejected",
          mode: "reject",
        }),
      ),
    ).toEqual({ outcome: "rejected" });
    const queued = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
          accountId,
          conversationKey,
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
          accountId,
          conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
        eventId: "steer-1",
        mode: "steer",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
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
        admission({ accountId, conversationKey, eventId, mode }),
      );
    }

    const applied = await t.mutation(internal.runtimeIngress.applySteering, {
      conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    for (const eventId of ["collect-1", "collect-2"]) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({ accountId, conversationKey, eventId, mode: "collect" }),
      );
    }
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "steer",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
        eventId: "queued-followup",
        mode: "followup",
      }),
    );

    expect(
      await t.mutation(internal.runtimeIngress.stopOwner, {
        accountId,
        agentId: "test-agent",
        conversationKey,
      }),
    ).toEqual({ stopped: true, queuedCount: 1 });
    expect(
      await t.mutation(internal.runtimeIngress.renewOwner, {
        conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
      }),
    ).toBe("stopped");
    expect(
      await t.query(internal.runtimeIngress.isCurrentOwner, {
        conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
      }),
    ).toBe(true);

    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "failed",
      error: "Stopped by user at the model boundary",
    });
    const next = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey,
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
        accountId,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    // Fail without any /stop request for this generation.
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "failed",
      error: "Model provider returned 503",
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      (
        await t.query(internal.runtimeIngress.getStatus, {
          accountId,
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
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    const first = {
      ...admission({
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
        accountId,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId,
        conversationKey,
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
        accountId,
        conversationKey,
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
        accountId,
        agentId: "test-agent",
        eventId: "owner",
      }),
    ).toMatchObject({ status: "expired" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId,
        agentId: "test-agent",
        eventId: "queued-first",
      }),
    ).toMatchObject({ status: "processing" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId,
        conversationKey,
        eventId: "queued-context",
        mode: "followup",
      }),
      agentConfig: { model: { temperature: 0.9 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });

    const next = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey,
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
        accountId,
        conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );
    for (let index = 0; index < 120; index += 1) {
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId,
          conversationKey,
          eventId: `steer-${index}`,
          mode: "steer",
        }),
        maxQueuedCount: 300,
      });
    }
    // Two boundary applications: each drains at most one batch of steer rows.
    for (let round = 0; round < 2; round += 1) {
      await t.mutation(internal.runtimeIngress.applySteering, {
        conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
      });
    }

    const settled = await t.mutation(internal.runtimeIngress.settle, {
      conversationKey,
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
        accountId,
        agentId: "test-agent",
        eventId: "overdue-queued",
      }),
    ).toMatchObject({ status: "expired" });
  });
});

/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import schema from "../schema";
import {
  asyncToolResultDedupeKey,
  subagentResultDedupeKey,
} from "../model/subagentResults";

const modules = import.meta.glob("../**/*.ts");

function runtimeTest(): TestConvex<typeof schema> {
  return convexTest(schema, modules);
}

async function createActiveAccount(
  t: ReturnType<typeof runtimeTest>,
): Promise<Id<"accounts">> {
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

function conversationKeyFor(accountId: string): string {
  return `acct:${accountId}:agent:test-agent:api:test-conversation`;
}

function admission(options: {
  activeOwnerOnly?: boolean;
  expectedOwnerTaskId?: string;
  ownerTaskId?: string;
  accountId: Id<"accounts">;
  conversationKey: string;
  eventId: string;
  runId?: string;
  mode: "reject" | "followup" | "collect" | "steer";
  idempotencyKey?: string;
  payloadDigest?: string;
  sizeBytes?: number;
}) {
  return {
    ...(options.activeOwnerOnly !== undefined
      ? { activeOwnerOnly: options.activeOwnerOnly }
      : {}),
    ...(options.expectedOwnerTaskId !== undefined
      ? { expectedOwnerTaskId: options.expectedOwnerTaskId }
      : {}),
    ...(options.ownerTaskId !== undefined
      ? { ownerTaskId: options.ownerTaskId }
      : {}),
    accountId: options.accountId,
    agentId: "test-agent",
    conversationKey: options.conversationKey,
    eventId: options.eventId,
    runId: options.runId ?? `run_${options.eventId}`,
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
      channelName: "telegram",
      source: { chatId: "chat-1", messageId: "message-1" },
      channelRecordId: "rec-1",
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
          runId: "run_public-owner",
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
      runId: "run_channel-owner",
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
          runId: `run_${eventId}`,
        }),
      ).not.toHaveProperty("publicDeploymentIngress");
    });
  }

  test("an idempotent retry keeps the first admission's run id", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const first = admission({
      accountId: accountId,
      conversationKey: conversationKey,
      eventId: "retried",
      runId: "run_first",
      mode: "reject",
    });
    await t.mutation(internal.runtimeIngress.accept, first);

    // Same identity and payload, freshly minted run id: the stored one wins, so
    // the caller keeps polling one run rather than a second that never existed.
    const retry = await t.mutation(internal.runtimeIngress.accept, {
      ...first,
      runId: "run_second",
    });

    expect(retry).toMatchObject({ outcome: "duplicate", runId: "run_first" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_second",
      }),
    ).toBeNull();
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_first",
      }),
    ).toMatchObject({ agentId: "test-agent", status: "processing" });
  });

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
        runId: "run_owner",
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

  test("queues control only while the conversation has an active owner", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          activeOwnerOnly: true,
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "late-control",
          mode: "steer",
        }),
      ),
    ).toEqual({ outcome: "not_running" });
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("runtimeIngressEnvelopes").collect(),
      ),
    ).toEqual([]);

    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
        ownerTaskId: "owner-task",
      }),
    );
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          activeOwnerOnly: true,
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "active-control",
          expectedOwnerTaskId: "owner-task",
          mode: "steer",
        }),
      ),
    ).toMatchObject({
      outcome: "queued",
      status: "queued",
    });

    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          activeOwnerOnly: true,
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "stale-task-control",
          expectedOwnerTaskId: "previous-task",
          mode: "steer",
        }),
      ),
    ).toEqual({ outcome: "not_running" });

    const drainedConversationKey = `acct:${accountId}:agent:test-agent:api:drained-conversation`;
    const drainedOwner = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: drainedConversationKey,
        eventId: "drained-owner",
        mode: "reject",
      }),
    );
    expect(
      await t.mutation(internal.runtimeIngress.takeNext, {
        conversationKey: drainedConversationKey,
        ownerEventId: "drained-owner",
        ownerGeneration: drainedOwner.ownerGeneration!,
        leaseTtlMs: 60_000,
      }),
    ).toBeNull();
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          activeOwnerOnly: true,
          accountId: accountId,
          conversationKey: drainedConversationKey,
          eventId: "after-drain-control",
          mode: "steer",
        }),
      ),
    ).toEqual({ outcome: "not_running" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_after-drain-control",
      }),
    ).toBeNull();
  });

  test("recovers queued work before rejecting control for an expired owner", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "expired-owner",
        mode: "reject",
        ownerTaskId: "task-a",
      }),
    );
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "queued-followup",
        mode: "followup",
        ownerTaskId: "task-a",
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

    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          activeOwnerOnly: true,
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "late-control",
          expectedOwnerTaskId: "task-a",
          mode: "steer",
        }),
      ),
    ).toMatchObject({
      outcome: "not_running",
      recovered: {
        eventId: "queued-followup",
        ownerGeneration: 2,
      },
    });
    // Promotion hands the owner slot, task identity included, to the queued work.
    await t.run(async (ctx) => {
      const coordinator = await ctx.db
        .query("runtimeConversationCoordinators")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", conversationKey),
        )
        .unique();
      expect(coordinator?.ownerEventId).toBe("queued-followup");
      expect(coordinator?.ownerTaskId).toBe("task-a");
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_late-control",
      }),
    ).toBeNull();
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
          runId: `run_${eventId}`,
        }),
      ).toMatchObject({ status: "completed", result: "done" });
    }
  });

  test("takeNext and settle store the owner's last rows under the same fence", async () => {
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
    const fence = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
    };

    await t.mutation(internal.runtimeIngress.settle, {
      ...fence,
      status: "completed",
      result: "done",
      events: [{ cursor: "001", event: { role: "user", content: "hello" } }],
    });
    expect(
      await t.mutation(internal.runtimeIngress.takeNext, {
        ...fence,
        leaseTtlMs: 60_000,
        events: [
          { cursor: "002", event: { role: "assistant", content: "hi" } },
        ],
      }),
    ).toBeNull();

    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page.map((row) => row.cursor)).toEqual(["001", "002"]);
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "completed", result: "done" });
    // A moved fence stores nothing.
    await expect(
      t.mutation(internal.runtimeIngress.settle, {
        ...fence,
        status: "failed",
        events: [{ cursor: "003", event: { role: "user", content: "late" } }],
      }),
    ).rejects.toThrow();
  });

  test("stepBoundary stores the step and claims the waiting steer for its owner", async () => {
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

    const boundary = await t.mutation(internal.runtimeIngress.stepBoundary, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
      events: [
        { cursor: "001", event: { role: "assistant", content: "call" } },
        { cursor: "002", event: { role: "tool", content: "result" } },
      ],
    });

    expect(boundary.renewal).toBe("renewed");
    expect(boundary.steering).toMatchObject({
      appliedMode: "steer",
      appliedToEventId: "owner",
      contributingEventIds: ["steer-1"],
    });
    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page.map((row) => row.cursor)).toEqual(["001", "002"]);
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_steer-1",
      }),
    ).toMatchObject({ status: "processing", appliedToEventId: "owner" });
  });

  test("stepBoundary without claimSteering leaves the steer queued", async () => {
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

    expect(
      await t.mutation(internal.runtimeIngress.stepBoundary, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
        claimSteering: false,
      }),
    ).toEqual({ renewal: "renewed", steering: null });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_steer-1",
      }),
    ).toMatchObject({ status: "queued" });
  });

  test("stepBoundary from a moved owner is stale and writes nothing", async () => {
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
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: conversationKey,
      ownerEventId: "first",
      ownerGeneration: first.ownerGeneration!,
    });
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "second",
        mode: "steer",
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

    expect(
      await t.mutation(internal.runtimeIngress.stepBoundary, {
        conversationKey: conversationKey,
        ownerEventId: "first",
        ownerGeneration: first.ownerGeneration!,
        leaseTtlMs: 60_000,
        events: [
          { cursor: "001", event: { role: "assistant", content: "stale" } },
        ],
      }),
    ).toEqual({ renewal: "stale", steering: null });
    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page).toEqual([]);
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_steer-1",
      }),
    ).toMatchObject({ status: "queued" });
  });

  test("stepBoundary reports a stop with the step stored and the steer left queued", async () => {
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
        eventId: "steer-1",
        mode: "steer",
      }),
    );
    await t.mutation(internal.runtimeIngress.stopOwner, {
      accountId: accountId,
      agentId: "test-agent",
      conversationKey: conversationKey,
    });

    expect(
      await t.mutation(internal.runtimeIngress.stepBoundary, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
        events: [
          { cursor: "001", event: { role: "assistant", content: "partial" } },
        ],
      }),
    ).toEqual({ renewal: "stopped", steering: null });
    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page.map((row) => row.cursor)).toEqual(["001"]);
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_steer-1",
      }),
    ).toMatchObject({ status: "queued" });
  });

  test("claims only the plain-text steer prefix when asked", async () => {
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
        eventId: "steer-text",
        mode: "steer",
      }),
    );
    await t.mutation(internal.runtimeIngress.accept, {
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "steer-image",
        mode: "steer",
      }),
      events: [
        {
          role: "user",
          content: [{ type: "image", image: "https://example.com/a.png" }],
        },
      ],
    });
    const fence = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
      textOnly: true,
    };

    const applied = await t.mutation(
      internal.runtimeIngress.applySteering,
      fence,
    );
    expect(applied?.contributingEventIds).toEqual(["steer-text"]);
    // The image stays queued for the next turn instead of being claimed.
    expect(
      await t.mutation(internal.runtimeIngress.applySteering, fence),
    ).toBeNull();
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

  test("stops a steer batch at a different sender", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const events = [
      ["owner", "reject", "alice"],
      ["alice-steer", "steer", "alice"],
      ["bob-steer", "steer", "bob"],
      ["alice-later", "steer", "alice"],
    ] as const;
    const admissions = [];
    for (const [eventId, mode, userId] of events) {
      admissions.push(
        await t.mutation(internal.runtimeIngress.accept, {
          ...admission({
            accountId: accountId,
            conversationKey: conversationKey,
            eventId: eventId,
            mode: mode,
          }),
          delivery: {
            kind: "channel",
            channel: "slack",
            identity: { userId: userId },
          },
        }),
      );
    }
    const owner = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: admissions[0]!.ownerGeneration!,
      leaseTtlMs: 60_000,
    };

    const steered = await t.mutation(
      internal.runtimeIngress.applySteering,
      owner,
    );
    expect(steered?.contributingEventIds).toEqual(["alice-steer"]);
    expect(
      await t.mutation(internal.runtimeIngress.applySteering, owner),
    ).toBeNull();

    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration,
      status: "completed",
      result: "done",
    });
    const next = await t.mutation(internal.runtimeIngress.takeNext, owner);
    expect(next?.contributingEventIds).toEqual(["bob-steer"]);
    expect(next?.delivery.identity).toEqual({ userId: "bob" });
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

  test("requests a boundary stop, keeps a queued steer out of the stopped turn, and settles with takeNext", async () => {
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
        eventId: "queued-steer",
        mode: "steer",
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
    expect(
      await t.mutation(internal.runtimeIngress.applySteering, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: 60_000,
      }),
    ).toBeNull();

    const next = await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      leaseTtlMs: 60_000,
      settle: {
        status: "failed",
        error: "Stopped by user at the model boundary",
      },
    });
    expect(next).toMatchObject({
      eventId: "queued-steer",
      appliedMode: "followup",
      ownerGeneration: 2,
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_owner",
      }),
    ).toMatchObject({
      status: "failed",
      error: "Stopped by user at the model boundary",
      stoppedByUser: true,
    });
  });

  test("does not stop a newer owner for an older task", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "new-owner",
        mode: "reject",
        ownerTaskId: "task-b",
      }),
    );

    expect(
      await t.mutation(internal.runtimeIngress.stopOwner, {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
        expectedOwnerTaskId: "task-a",
      }),
    ).toEqual({ stopped: false, queuedCount: 0 });
    expect(
      await t.mutation(internal.runtimeIngress.renewOwner, {
        conversationKey: conversationKey,
        ownerEventId: "new-owner",
        ownerGeneration: 1,
        leaseTtlMs: 60_000,
      }),
    ).toBe("renewed");
    expect(
      await t.mutation(internal.runtimeIngress.stopOwner, {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
        expectedOwnerTaskId: "task-b",
      }),
    ).toEqual({ stopped: true, queuedCount: 0 });
  });

  test("a subagent its parent stopped is not flagged stoppedByUser", async () => {
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
        ownerTaskId: "task-a",
      }),
    );
    await t.mutation(internal.runtimeIngress.stopOwner, {
      accountId: accountId,
      agentId: "test-agent",
      conversationKey: conversationKey,
      expectedOwnerTaskId: "task-a",
    });
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "failed",
      error: "Stopped by the parent agent at the model boundary",
    });

    const status = await t.query(internal.runtimeIngress.getStatus, {
      accountId: accountId,
      runId: "run_owner",
    });
    expect(status).toMatchObject({ status: "failed" });
    expect(status?.stoppedByUser).toBeUndefined();
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
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      (
        await t.query(internal.runtimeIngress.getStatus, {
          accountId: accountId,
          runId: "run_owner",
        })
      )?.stoppedByUser,
    ).toBeUndefined();
  });

  test("settles an async run's polling row with its envelope, and a stale owner writes neither", async () => {
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
    await t.mutation(internal.runtime.createAsyncAgentResult, {
      eventId: "owner",
      conversationKey: conversationKey,
      subagent: { parentConversationKey: conversationKeyFor(accountId) },
    });
    const settle = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      status: "completed" as const,
      result: "answer",
      asyncResult: {
        eventIds: ["owner"],
        outcome: { status: "completed" as const, response: "answer" },
      },
    };

    await expect(
      t.mutation(internal.runtimeIngress.settle, {
        ...settle,
        ownerGeneration: owner.ownerGeneration! + 1,
      }),
    ).rejects.toThrow("Stale conversation owner generation");
    expect(
      await t.query(internal.runtime.getAsyncAgentResult, { eventId: "owner" }),
    ).toMatchObject({ status: "processing" });

    await t.mutation(internal.runtimeIngress.settle, {
      ...settle,
      ownerGeneration: owner.ownerGeneration!,
    });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "completed" });
    // A subagent's settled row is owed to its parent until the parent stores it.
    expect(
      await t.query(internal.runtime.getAsyncAgentResult, { eventId: "owner" }),
    ).toMatchObject({
      status: "completed",
      response: "answer",
      handback: "pending",
    });
  });

  test("admits a late subagent result only while its parent has not stored it", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const childKey = `acct:${accountId}:agent:child:api:subagent-child`;
    for (const eventId of ["read-first", "resumed-first"]) {
      await t.mutation(internal.runtime.createAsyncAgentResult, {
        eventId: eventId,
        conversationKey: childKey,
        subagent: { parentConversationKey: conversationKey },
      });
      // The parent stops waiting, then the child finishes.
      await t.mutation(internal.runtime.markAsyncAgentHandback, {
        eventId: eventId,
        handback: "detached",
      });
      await t.mutation(internal.runtime.updateAsyncAgentResult, {
        eventId: eventId,
        status: "completed",
        response: "answer",
      });
    }
    const resume = (
      eventId: string,
      resultEventId: string,
    ): ReturnType<typeof admission> & { resultEventId: string } => ({
      ...admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: eventId,
        mode: "followup",
      }),
      resultEventId: resultEventId,
    });

    // get_subagent_status read it first: the resume admits nothing.
    await t.mutation(internal.runtime.markAsyncAgentHandback, {
      eventId: "read-first",
      handback: "stored",
    });
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        resume("resume-read", "read-first"),
      ),
    ).toMatchObject({ outcome: "duplicate" });
    expect(
      await t.query(internal.runtimeIngress.getStatusByEventId, {
        accountId: accountId,
        agentId: "test-agent",
        eventId: "resume-read",
      }),
    ).toBeNull();

    // The resume went first: admitted once, and nothing after it is.
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        resume("resume-first", "resumed-first"),
      ),
    ).toMatchObject({ outcome: "owner" });
    expect(
      await t.mutation(
        internal.runtimeIngress.accept,
        resume("resume-again", "resumed-first"),
      ),
    ).toMatchObject({ outcome: "duplicate" });
    // The admission stored it; a detach landing after never reopens it.
    await t.mutation(internal.runtime.markAsyncAgentHandback, {
      eventId: "resumed-first",
      handback: "detached",
    });
    expect(
      await t.query(internal.runtime.getAsyncAgentResult, {
        eventId: "resumed-first",
      }),
    ).toMatchObject({ handback: "stored" });
  });

  test("admits no late resume of a result its parent's conversation already stores, whatever status its row recorded", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    for (const eventId of ["stored", "lagging", "unsaved"]) {
      await t.mutation(internal.runtime.createAsyncAgentResult, {
        eventId: eventId,
        conversationKey: `acct:${accountId}:agent:child:api:subagent-${eventId}`,
        subagent: { parentConversationKey: conversationKey },
      });
      if (eventId !== "lagging") {
        await t.mutation(internal.runtime.updateAsyncAgentResult, {
          eventId: eventId,
          status: "completed",
          response: "answer",
        });
      }
    }
    // The parent's write stored two results and lost its reply before the
    // rows were marked: core detached one, and the other's row still reads
    // processing because its settle has not landed.
    await t.mutation(internal.runtime.markAsyncAgentHandback, {
      eventId: "stored",
      handback: "detached",
    });
    await t.run(async (ctx): Promise<void> => {
      for (const eventId of ["stored", "lagging"]) {
        await ctx.db.insert("runtimeConversationEvents", {
          accountId: accountId,
          conversationKey: conversationKey,
          cursor: `00${eventId.length}`,
          dedupeKey: subagentResultDedupeKey(eventId, "completed"),
          event: { role: "user", content: "subagent result" },
        });
      }
    });
    const resume = async (
      eventId: string,
      resultEventId: string,
    ): Promise<{ outcome: string }> =>
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: eventId,
          mode: "followup",
        }),
        resultEventId: resultEventId,
      });
    const row = async (eventId: string): Promise<unknown> =>
      await t.query(internal.runtime.getAsyncAgentResult, {
        eventId: eventId,
      });

    expect(await resume("resume-stored", "stored")).toMatchObject({
      outcome: "duplicate",
    });
    // Stored now, so the recovery sweep stops retrying it.
    expect(await row("stored")).toMatchObject({
      handback: "stored",
    });
    expect(await resume("resume-lagging", "lagging")).toMatchObject({
      outcome: "duplicate",
    });
    expect(await row("lagging")).toMatchObject({
      status: "processing",
      handback: "stored",
    });
    expect(await resume("resume-unsaved", "unsaved")).toMatchObject({
      outcome: "owner",
    });
    // The admitted envelope carries it, so it is stored from here on.
    expect(await row("unsaved")).toMatchObject({ handback: "stored" });
  });

  test("admits a continuation of an async tool result once", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    for (const resultId of ["resumed", "read-first", "written"]) {
      await t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: resultId,
        parentEventId: `acct:${accountId}:agent:test-agent:api:parent`,
        conversationKey: conversationKey,
        toolName: "lookup",
        toolCallId: `call-${resultId}`,
        input: {},
      });
      await t.mutation(internal.runtime.updateAsyncToolResult, {
        resultId: resultId,
        status: "completed",
        response: "answer",
        onlyWhenProcessing: true,
      });
    }
    const resume = async (
      eventId: string,
      toolResultId: string,
    ): Promise<{ outcome: string }> =>
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: eventId,
          mode: "followup",
        }),
        toolResultId: toolResultId,
      });
    const row = async (resultId: string): Promise<unknown> =>
      await t.query(internal.runtime.getAsyncToolResult, {
        resultId: resultId,
      });

    // The continuation went first: admitted once, and nothing after it is.
    expect(await resume("resume-first", "resumed")).toMatchObject({
      outcome: "owner",
    });
    expect(await row("resumed")).toMatchObject({
      handback: "stored",
    });
    expect(await resume("resume-again", "resumed")).toMatchObject({
      outcome: "duplicate",
    });

    // async_status read it first: the continuation admits nothing.
    await t.mutation(internal.runtime.markAsyncToolHandback, {
      resultId: "read-first",
      handback: "stored",
    });
    expect(await resume("resume-read", "read-first")).toMatchObject({
      outcome: "duplicate",
    });

    // The run's write stored it and lost its reply: the row is marked stored
    // and the continuation refused.
    await t.run(async (ctx): Promise<void> => {
      await ctx.db.insert("runtimeConversationEvents", {
        accountId: accountId,
        conversationKey: conversationKey,
        cursor: "001",
        dedupeKey: asyncToolResultDedupeKey("written", "completed"),
        event: { role: "user", content: "async tool result" },
      });
    });
    expect(await resume("resume-written", "written")).toMatchObject({
      outcome: "duplicate",
    });
    expect(await row("written")).toMatchObject({
      handback: "stored",
    });
  });

  test("leaves another account's late result row alone", async (): Promise<void> => {
    const t = runtimeTest();
    const ownerId = await createActiveAccount(t);
    const otherId = await createActiveAccount(t);
    await t.mutation(internal.runtime.createAsyncAgentResult, {
      eventId: "owner-result",
      conversationKey: `acct:${ownerId}:agent:child:api:subagent-child`,
      subagent: { parentConversationKey: conversationKeyFor(ownerId) },
    });
    await t.mutation(internal.runtime.markAsyncAgentHandback, {
      eventId: "owner-result",
      handback: "detached",
    });
    await t.mutation(internal.runtime.updateAsyncAgentResult, {
      eventId: "owner-result",
      status: "completed",
      response: "answer",
    });
    const accept = async (eventId: string): Promise<{ outcome: string }> =>
      await t.mutation(internal.runtimeIngress.accept, {
        ...admission({
          accountId: otherId,
          conversationKey: conversationKeyFor(otherId),
          eventId: eventId,
          mode: "followup",
        }),
        resultEventId: "owner-result",
      });

    // Another account naming the row neither marks it stored...
    expect(await accept("other-first")).toMatchObject({ outcome: "owner" });
    expect(
      await t.query(internal.runtime.getAsyncAgentResult, {
        eventId: "owner-result",
      }),
    ).toMatchObject({ handback: "detached" });
    // ...nor is refused once its owner has stored it.
    await t.mutation(internal.runtime.markAsyncAgentHandback, {
      eventId: "owner-result",
      handback: "stored",
    });
    expect(await accept("other-second")).toMatchObject({ outcome: "queued" });
  });

  test("settles the envelope when a polling row is missing, and writes rows only on the settle that finished it", async () => {
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
    await t.mutation(internal.runtime.createAsyncAgentResult, {
      eventId: "owner",
      conversationKey: conversationKey,
    });
    const settle = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "completed" as const,
      result: "answer",
    };

    await t.mutation(internal.runtimeIngress.settle, {
      ...settle,
      asyncResult: {
        eventIds: ["owner", "expired-row"],
        outcome: { status: "completed" as const, response: "answer" },
      },
    });
    await t.mutation(internal.runtimeIngress.settle, {
      ...settle,
      status: "failed",
      error: "late failure",
      asyncResult: {
        eventIds: ["owner"],
        outcome: { status: "failed" as const, error: "late failure" },
      },
    });

    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await t.query(internal.runtime.getAsyncAgentResult, { eventId: "owner" }),
    ).toMatchObject({ status: "completed", response: "answer" });
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
        events: [{ cursor: "001", event: { role: "user", content: "stale" } }],
      }),
    ).rejects.toThrow("Stale conversation owner generation");
  });

  test("stores a batch of events whole for the owner and refuses all of it from a stale one", async () => {
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
    const fence = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
    };
    await t.mutation(internal.runtimeIngress.appendConversationEvent, {
      ...fence,
      events: [
        { cursor: "002", event: { role: "assistant", content: "call" } },
        { cursor: "003", event: { role: "tool", content: "result" } },
      ],
    });
    await t.mutation(internal.runtimeIngress.appendConversationEvent, {
      ...fence,
      events: [{ cursor: "001", event: { role: "user", content: "hello" } }],
    });
    await expect(
      t.mutation(internal.runtimeIngress.appendConversationEvent, {
        ...fence,
        ownerGeneration: fence.ownerGeneration + 1,
        events: [
          { cursor: "004", event: { role: "assistant", content: "stale" } },
          { cursor: "005", event: { role: "tool", content: "stale" } },
        ],
      }),
    ).rejects.toThrow();

    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page.map((row) => row.cursor)).toEqual(["001", "002", "003"]);
  });

  test("stores a retried append once by its dedupe key, still behind the owner fence", async () => {
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
    const fence = {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
    };
    const result = { role: "user", content: "subagent result" };
    await t.mutation(internal.runtimeIngress.appendConversationEvent, {
      ...fence,
      events: [{ cursor: "001", dedupeKey: "result", event: result }],
    });
    // The reply was lost, so core retries with a fresh cursor and the same key.
    await t.mutation(internal.runtimeIngress.appendConversationEvent, {
      ...fence,
      events: [
        { cursor: "002", dedupeKey: "result", event: result },
        { cursor: "003", dedupeKey: "question", event: result },
      ],
    });
    await t.mutation(internal.runtime.appendConversationEvent, {
      conversationKey: conversationKey,
      events: [{ cursor: "004", dedupeKey: "question", event: result }],
    });
    await expect(
      t.mutation(internal.runtimeIngress.appendConversationEvent, {
        ...fence,
        ownerGeneration: fence.ownerGeneration + 1,
        events: [{ cursor: "005", dedupeKey: "stale", event: result }],
      }),
    ).rejects.toThrow("Stale conversation owner generation");

    const stored = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(stored.page.map((row) => row.cursor)).toEqual(["001", "003"]);
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
        runId: "run_queued",
      }),
    ).toMatchObject({ status: "expired" });
  });

  test("maintenance moves a live owner's overdue row forward and expires an orphaned generation", async () => {
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
    const overdue = async (ownerGeneration: number): Promise<void> => {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_eventId", (q) => q.eq("eventId", "owner"))
          .unique();
        await ctx.db.patch(row!._id, {
          expiresAt: Date.now() - 1,
          ownerGeneration: ownerGeneration,
        });
      });
    };

    await overdue(1);
    expect(
      await t.mutation(internal.runtimeIngress.maintain, {}),
    ).toMatchObject({ expired: 0 });
    const moved = await t.run(async (ctx) => {
      return await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_eventId", (q) => q.eq("eventId", "owner"))
        .unique();
    });
    expect(moved!.expiresAt).toBeGreaterThan(Date.now());

    await overdue(0);
    expect(
      await t.mutation(internal.runtimeIngress.maintain, {}),
    ).toMatchObject({ expired: 1 });
  });

  test("maintenance keeps a run whose lease ends this millisecond, and its owner settles it", async () => {
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
    const now = Date.now() + 1_000;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_eventId", (q) => q.eq("eventId", "owner"))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: now - 1 });
      const coordinator = await ctx.db
        .query("runtimeConversationCoordinators")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", conversationKey),
        )
        .unique();
      await ctx.db.patch(coordinator!._id, { leaseExpiresAt: now });
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      expect(
        await t.mutation(internal.runtimeIngress.maintain, {}),
      ).toMatchObject({ expired: 0 });
      await t.mutation(internal.runtimeIngress.settle, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: owner.ownerGeneration!,
        status: "completed",
      });
    } finally {
      vi.useRealTimers();
    }
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "completed" });
  });

  test("settle leaves a queued row that names the owner queued", async () => {
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
        eventId: "queued",
        mode: "followup",
      }),
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_eventId", (q) => q.eq("eventId", "queued"))
        .unique();
      await ctx.db.patch(row!._id, { appliedToEventId: "owner" });
    });

    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ownerGeneration: owner.ownerGeneration!,
      status: "completed",
    });

    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_queued",
      }),
    ).toMatchObject({ status: "queued" });
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
        runId: "run_owner",
      }),
    ).toMatchObject({ status: "expired" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_queued-first",
      }),
    ).toMatchObject({ status: "processing" });
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_late-arrival",
      }),
    ).toMatchObject({ status: "queued" });
  });

  test("recovers the queue behind a released owner without a new arrival", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const released = conversationKeyFor(accountId);
    const busy = `acct:${accountId}:agent:test-agent:api:busy-conversation`;
    for (const [label, conversationKey] of [
      ["released", released],
      ["busy", busy],
    ] as const) {
      for (const role of ["owner", "queued"]) {
        await t.mutation(
          internal.runtimeIngress.accept,
          admission({
            accountId: accountId,
            conversationKey: conversationKey,
            eventId: `${label}-${role}`,
            mode: "followup",
          }),
        );
      }
    }
    // What core does at shutdown: fail the interrupted run, hand the lease back.
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: released,
      ownerEventId: "released-owner",
      ownerGeneration: 1,
      status: "failed",
      error: "interrupted",
    });
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: released,
      ownerEventId: "released-owner",
      ownerGeneration: 1,
    });

    const { recovered, continueAfter } = await t.mutation(
      internal.runtimeIngress.recoverQueued,
      { leaseTtlMs: 60_000 },
    );

    // The busy conversation's owner is alive, so its queue is left to it.
    expect(continueAfter).toBeNull();
    expect(recovered).toEqual([
      {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: released,
        applied: expect.objectContaining({
          eventId: "released-queued",
          appliedMode: "followup",
          ownerGeneration: 2,
        }),
      },
    ]);
    expect(
      await t.mutation(internal.runtimeIngress.recoverQueued, {
        leaseTtlMs: 60_000,
      }),
    ).toEqual({ recovered: [], continueAfter: null });
  });

  test("recovery expires a released queue's elapsed envelopes instead of running them", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    for (const role of ["owner", "queued"]) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: `released-${role}`,
          mode: "followup",
        }),
      );
    }
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: conversationKey,
      ownerEventId: "released-owner",
      ownerGeneration: 1,
    });
    vi.useFakeTimers({ now: Date.now() + 120_000 });
    try {
      expect(
        await t.mutation(internal.runtimeIngress.recoverQueued, {
          leaseTtlMs: 60_000,
        }),
      ).toEqual({ recovered: [], continueAfter: null });
    } finally {
      vi.useRealTimers();
    }
    expect(
      await t.query(internal.runtimeIngress.getStatus, {
        accountId: accountId,
        runId: "run_released-queued",
      }),
    ).toMatchObject({ status: "expired" });
    // The sweep wrote the counters down with the rows, so nothing is left
    // queued to refuse a clear.
    expect(
      await t.mutation(internal.runtimeIngress.acquireClear, {
        accountId: accountId,
        agentId: "test-agent",
        conversationKey: conversationKey,
        ownerEventId: "clear",
        leaseTtlMs: 60_000,
      }),
    ).toBe(2);
  });

  test("a clear refused by a live owner still writes down the queued work it expired", async (): Promise<void> => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const t = runtimeTest();
      const accountId = await createActiveAccount(t);
      const conversationKey = conversationKeyFor(accountId);
      for (const role of ["owner", "queued"]) {
        await t.mutation(internal.runtimeIngress.accept, {
          ...admission({
            accountId: accountId,
            conversationKey: conversationKey,
            eventId: `clear-${role}`,
            mode: "followup",
          }),
          envelopeTtlMs: 1_000,
        });
      }
      // The queued envelope expires while the owner's lease still runs.
      vi.setSystemTime(Date.now() + 1_001);

      expect(
        await t.mutation(internal.runtimeIngress.acquireClear, {
          accountId: accountId,
          agentId: "test-agent",
          conversationKey: conversationKey,
          ownerEventId: "clear",
          leaseTtlMs: 60_000,
        }),
      ).toBeNull();
      expect(
        await t.run(
          async (ctx) =>
            await ctx.db
              .query("runtimeConversationCoordinators")
              .withIndex("by_conversationKey", (q) =>
                q.eq("conversationKey", conversationKey),
              )
              .unique(),
        ),
      ).toMatchObject({ queuedCount: 0, queuedBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("recovery promotes queued work the counter lost and reconciles the counter", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    for (const role of ["owner", "queued"]) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: `lost-${role}`,
          mode: "followup",
        }),
      );
    }
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: conversationKey,
      ownerEventId: "lost-owner",
      ownerGeneration: 1,
    });
    const coordinatorId = await t.run(async (ctx) => {
      const coordinator = await ctx.db
        .query("runtimeConversationCoordinators")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", conversationKey),
        )
        .unique();
      await ctx.db.patch(coordinator!._id, { queuedCount: 0, queuedBytes: 0 });

      return coordinator!._id;
    });

    const { recovered } = await t.mutation(
      internal.runtimeIngress.recoverQueued,
      { leaseTtlMs: 60_000 },
    );

    expect(recovered).toEqual([
      expect.objectContaining({
        conversationKey: conversationKey,
        applied: expect.objectContaining({ eventId: "lost-queued" }),
      }),
    ]);
    expect(await t.run((ctx) => ctx.db.get(coordinatorId))).toMatchObject({
      queuedCount: 0,
      queuedBytes: 0,
      ownerEventId: "lost-queued",
    });
  });

  test("a long queue behind a live owner does not hide a released one", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const keyFor = (name: string): string =>
      `acct:${accountId}:agent:test-agent:api:${name}`;
    // 120 queued envelopes ahead of the released one, in both expiry and key
    // order: more than one recovery page used to read.
    for (const name of ["busy-a", "busy-b"]) {
      for (let index = 0; index <= 60; index += 1) {
        await t.mutation(internal.runtimeIngress.accept, {
          ...admission({
            accountId: accountId,
            conversationKey: keyFor(name),
            eventId: `${name}-${index}`,
            mode: index === 0 ? "reject" : "followup",
          }),
        });
      }
    }
    for (const role of ["owner", "queued"]) {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: keyFor("released"),
          eventId: `released-${role}`,
          mode: "followup",
        }),
      );
    }
    await t.mutation(internal.runtimeIngress.settle, {
      conversationKey: keyFor("released"),
      ownerEventId: "released-owner",
      ownerGeneration: 1,
      status: "failed",
      error: "interrupted",
    });
    await t.mutation(internal.runtimeIngress.releaseOwner, {
      conversationKey: keyFor("released"),
      ownerEventId: "released-owner",
      ownerGeneration: 1,
    });

    const page = await t.mutation(internal.runtimeIngress.recoverQueued, {
      leaseTtlMs: 60_000,
    });

    expect(page.continueAfter).toBeNull();
    expect(page.recovered.map((entry) => entry.conversationKey)).toEqual([
      keyFor("released"),
    ]);
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
      configRef: { model: { temperature: 0.9 } },
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
      configRef: { model: { temperature: 0.9 } },
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
          runId: `run_terminal-${index}`,
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
        runId: "run_overdue-queued",
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
        runId: "run_overdue-queued",
      }),
    ).toMatchObject({ status: "expired" });
  });
});

describe("harness checkpoints", () => {
  const resumeState = (threadId: string) => ({
    type: "resume-session",
    harnessId: "codex",
    specificationVersion: "harness-v1",
    data: { threadId: threadId },
  });

  test("the current owner stores, replaces and clears one checkpoint per conversation", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const owner = { ownerEventId: "owner", ownerGeneration: 1 };
    await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "owner",
        mode: "reject",
      }),
    );

    for (const threadId of ["thread-1", "thread-2"]) {
      await t.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ...owner,
        harnessType: "codex",
        sessionId: `codex-${threadId}`,
        resumeState: resumeState(threadId),
      });
      expect(
        await t.query(internal.runtime.getHarnessSession, {
          conversationKey: conversationKey,
        }),
      ).toEqual({
        harnessType: "codex",
        sessionId: `codex-${threadId}`,
        resumeState: resumeState(threadId),
      });
    }

    await t.mutation(internal.runtimeIngress.clearConversation, {
      conversationKey: conversationKey,
      ...owner,
    });
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toBeNull();
  });

  test("rejects an oversized checkpoint before writing Convex", async (): Promise<void> => {
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

    await expect(
      t.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ownerEventId: "owner",
        ownerGeneration: 1,
        harnessType: "opencode",
        sessionId: "opencode-session",
        resumeState: {
          type: "resume-session",
          harnessId: "opencode",
          specificationVersion: "harness-v1",
          data: { oversized: "x".repeat(64 * 1_024) },
        },
      }),
    ).rejects.toThrow("Harness resume state is");
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toBeNull();
  });

  test("a delayed save from a lapsed owner keeps the newer owner's checkpoint", async (): Promise<void> => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    vi.useFakeTimers({ now: Date.now() });
    try {
      await t.mutation(
        internal.runtimeIngress.accept,
        admission({
          accountId: accountId,
          conversationKey: conversationKey,
          eventId: "first",
          mode: "reject",
        }),
      );
      // The first run's lease lapses and a second message takes the conversation.
      vi.setSystemTime(Date.now() + 60_001);
      expect(
        await t.mutation(
          internal.runtimeIngress.accept,
          admission({
            accountId: accountId,
            conversationKey: conversationKey,
            eventId: "second",
            mode: "reject",
          }),
        ),
      ).toMatchObject({ ownerGeneration: 2 });
      await t.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ownerEventId: "second",
        ownerGeneration: 2,
        harnessType: "codex",
        sessionId: "native-newer",
        resumeState: resumeState("newer"),
      });

      await expect(
        t.mutation(internal.runtimeIngress.saveHarnessSession, {
          conversationKey: conversationKey,
          ownerEventId: "first",
          ownerGeneration: 1,
          harnessType: "codex",
          sessionId: "native-older",
          resumeState: resumeState("older"),
        }),
      ).rejects.toThrow("Stale conversation owner generation");
      expect(
        await t.query(internal.runtime.getHarnessSession, {
          conversationKey: conversationKey,
        }),
      ).toMatchObject({
        sessionId: "native-newer",
        resumeState: resumeState("newer"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// One kind of result a late resume delivers, and how a test drives its row.
interface LateResultKind {
  name: string;
  mode: "followup" | "steer";
  // Creates a finished row its conversation does not store yet.
  create: (
    t: TestConvex<typeof schema>,
    conversationKey: string,
    id: string,
  ) => Promise<void>;
  fence: (id: string) => { resultEventId: string } | { toolResultId: string };
  handback: (
    t: TestConvex<typeof schema>,
    id: string,
  ) => Promise<string | undefined>;
  listed: (t: TestConvex<typeof schema>, id: string) => Promise<boolean>;
  // The parent's status tool read of the row, which stores it.
  // True when a queued resume keeps the result from it.
  read: (t: TestConvex<typeof schema>, id: string) => Promise<boolean>;
  // The owner `busy` taking the queued resume, as its run does.
  apply: (
    t: TestConvex<typeof schema>,
    conversationKey: string,
    ownerGeneration: number,
  ) => Promise<{ contributingEventIds: string[] } | null>;
}

const SWEEP_WINDOW = {
  updatedAfter: "1970-01-01T00:00:00.000Z",
  updatedBefore: "9999-01-01T00:00:00.000Z",
  cursor: null,
};

const LATE_RESULT_KINDS: LateResultKind[] = [
  {
    name: "subagent result",
    mode: "followup",
    create: async (t, conversationKey, id): Promise<void> => {
      await t.mutation(internal.runtime.createAsyncAgentResult, {
        eventId: id,
        conversationKey: `${conversationKey}:child`,
        subagent: { parentConversationKey: conversationKey },
      });
      await t.mutation(internal.runtime.markAsyncAgentHandback, {
        eventId: id,
        handback: "detached",
      });
      await t.mutation(internal.runtime.updateAsyncAgentResult, {
        eventId: id,
        status: "completed",
        response: "answer",
      });
    },
    fence: (id): { resultEventId: string } => ({ resultEventId: id }),
    handback: async (t, id): Promise<string | undefined> =>
      (await t.query(internal.runtime.getAsyncAgentResult, { eventId: id }))
        ?.handback,
    listed: async (t, id): Promise<boolean> =>
      (
        await t.query(internal.runtime.listOwedAsyncAgentResults, {
          ...SWEEP_WINDOW,
          handback: "detached",
          status: "completed",
        })
      ).page.some((row): boolean => row.eventId === id),
    read: async (t, id): Promise<boolean> =>
      await t.mutation(internal.runtime.markAsyncAgentHandback, {
        eventId: id,
        handback: "stored",
      }),
    apply: async (
      t,
      conversationKey,
      ownerGeneration,
    ): Promise<{ contributingEventIds: string[] } | null> =>
      await t.mutation(internal.runtimeIngress.takeNext, {
        conversationKey: conversationKey,
        ownerEventId: "busy",
        ownerGeneration: ownerGeneration,
        leaseTtlMs: 60_000,
        settle: { status: "completed" },
      }),
  },
  {
    name: "async tool result",
    mode: "steer",
    create: async (t, conversationKey, id): Promise<void> => {
      await t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: id,
        parentEventId: `${conversationKey}:parent`,
        conversationKey: conversationKey,
        toolName: "lookup",
        toolCallId: `call-${id}`,
        input: {},
      });
      await t.mutation(internal.runtime.updateAsyncToolResult, {
        resultId: id,
        status: "completed",
        response: "answer",
        onlyWhenProcessing: true,
      });
    },
    fence: (id): { toolResultId: string } => ({ toolResultId: id }),
    handback: async (t, id): Promise<string | undefined> =>
      (await t.query(internal.runtime.getAsyncToolResult, { resultId: id }))
        ?.handback,
    listed: async (t, id): Promise<boolean> =>
      (
        await t.query(internal.runtime.listOwedAsyncToolResults, {
          ...SWEEP_WINDOW,
          handback: "pending",
          status: "completed",
        })
      ).page.some((row): boolean => row.resultId === id),
    read: async (t, id): Promise<boolean> =>
      await t.mutation(internal.runtime.markAsyncToolHandback, {
        resultId: id,
        handback: "stored",
      }),
    apply: async (
      t,
      conversationKey,
      ownerGeneration,
    ): Promise<{ contributingEventIds: string[] } | null> =>
      await t.mutation(internal.runtimeIngress.applySteering, {
        conversationKey: conversationKey,
        ownerEventId: "busy",
        ownerGeneration: ownerGeneration,
        leaseTtlMs: 60_000,
      }),
  },
];

describe.each(LATE_RESULT_KINDS)("a late $name's resume", (kind) => {
  // A conversation whose owner `busy` is running, its result row, and the
  // resume admission that carries it.
  async function busyConversation(): Promise<{
    t: TestConvex<typeof schema>;
    conversationKey: string;
    ownerGeneration: number;
    resume: (options?: {
      envelopeTtlMs?: number;
      payloadDigest?: string;
    }) => Promise<{ outcome: string }>;
  }> {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const busy = await t.mutation(
      internal.runtimeIngress.accept,
      admission({
        accountId: accountId,
        conversationKey: conversationKey,
        eventId: "busy",
        mode: "followup",
      }),
    );
    await kind.create(t, conversationKey, "late");

    return {
      t: t,
      conversationKey: conversationKey,
      ownerGeneration: busy.ownerGeneration!,
      resume: async (
        options: { envelopeTtlMs?: number; payloadDigest?: string } = {},
      ): Promise<{ outcome: string }> =>
        await t.mutation(internal.runtimeIngress.accept, {
          ...admission({
            accountId: accountId,
            conversationKey: conversationKey,
            eventId: "resume",
            mode: kind.mode,
            ...(options.payloadDigest !== undefined
              ? { payloadDigest: options.payloadDigest }
              : {}),
          }),
          ...(options.envelopeTtlMs !== undefined
            ? { envelopeTtlMs: options.envelopeTtlMs }
            : {}),
          ...kind.fence("late"),
        }),
    };
  }

  // The owner `busy` finishing with nothing queued, which releases the
  // conversation.
  async function finishBusy(
    t: TestConvex<typeof schema>,
    conversationKey: string,
    ownerGeneration: number,
  ): Promise<void> {
    await t.mutation(internal.runtimeIngress.takeNext, {
      conversationKey: conversationKey,
      ownerEventId: "busy",
      ownerGeneration: ownerGeneration,
      leaseTtlMs: 60_000,
      settle: { status: "completed" },
    });
  }

  test("stores the result at once as owner", async (): Promise<void> => {
    const { t, conversationKey, ownerGeneration, resume } =
      await busyConversation();
    await finishBusy(t, conversationKey, ownerGeneration);

    expect(await resume()).toMatchObject({ outcome: "owner" });
    expect(await kind.handback(t, "late")).toBe("stored");
  });

  test("stores a queued result only when its envelope is applied", async (): Promise<void> => {
    const { t, conversationKey, ownerGeneration, resume } =
      await busyConversation();
    const before = await kind.handback(t, "late");

    expect(await resume()).toMatchObject({ outcome: "queued" });
    expect(await kind.handback(t, "late")).toBe(before);
    expect(await kind.listed(t, "late")).toBe(true);
    expect(await kind.apply(t, conversationKey, ownerGeneration)).toMatchObject(
      { contributingEventIds: ["resume"] },
    );
    expect(await kind.handback(t, "late")).toBe("stored");
  });

  test("leaves a queued result to its resume when a status read finds it, so a turn that never saves the read loses nothing", async (): Promise<void> => {
    const { t, conversationKey, ownerGeneration, resume } =
      await busyConversation();
    const before = await kind.handback(t, "late");
    expect(await resume()).toMatchObject({ outcome: "queued" });

    // The read hands nothing over, and its turn then ends without saving.
    expect(await kind.read(t, "late")).toBe(true);
    expect(await kind.handback(t, "late")).toBe(before);
    expect(await kind.apply(t, conversationKey, ownerGeneration)).toMatchObject(
      { contributingEventIds: ["resume"] },
    );
    expect(await kind.handback(t, "late")).toBe("stored");
  });

  test("answers a retry whose payload drifted as a duplicate while the first still waits", async (): Promise<void> => {
    const { t, conversationKey, ownerGeneration, resume } =
      await busyConversation();

    expect(await resume()).toMatchObject({ outcome: "queued" });
    // The sweep's retry carries a different hook rewrite or model config.
    expect(await resume({ payloadDigest: "drifted" })).toMatchObject({
      outcome: "duplicate",
    });
    expect(await kind.apply(t, conversationKey, ownerGeneration)).toMatchObject(
      { contributingEventIds: ["resume"] },
    );
    expect(await kind.handback(t, "late")).toBe("stored");
  });

  test("leaves a queued result that expired to the sweep, whose retry is admitted again", async (): Promise<void> => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const { t, conversationKey, ownerGeneration, resume } =
        await busyConversation();
      const before = await kind.handback(t, "late");
      expect(await resume({ envelopeTtlMs: 1_000 })).toMatchObject({
        outcome: "queued",
      });

      // The conversation stays busy past the queued envelope's TTL.
      vi.setSystemTime(Date.now() + 1_001);
      expect(
        await t.mutation(internal.runtimeIngress.maintain, {}),
      ).toMatchObject({ expired: 1 });
      expect(await kind.handback(t, "late")).toBe(before);
      expect(await kind.listed(t, "late")).toBe(true);

      // The sweep's retry carries the same idempotency key, and delivers the
      // result once the conversation is free.
      await finishBusy(t, conversationKey, ownerGeneration);
      expect(await resume()).toMatchObject({ outcome: "owner" });
      expect(await kind.handback(t, "late")).toBe("stored");
    } finally {
      vi.useRealTimers();
    }
  });
});

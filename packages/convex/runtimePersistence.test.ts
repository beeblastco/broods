/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function runtimeTest() {
  return convexTest(schema, modules);
}

/** Creates one account for runtime-write tests. */
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

/** Builds an account-owned conversation key. */
function conversationKeyFor(accountId: string): string {
  return `acct:${accountId}:agent:test-agent:api:test-conversation`;
}

describe("runtime persistence", () => {
  test("claims and leases are atomic and owner-safe", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        accountId,
        key: `acct:${accountId}:event`,
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        accountId,
        key: `acct:${accountId}:event`,
        ttlSeconds: 60,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-1",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    await t.mutation(internal.runtimePersistence.releaseLease, {
      key: "lease",
      ownerEventId: "owner-2",
    });
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    await t.mutation(internal.runtimePersistence.releaseLease, {
      key: "lease",
      ownerEventId: "owner-1",
    });
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(true);
  });

  test("orders conversation events and atomically drains pending ingress", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(internal.runtimePersistence.appendConversationEvent, {
      conversationKey,
      cursor: "002",
      event: { message: "two" },
    });
    await t.mutation(internal.runtimePersistence.appendConversationEvent, {
      conversationKey,
      cursor: "001",
      event: { message: "one" },
    });
    expect(
      await t.query(internal.runtimePersistence.listConversationEvents, {
        conversationKey,
      }),
    ).toEqual({
      page: [
        { cursor: "001", event: { message: "one" } },
        { cursor: "002", event: { message: "two" } },
      ],
      isDone: true,
      continueCursor: null,
    });
    await t.mutation(internal.runtimePersistence.enqueueIngress, {
      key: "pending",
      conversationKey,
      events: [{ role: "user", content: "a" }],
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.enqueueIngress, {
      key: "pending",
      conversationKey,
      events: [{ role: "user", content: "b" }],
      ttlSeconds: 60,
    });
    expect(
      await t.mutation(internal.runtimePersistence.takeIngress, {
        key: "pending",
      }),
    ).toHaveLength(2);
    expect(
      await t.mutation(internal.runtimePersistence.takeIngress, {
        key: "pending",
      }),
    ).toEqual([]);
  });

  test("pages across the conversation boundary without dropping later events", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.run(async (ctx) => {
      for (let index = 0; index < 513; index += 1) {
        await ctx.db.insert("runtimeConversationEvents", {
          accountId: accountId,
          conversationKey: conversationKey,
          cursor: String(index).padStart(4, "0"),
          event:
            index === 512
              ? { role: "system", content: "later compaction summary" }
              : { index: index },
        });
      }
    });

    const first = await t.query(
      internal.runtimePersistence.listConversationEvents,
      { conversationKey: conversationKey },
    );
    expect(first.page).toHaveLength(512);
    expect(first).toMatchObject({
      isDone: false,
      continueCursor: "0511",
    });
    const second = await t.query(
      internal.runtimePersistence.listConversationEvents,
      {
        conversationKey: conversationKey,
        afterCursor: first.continueCursor ?? undefined,
      },
    );
    expect(second).toEqual({
      page: [
        {
          cursor: "0512",
          event: { role: "system", content: "later compaction summary" },
        },
      ],
      isDone: true,
      continueCursor: null,
    });
  });

  test("reports whether a bounded conversation clear has more events", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("runtimeConversationEvents", {
          accountId: accountId,
          conversationKey: conversationKey,
          cursor: String(index).padStart(3, "0"),
          event: { index: index },
        });
      }
    });

    expect(
      await t.mutation(internal.runtimePersistence.clearConversation, {
        conversationKey: conversationKey,
      }),
    ).toEqual({ deleted: 100, hasMore: true });
    expect(
      await t.mutation(internal.runtimePersistence.clearConversation, {
        conversationKey: conversationKey,
      }),
    ).toEqual({ deleted: 1, hasMore: false });
  });

  test("settles async tools once and seals fan-in groups", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const parentEventId = `acct:${accountId}:parent`;
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: parentEventId,
        conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "true" },
        delivery: { kind: "async" },
        completionToken: "secret",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: parentEventId,
        conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: {},
      }),
    ).toBe(false);
    await t.run(async (ctx) => {
      const group = await ctx.db
        .query("runtimeAsyncToolGroups")
        .withIndex("by_parentEventId", (q) =>
          q.eq("parentEventId", parentEventId),
        )
        .unique();
      if (!group) throw new Error("Expected async tool group");
      await ctx.db.patch(group._id, { expiresAt: 1 });
    });
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-2",
        parentEventId: parentEventId,
        conversationKey,
        toolName: "bash",
        toolCallId: "call-2",
        input: {},
        delivery: { kind: "async" },
      }),
    ).toBe(true);
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolGroup, {
        parentEventId: parentEventId,
      }),
    ).toMatchObject({
      resultIds: ["result-1", "result-2"],
      sealed: false,
      expiresAt: expect.any(Number),
    });
    const refreshedGroup = await t.query(
      internal.runtimePersistence.getAsyncToolGroup,
      { parentEventId: parentEventId },
    );
    expect(refreshedGroup?.expiresAt).toBeGreaterThan(1);
    const group = await t.mutation(
      internal.runtimePersistence.sealAsyncToolGroup,
      { parentEventId: parentEventId },
    );
    expect(group).toMatchObject({
      resultIds: ["result-1", "result-2"],
      sealed: true,
    });
    expect(
      await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
        resultId: "result-1",
        status: "completed",
        response: { ok: true },
        onlyWhenProcessing: true,
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
        resultId: "result-1",
        status: "failed",
        error: "late",
        onlyWhenProcessing: true,
      }),
    ).toBeNull();
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolToken, {
        resultId: "result-1",
        completionToken: "secret",
      }),
    ).toBe(true);
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolToken, {
        resultId: "result-1",
        completionToken: "wrong-secret",
      }),
    ).toBe(false);
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-1",
      }),
    ).not.toHaveProperty("completionTokenHash");
    const persisted = await t.run(
      async (ctx) =>
        await ctx.db
          .query("runtimeAsyncToolResults")
          .withIndex("by_resultId", (q) => q.eq("resultId", "result-1"))
          .unique(),
    );
    expect(persisted?.completionTokenHash).toBeDefined();
    expect(persisted?.completionTokenHash).not.toBe("secret");
    await expect(
      t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-3",
        parentEventId: parentEventId,
        conversationKey,
        toolName: "bash",
        toolCallId: "call-3",
        input: {},
        delivery: { kind: "async" },
      }),
    ).rejects.toThrow("sealed group");
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-3",
      }),
    ).toBeNull();
    await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
      resultId: "result-1",
      status: "completed",
      observed: true,
    });
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-1",
      }),
    ).toMatchObject({ observed: true, response: { ok: true } });
  });

  test("claims sandbox reservations and honors expected-id deletes", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const args = {
      provider: "sandbox" as const,
      reservationKey: `acct:${accountId}:workspace:one`,
      externalId: "sandbox-1",
    };
    expect(
      await t.mutation(
        internal.runtimePersistence.claimSandboxReservation,
        args,
      ),
    ).toBe(true);
    expect(
      await t.mutation(
        internal.runtimePersistence.claimSandboxReservation,
        args,
      ),
    ).toBe(false);
    await t.mutation(internal.runtimePersistence.deleteSandboxReservation, {
      provider: args.provider,
      reservationKey: args.reservationKey,
      expectedExternalId: "sandbox-2",
    });
    expect(
      await t.query(internal.runtimePersistence.getSandboxReservation, {
        provider: args.provider,
        reservationKey: args.reservationKey,
      }),
    ).toBe("sandbox-1");
    await t.mutation(internal.runtimePersistence.deleteSandboxReservation, {
      provider: args.provider,
      reservationKey: args.reservationKey,
      expectedExternalId: "sandbox-1",
    });
    expect(
      await t.query(internal.runtimePersistence.getSandboxReservation, {
        provider: args.provider,
        reservationKey: args.reservationKey,
      }),
    ).toBeNull();
  });

  test("rejects admitted runtime writes after account disable or removal", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    const eventKey = `acct:${accountId}:event:existing`;
    const rawEventKey = "gh:delivery-existing";
    const storedRawEventKey = `acct:${accountId}:claim:${rawEventKey}`;
    const parentEventId = `acct:${accountId}:parent`;
    const reservationKey = `acct:${accountId}:workspace:one`;

    await t.mutation(internal.runtimePersistence.claimEvent, {
      accountId: accountId,
      key: eventKey,
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.claimEvent, {
      accountId: accountId,
      key: rawEventKey,
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.acquireLease, {
      key: "existing-lease",
      conversationKey: conversationKey,
      ownerEventId: "owner",
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.enqueueIngress, {
      key: "existing-pending",
      conversationKey: conversationKey,
      events: [{ role: "user", content: "queued" }],
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.appendConversationEvent, {
      conversationKey: conversationKey,
      cursor: "001",
      event: { role: "user", content: "existing" },
    });
    await t.mutation(internal.runtimePersistence.createAsyncAgentResult, {
      eventId: `acct:${accountId}:async-agent`,
      conversationKey: conversationKey,
    });
    await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
      resultId: `acct:${accountId}:async-tool`,
      parentEventId: parentEventId,
      conversationKey: conversationKey,
      toolName: "bash",
      toolCallId: "call-existing",
      input: {},
      delivery: { kind: "async" },
    });
    await t.mutation(internal.runtimePersistence.claimSandboxReservation, {
      provider: "sandbox",
      reservationKey: reservationKey,
      externalId: "sandbox-existing",
    });

    await t.run(
      async (ctx) =>
        await ctx.db.patch(accountId, {
          status: "disabled",
          updatedAt: Date.now(),
        }),
    );

    const blockedWrites = [
      () =>
        t.mutation(internal.runtimePersistence.claimEvent, {
          accountId: accountId,
          key: `acct:${accountId}:event:new`,
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtimePersistence.claimEvent, {
          accountId: accountId,
          key: "zalo:event:new",
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtimePersistence.releaseClaim, {
          accountId: accountId,
          key: eventKey,
        }),
      () =>
        t.mutation(internal.runtimePersistence.releaseClaim, {
          accountId: accountId,
          key: rawEventKey,
        }),
      () =>
        t.mutation(internal.runtimePersistence.acquireLease, {
          key: "new-lease",
          conversationKey: conversationKey,
          ownerEventId: "owner",
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtimePersistence.releaseLease, {
          key: "existing-lease",
          ownerEventId: "owner",
        }),
      () =>
        t.mutation(internal.runtimePersistence.enqueueIngress, {
          key: "new-pending",
          conversationKey: conversationKey,
          events: [{ role: "user", content: "late" }],
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtimePersistence.takeIngress, {
          key: "existing-pending",
        }),
      () =>
        t.mutation(internal.runtimePersistence.appendConversationEvent, {
          conversationKey: conversationKey,
          cursor: "002",
          event: { role: "assistant", content: "late" },
        }),
      () =>
        t.mutation(internal.runtimePersistence.clearConversation, {
          conversationKey: conversationKey,
        }),
      () =>
        t.mutation(internal.runtimePersistence.createAsyncAgentResult, {
          eventId: `acct:${accountId}:async-agent-new`,
          conversationKey: conversationKey,
        }),
      () =>
        t.mutation(internal.runtimePersistence.updateAsyncAgentResult, {
          eventId: `acct:${accountId}:async-agent`,
          status: "completed",
        }),
      () =>
        t.mutation(internal.runtimePersistence.createAsyncToolResult, {
          resultId: `acct:${accountId}:async-tool-new`,
          parentEventId: parentEventId,
          conversationKey: conversationKey,
          toolName: "bash",
          toolCallId: "call-new",
          input: {},
        }),
      () =>
        t.mutation(internal.runtimePersistence.sealAsyncToolGroup, {
          parentEventId: parentEventId,
        }),
      () =>
        t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
          resultId: `acct:${accountId}:async-tool`,
          status: "completed",
        }),
      () =>
        t.mutation(internal.runtimePersistence.claimSandboxReservation, {
          provider: "sandbox",
          reservationKey: `acct:${accountId}:workspace:new`,
          externalId: "sandbox-new",
        }),
      () =>
        t.mutation(internal.runtimePersistence.saveSandboxReservation, {
          provider: "sandbox",
          reservationKey: reservationKey,
          externalId: "sandbox-late",
        }),
      () =>
        t.mutation(internal.runtimePersistence.deleteSandboxReservation, {
          provider: "sandbox",
          reservationKey: reservationKey,
        }),
    ];
    for (const write of blockedWrites) {
      await expect(write()).rejects.toThrow(
        `Account is not active: ${accountId}`,
      );
    }

    expect(
      await t.run(async (ctx) => ({
        claims: await ctx.db.query("runtimeClaims").collect(),
        events: await ctx.db.query("runtimeConversationEvents").collect(),
        agentResults: await ctx.db.query("runtimeAsyncAgentResults").collect(),
        toolResults: await ctx.db.query("runtimeAsyncToolResults").collect(),
        groups: await ctx.db.query("runtimeAsyncToolGroups").collect(),
        reservations: await ctx.db.query("sandboxReservations").collect(),
      })),
    ).toMatchObject({
      claims: expect.arrayContaining([
        expect.objectContaining({ key: eventKey }),
        expect.objectContaining({ key: storedRawEventKey }),
        expect.objectContaining({ key: "existing-lease" }),
        expect.objectContaining({ key: "existing-pending" }),
      ]),
      events: [expect.objectContaining({ cursor: "001" })],
      agentResults: [expect.objectContaining({ status: "processing" })],
      toolResults: [expect.objectContaining({ status: "processing" })],
      groups: [expect.objectContaining({ sealed: false })],
      reservations: [
        expect.objectContaining({ externalId: "sandbox-existing" }),
      ],
    });

    await t.run(async (ctx) => await ctx.db.delete(accountId));
    await expect(
      t.mutation(internal.runtimePersistence.appendConversationEvent, {
        conversationKey: conversationKey,
        cursor: "003",
        event: { role: "assistant", content: "orphan" },
      }),
    ).rejects.toThrow(`Account is not active: ${accountId}`);
  });

  test("deletes account runtime data across bounded batches", async () => {
    const t = runtimeTest();
    const accountId = "cleanup-account";
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("runtimeConversationEvents", {
          accountId,
          conversationKey: `acct:${accountId}:conversation:${index}`,
          cursor: String(index).padStart(3, "0"),
          event: { index },
        });
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId,
          parentEventId: `acct:${accountId}:parent:${index}`,
          resultIds: [`result-${index}`],
          sealed: true,
          expiresAt: 2_000_000_000,
        });
        await ctx.db.insert("sandboxReservations", {
          accountId,
          provider: "sandbox",
          reservationKey: `acct:${accountId}:workspace:${index}`,
          externalId: `sandbox-${index}`,
          expiresAt: 2_000_000_000,
        });
      }
    });

    const results = [];
    for (;;) {
      const result = await t.mutation(
        internal.runtimePersistence.deleteAccountRuntimeData,
        { accountId },
      );
      results.push(result);
      if (result.totalDeleted === 0) break;
    }
    expect(results).toEqual([
      {
        conversationsDeleted: 100,
        processedEventsDeleted: 0,
        asyncAgentResultDeleted: 0,
        asyncToolResultDeleted: 0,
        asyncToolGroupDeleted: 100,
        sandboxReservationDeleted: 100,
        totalDeleted: 300,
      },
      {
        conversationsDeleted: 1,
        processedEventsDeleted: 0,
        asyncAgentResultDeleted: 0,
        asyncToolResultDeleted: 0,
        asyncToolGroupDeleted: 1,
        sandboxReservationDeleted: 1,
        totalDeleted: 3,
      },
      {
        conversationsDeleted: 0,
        processedEventsDeleted: 0,
        asyncAgentResultDeleted: 0,
        asyncToolResultDeleted: 0,
        asyncToolGroupDeleted: 0,
        sandboxReservationDeleted: 0,
        totalDeleted: 0,
      },
    ]);
    expect(
      await t.run(async (ctx) => ({
        events: await ctx.db.query("runtimeConversationEvents").collect(),
        groups: await ctx.db.query("runtimeAsyncToolGroups").collect(),
        reservations: await ctx.db.query("sandboxReservations").collect(),
      })),
    ).toEqual({ events: [], groups: [], reservations: [] });
  });

  test("prunes expired operational rows without removing live rows", async () => {
    const t = runtimeTest();
    const now = Math.floor(Date.now() / 1000);
    await t.run(async (ctx) => {
      for (const [suffix, expiresAt] of [
        ["expired", now - 1],
        ["live", now + 60],
      ] as const) {
        await ctx.db.insert("runtimeClaims", {
          accountId: "prune-account",
          key: `${suffix}-claim`,
          kind: "event",
          expiresAt,
        });
        await ctx.db.insert("runtimeAsyncAgentResults", {
          accountId: "prune-account",
          eventId: `${suffix}-agent`,
          conversationKey: `acct:prune-account:${suffix}`,
          status: "processing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt,
        });
        await ctx.db.insert("runtimeAsyncToolResults", {
          accountId: "prune-account",
          resultId: `${suffix}-tool`,
          parentEventId: `${suffix}-parent`,
          conversationKey: `acct:prune-account:${suffix}`,
          toolName: "bash",
          toolCallId: `${suffix}-call`,
          input: {},
          status: "processing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt,
        });
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId: "prune-account",
          parentEventId: `${suffix}-parent`,
          resultIds: [`${suffix}-tool`],
          sealed: true,
          expiresAt,
        });
        await ctx.db.insert("sandboxReservations", {
          accountId: "prune-account",
          provider: "sandbox",
          reservationKey: `acct:prune-account:${suffix}`,
          externalId: `${suffix}-sandbox`,
          expiresAt,
        });
      }
    });

    expect(await t.mutation(internal.runtimePersistence.pruneExpired, {})).toBe(
      5,
    );
    expect(
      await t.run(async (ctx) => ({
        claims: (await ctx.db.query("runtimeClaims").collect()).map(
          (row) => row.key,
        ),
        agents: (await ctx.db.query("runtimeAsyncAgentResults").collect()).map(
          (row) => row.eventId,
        ),
        tools: (await ctx.db.query("runtimeAsyncToolResults").collect()).map(
          (row) => row.resultId,
        ),
        groups: (await ctx.db.query("runtimeAsyncToolGroups").collect()).map(
          (row) => row.parentEventId,
        ),
        reservations: (await ctx.db.query("sandboxReservations").collect()).map(
          (row) => row.externalId,
        ),
      })),
    ).toEqual({
      claims: ["live-claim"],
      agents: ["live-agent"],
      tools: ["live-tool"],
      groups: ["live-parent"],
      reservations: ["live-sandbox"],
    });
  });
});

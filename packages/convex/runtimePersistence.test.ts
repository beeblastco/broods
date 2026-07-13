/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const conversationKey =
  "acct:test-account:agent:test-agent:api:test-conversation";

describe("runtime persistence", () => {
  test("claims and leases are atomic and owner-safe", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        key: "acct:test-account:event",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        key: "acct:test-account:event",
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
    const t = convexTest(schema, modules);
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
    ).toEqual([
      { cursor: "001", event: { message: "one" } },
      { cursor: "002", event: { message: "two" } },
    ]);
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

  test("settles async tools once and seals fan-in groups", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: "acct:test-account:parent",
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
        parentEventId: "acct:test-account:parent",
        conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: {},
      }),
    ).toBe(false);
    const group = await t.mutation(
      internal.runtimePersistence.sealAsyncToolGroup,
      { parentEventId: "acct:test-account:parent" },
    );
    expect(group).toMatchObject({ resultIds: ["result-1"], sealed: true });
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
        resultId: "result-2",
        parentEventId: "acct:test-account:parent",
        conversationKey,
        toolName: "bash",
        toolCallId: "call-2",
        input: {},
        delivery: { kind: "async" },
      }),
    ).rejects.toThrow("sealed group");
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-2",
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
    const t = convexTest(schema, modules);
    const args = {
      provider: "sandbox" as const,
      reservationKey: "acct:test-account:workspace:one",
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

  test("deletes account runtime data across bounded batches", async () => {
    const t = convexTest(schema, modules);
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

    let batches = 0;
    for (;;) {
      const result = await t.mutation(
        internal.runtimePersistence.deleteAccountRuntimeData,
        { accountId },
      );
      batches += 1;
      if (result.totalDeleted === 0) break;
    }
    expect(batches).toBe(3);
    expect(
      await t.run(async (ctx) => ({
        events: await ctx.db.query("runtimeConversationEvents").collect(),
        groups: await ctx.db.query("runtimeAsyncToolGroups").collect(),
        reservations: await ctx.db.query("sandboxReservations").collect(),
      })),
    ).toEqual({ events: [], groups: [], reservations: [] });
  });

  test("prunes expired operational rows without removing live rows", async () => {
    const t = convexTest(schema, modules);
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

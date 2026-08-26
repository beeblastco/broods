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
  test("event claims are atomic", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    expect(
      await t.mutation(internal.runtime.claimEvent, {
        accountId: accountId,
        key: `acct:${accountId}:event`,
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtime.claimEvent, {
        accountId: accountId,
        key: `acct:${accountId}:event`,
        ttlSeconds: 60,
      }),
    ).toBe(false);
  });

  test("orders conversation events", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.mutation(internal.runtime.appendConversationEvent, {
      conversationKey: conversationKey,
      cursor: "002",
      event: { message: "two" },
    });
    await t.mutation(internal.runtime.appendConversationEvent, {
      conversationKey: conversationKey,
      cursor: "001",
      event: { message: "one" },
    });
    expect(
      await t.query(internal.runtime.listConversationEvents, {
        conversationKey: conversationKey,
      }),
    ).toEqual({
      page: [
        { cursor: "001", event: { message: "one" } },
        { cursor: "002", event: { message: "two" } },
      ],
      isDone: true,
      continueCursor: null,
    });
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

    const first = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
    });
    expect(first.page).toHaveLength(512);
    expect(first).toMatchObject({
      isDone: false,
      continueCursor: "0511",
    });
    const second = await t.query(internal.runtime.listConversationEvents, {
      conversationKey: conversationKey,
      afterCursor: first.continueCursor ?? undefined,
    });
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

  test("persists one resumable harness session per conversation", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toBeNull();

    await t.mutation(internal.runtime.saveHarnessSession, {
      conversationKey: conversationKey,
      harnessType: "codex",
      sessionId: "codex-session",
      resumeState: {
        type: "resume-session",
        harnessId: "codex",
        specificationVersion: "harness-v1",
        data: { threadId: "thread-1" },
      },
    });
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toEqual({
      harnessType: "codex",
      sessionId: "codex-session",
      resumeState: {
        type: "resume-session",
        harnessId: "codex",
        specificationVersion: "harness-v1",
        data: { threadId: "thread-1" },
      },
    });

    await t.mutation(internal.runtime.saveHarnessSession, {
      conversationKey: conversationKey,
      harnessType: "codex",
      sessionId: "codex-session-replaced",
      resumeState: {
        type: "resume-session",
        harnessId: "codex",
        specificationVersion: "harness-v1",
        data: { threadId: "thread-2" },
      },
    });
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toEqual({
      harnessType: "codex",
      sessionId: "codex-session-replaced",
      resumeState: {
        type: "resume-session",
        harnessId: "codex",
        specificationVersion: "harness-v1",
        data: { threadId: "thread-2" },
      },
    });

    await t.mutation(internal.runtime.clearConversation, {
      conversationKey: conversationKey,
    });
    expect(
      await t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).toBeNull();
  });

  test("rejects a harness checkpoint stored under another account", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const otherAccountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);
    await t.run(async (ctx) => {
      await ctx.db.insert("runtimeHarnessSessions", {
        accountId: otherAccountId,
        conversationKey: conversationKey,
        harnessType: "pi",
        sessionId: "foreign-session",
        resumeState: {
          type: "resume-session",
          harnessId: "pi",
          specificationVersion: "harness-v1",
          data: {},
        },
        updatedAt: Date.now(),
      });
    });

    await expect(
      t.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      }),
    ).rejects.toThrow(
      "Harness session does not belong to conversation account",
    );
  });

  test("rejects an oversized harness checkpoint before writing Convex", async () => {
    const t = runtimeTest();
    const accountId = await createActiveAccount(t);
    const conversationKey = conversationKeyFor(accountId);

    await expect(
      t.mutation(internal.runtime.saveHarnessSession, {
        conversationKey: conversationKey,
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
      await t.mutation(internal.runtime.clearConversation, {
        conversationKey: conversationKey,
      }),
    ).toEqual({ deleted: 100, hasMore: true });
    expect(
      await t.mutation(internal.runtime.clearConversation, {
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
      await t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: parentEventId,
        conversationKey: conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "true" },
        delivery: { kind: "async" },
        completionToken: "secret",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: parentEventId,
        conversationKey: conversationKey,
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
      await t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: "result-2",
        parentEventId: parentEventId,
        conversationKey: conversationKey,
        toolName: "bash",
        toolCallId: "call-2",
        input: {},
        delivery: { kind: "async" },
      }),
    ).toBe(true);
    expect(
      await t.query(internal.runtime.getAsyncToolGroup, {
        parentEventId: parentEventId,
      }),
    ).toMatchObject({
      resultIds: ["result-1", "result-2"],
      sealed: false,
      expiresAt: expect.any(Number),
    });
    const refreshedGroup = await t.query(internal.runtime.getAsyncToolGroup, {
      parentEventId: parentEventId,
    });
    expect(refreshedGroup?.expiresAt).toBeGreaterThan(1);
    const group = await t.mutation(internal.runtime.sealAsyncToolGroup, {
      parentEventId: parentEventId,
    });
    expect(group).toMatchObject({
      resultIds: ["result-1", "result-2"],
      sealed: true,
    });
    expect(
      await t.mutation(internal.runtime.updateAsyncToolResult, {
        resultId: "result-1",
        status: "completed",
        response: { ok: true },
        onlyWhenProcessing: true,
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await t.mutation(internal.runtime.updateAsyncToolResult, {
        resultId: "result-1",
        status: "failed",
        error: "late",
        onlyWhenProcessing: true,
      }),
    ).toBeNull();
    expect(
      await t.query(internal.runtime.getAsyncToolToken, {
        resultId: "result-1",
        completionToken: "secret",
      }),
    ).toBe(true);
    expect(
      await t.query(internal.runtime.getAsyncToolToken, {
        resultId: "result-1",
        completionToken: "wrong-secret",
      }),
    ).toBe(false);
    expect(
      await t.query(internal.runtime.getAsyncToolResult, {
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
      t.mutation(internal.runtime.createAsyncToolResult, {
        resultId: "result-3",
        parentEventId: parentEventId,
        conversationKey: conversationKey,
        toolName: "bash",
        toolCallId: "call-3",
        input: {},
        delivery: { kind: "async" },
      }),
    ).rejects.toThrow("sealed group");
    expect(
      await t.query(internal.runtime.getAsyncToolResult, {
        resultId: "result-3",
      }),
    ).toBeNull();
    await t.mutation(internal.runtime.updateAsyncToolResult, {
      resultId: "result-1",
      status: "completed",
      observed: true,
    });
    expect(
      await t.query(internal.runtime.getAsyncToolResult, {
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
      accountId: accountId,
    };
    expect(
      await t.mutation(internal.runtime.claimSandboxReservation, args),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtime.claimSandboxReservation, args),
    ).toBe(false);
    await t.mutation(internal.runtime.deleteSandboxReservation, {
      provider: args.provider,
      reservationKey: args.reservationKey,
      expectedExternalId: "sandbox-2",
      accountId: accountId,
    });
    expect(
      await t.query(internal.runtime.getSandboxReservation, {
        provider: args.provider,
        reservationKey: args.reservationKey,
      }),
    ).toBe("sandbox-1");
    await t.mutation(internal.runtime.deleteSandboxReservation, {
      provider: args.provider,
      reservationKey: args.reservationKey,
      expectedExternalId: "sandbox-1",
      accountId: accountId,
    });
    expect(
      await t.query(internal.runtime.getSandboxReservation, {
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

    await t.mutation(internal.runtime.claimEvent, {
      accountId: accountId,
      key: eventKey,
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtime.claimEvent, {
      accountId: accountId,
      key: rawEventKey,
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtime.appendConversationEvent, {
      conversationKey: conversationKey,
      cursor: "001",
      event: { role: "user", content: "existing" },
    });
    await t.mutation(internal.runtime.createAsyncAgentResult, {
      eventId: `acct:${accountId}:async-agent`,
      conversationKey: conversationKey,
    });
    await t.mutation(internal.runtime.createAsyncToolResult, {
      resultId: `acct:${accountId}:async-tool`,
      parentEventId: parentEventId,
      conversationKey: conversationKey,
      toolName: "bash",
      toolCallId: "call-existing",
      input: {},
      delivery: { kind: "async" },
    });
    await t.mutation(internal.runtime.claimSandboxReservation, {
      provider: "sandbox",
      reservationKey: reservationKey,
      externalId: "sandbox-existing",
      accountId: accountId,
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
        t.mutation(internal.runtime.claimEvent, {
          accountId: accountId,
          key: `acct:${accountId}:event:new`,
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtime.claimEvent, {
          accountId: accountId,
          key: "zalo:event:new",
          ttlSeconds: 60,
        }),
      () =>
        t.mutation(internal.runtime.releaseClaim, {
          accountId: accountId,
          key: eventKey,
        }),
      () =>
        t.mutation(internal.runtime.releaseClaim, {
          accountId: accountId,
          key: rawEventKey,
        }),
      () =>
        t.mutation(internal.runtime.appendConversationEvent, {
          conversationKey: conversationKey,
          cursor: "002",
          event: { role: "assistant", content: "late" },
        }),
      () =>
        t.mutation(internal.runtime.clearConversation, {
          conversationKey: conversationKey,
        }),
      () =>
        t.mutation(internal.runtime.createAsyncAgentResult, {
          eventId: `acct:${accountId}:async-agent-new`,
          conversationKey: conversationKey,
        }),
      () =>
        t.mutation(internal.runtime.updateAsyncAgentResult, {
          eventId: `acct:${accountId}:async-agent`,
          status: "completed",
        }),
      () =>
        t.mutation(internal.runtime.createAsyncToolResult, {
          resultId: `acct:${accountId}:async-tool-new`,
          parentEventId: parentEventId,
          conversationKey: conversationKey,
          toolName: "bash",
          toolCallId: "call-new",
          input: {},
        }),
      () =>
        t.mutation(internal.runtime.sealAsyncToolGroup, {
          parentEventId: parentEventId,
        }),
      () =>
        t.mutation(internal.runtime.updateAsyncToolResult, {
          resultId: `acct:${accountId}:async-tool`,
          status: "completed",
        }),
      () =>
        t.mutation(internal.runtime.claimSandboxReservation, {
          provider: "sandbox",
          reservationKey: `acct:${accountId}:workspace:new`,
          externalId: "sandbox-new",
          accountId: accountId,
        }),
      () =>
        t.mutation(internal.runtime.saveSandboxReservation, {
          provider: "sandbox",
          reservationKey: reservationKey,
          externalId: "sandbox-late",
          accountId: accountId,
        }),
      () =>
        t.mutation(internal.runtime.deleteSandboxReservation, {
          provider: "sandbox",
          reservationKey: reservationKey,
          accountId: accountId,
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
      t.mutation(internal.runtime.appendConversationEvent, {
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
          accountId: accountId,
          conversationKey: `acct:${accountId}:conversation:${index}`,
          cursor: String(index).padStart(3, "0"),
          event: { index: index },
        });
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId: accountId,
          parentEventId: `acct:${accountId}:parent:${index}`,
          resultIds: [`result-${index}`],
          sealed: true,
          expiresAt: 2_000_000_000,
        });
        await ctx.db.insert("sandboxReservations", {
          accountId: accountId,
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
        internal.runtime.deleteAccountRuntimeData,
        { accountId: accountId },
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
        harnessSessionDeleted: 0,
        sandboxReservationDeleted: 100,
        totalDeleted: 300,
      },
      {
        conversationsDeleted: 1,
        processedEventsDeleted: 0,
        asyncAgentResultDeleted: 0,
        asyncToolResultDeleted: 0,
        asyncToolGroupDeleted: 1,
        harnessSessionDeleted: 0,
        sandboxReservationDeleted: 1,
        totalDeleted: 3,
      },
      {
        conversationsDeleted: 0,
        processedEventsDeleted: 0,
        asyncAgentResultDeleted: 0,
        asyncToolResultDeleted: 0,
        asyncToolGroupDeleted: 0,
        harnessSessionDeleted: 0,
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
          expiresAt: expiresAt,
        });
        await ctx.db.insert("runtimeAsyncAgentResults", {
          accountId: "prune-account",
          eventId: `${suffix}-agent`,
          conversationKey: `acct:prune-account:${suffix}`,
          status: "processing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: expiresAt,
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
          expiresAt: expiresAt,
        });
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId: "prune-account",
          parentEventId: `${suffix}-parent`,
          resultIds: [`${suffix}-tool`],
          sealed: true,
          expiresAt: expiresAt,
        });
        await ctx.db.insert("sandboxReservations", {
          accountId: "prune-account",
          provider: "sandbox",
          reservationKey: `acct:prune-account:${suffix}`,
          externalId: `${suffix}-sandbox`,
          expiresAt: expiresAt,
        });
      }
    });

    expect(await t.mutation(internal.runtime.pruneExpired, {})).toBe(5);
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

describe("runtime.deleteAgentRuntimeData", () => {
  const ACCOUNT = "purge-account";
  const AGENT = "purge-agent";
  const OTHER_AGENT = "keeper-agent";
  /** Mirrors the batch size the mutation pages with. */
  const RUNTIME_DELETE_BATCH_SIZE = 100;
  const FAR_FUTURE_EXPIRY = 9_999_999_999;

  /** Two agents in one account, each with a row in every key-scoped table. */
  async function seedTwoAgents(t: ReturnType<typeof runtimeTest>) {
    await t.run(async (ctx) => {
      for (const agentId of [AGENT, OTHER_AGENT]) {
        const conversationKey = `acct:${ACCOUNT}:agent:${agentId}:tg:1`;
        await ctx.db.insert("runtimeConversationEvents", {
          accountId: ACCOUNT,
          conversationKey: conversationKey,
          cursor: "001",
          event: { text: "hi" },
        });
        await ctx.db.insert("runtimeConversationCoordinators", {
          accountId: ACCOUNT,
          agentId: agentId,
          conversationKey: conversationKey,
          ownerGeneration: 1,
          queuedCount: 0,
          queuedBytes: 0,
          nextSequence: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("runtimeHarnessSessions", {
          accountId: ACCOUNT,
          conversationKey: conversationKey,
          harnessType: "claude-code" as const,
          sessionId: `session-${agentId}`,
          resumeState: null,
          updatedAt: 1,
        });
      }
    });
  }

  test("deletes only the named agent's rows", async () => {
    const t = runtimeTest();
    await seedTwoAgents(t);

    const result = await t.mutation(internal.runtime.deleteAgentRuntimeData, {
      accountId: ACCOUNT,
      agentId: AGENT,
    });

    expect(result).toMatchObject({
      conversationsDeleted: 1,
      coordinatorDeleted: 1,
      harnessSessionDeleted: 1,
      totalDeleted: 3,
    });
    await t.run(async (ctx) => {
      const survivors = await ctx.db
        .query("runtimeConversationCoordinators")
        .withIndex("by_accountId", (q) => q.eq("accountId", ACCOUNT))
        .collect();
      expect(survivors.map((row) => row.agentId)).toEqual([OTHER_AGENT]);
    });
  });

  test("reports nothing to do for an agent with no rows", async () => {
    const t = runtimeTest();
    await seedTwoAgents(t);

    expect(
      await t.mutation(internal.runtime.deleteAgentRuntimeData, {
        accountId: ACCOUNT,
        agentId: "never-ran",
      }),
    ).toMatchObject({ totalDeleted: 0 });
  });

  test("an agent id that prefixes another does not take its rows", async () => {
    const t = runtimeTest();
    await t.run(async (ctx) => {
      for (const agentId of ["ag1", "ag10"]) {
        await ctx.db.insert("runtimeConversationEvents", {
          accountId: ACCOUNT,
          conversationKey: `acct:${ACCOUNT}:agent:${agentId}:tg:1`,
          cursor: "001",
          event: { text: "hi" },
        });
      }
    });

    const result = await t.mutation(internal.runtime.deleteAgentRuntimeData, {
      accountId: ACCOUNT,
      agentId: "ag1",
    });

    expect(result.conversationsDeleted).toBe(1);
    await t.run(async (ctx) => {
      const left = await ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_accountId", (q) => q.eq("accountId", ACCOUNT))
        .collect();
      expect(left.map((row) => row.conversationKey)).toEqual([
        `acct:${ACCOUNT}:agent:ag10:tg:1`,
      ]);
    });
  });

  test("a busy sibling agent does not keep the purge rescheduling", async () => {
    const t = runtimeTest();
    await t.run(async (ctx) => {
      // A full batch of rows belonging to someone else. Read over an index that
      // is not the conversation key, these would come back every pass, delete
      // nothing and reschedule forever.
      for (let index = 0; index < RUNTIME_DELETE_BATCH_SIZE; index += 1)
        await ctx.db.insert("runtimeAsyncAgentResults", {
          accountId: ACCOUNT,
          eventId: `keeper-${index}`,
          conversationKey: `acct:${ACCOUNT}:agent:${OTHER_AGENT}:api:c${index}`,
          status: "completed" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: FAR_FUTURE_EXPIRY,
        });
      await ctx.db.insert("runtimeAsyncAgentResults", {
        accountId: ACCOUNT,
        eventId: "doomed",
        conversationKey: `acct:${ACCOUNT}:agent:${AGENT}:api:c0`,
        status: "completed" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: FAR_FUTURE_EXPIRY,
      });
    });

    expect(
      await t.mutation(internal.runtime.deleteAgentRuntimeData, {
        accountId: ACCOUNT,
        agentId: AGENT,
      }),
    ).toMatchObject({ asyncAgentResultDeleted: 1, totalDeleted: 1 });
    await t.run(async (ctx) => {
      const survivors = await ctx.db
        .query("runtimeAsyncAgentResults")
        .withIndex("by_accountId", (q) => q.eq("accountId", ACCOUNT))
        .collect();
      expect(survivors).toHaveLength(RUNTIME_DELETE_BATCH_SIZE);
      const pending = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(pending).toHaveLength(0);
    });
  });
});

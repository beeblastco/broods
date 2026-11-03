/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  harnessEntryBatches,
  MAX_HARNESS_SESSION_ENTRY_BYTES,
} from "../model/harnessSessionEntries";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const BIG_ENTRY = "x".repeat(500 * 1_024);
const OWNER = { ownerEventId: "owner", ownerGeneration: 1 };

interface EntryLink {
  entryId: string;
  parentEntryId?: string;
  firstKeptEntryId?: string;
}

interface Conversation {
  t: TestConvex<typeof schema>;
  accountId: Id<"accounts">;
  conversationKey: string;
}

describe("harness session entries inside Convex transaction limits", () => {
  test("the owner's clear deletes 20 MB of entries in bounded batches", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 40, BIG_ENTRY);

    let more = true;
    while (more) {
      more = (
        await t.mutation(internal.runtimeIngress.clearConversation, {
          conversationKey: conversationKey,
          ...OWNER,
        })
      ).hasMore;
    }
    expect(await entryCount(t, conversationKey)).toBe(0);
  });

  test("the unfenced clear deletes 20 MB of entries in bounded batches", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 40, BIG_ENTRY);

    let more = true;
    while (more) {
      more = (
        await t.mutation(internal.runtime.clearConversation, {
          conversationKey: conversationKey,
        })
      ).hasMore;
    }
    expect(await entryCount(t, conversationKey)).toBe(0);
  });

  test("agent deletion removes 20 MB of entries in bounded batches", async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { t, accountId, conversationKey } = await conversation();
      await seed(t, conversationKey, "s1", 40, BIG_ENTRY);

      await t.mutation(internal.runtime.deleteAgentRuntimeData, {
        accountId: accountId,
        agentId: "test-agent",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await entryCount(t, conversationKey)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("account runtime deletion removes 20 MB of entries in bounded batches", async (): Promise<void> => {
    const { t, accountId, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 40, BIG_ENTRY);

    let deleted = 1;
    while (deleted > 0) {
      deleted = (
        await t.mutation(internal.runtime.deleteAccountRuntimeData, {
          accountId: accountId,
        })
      ).totalDeleted;
    }
    expect(await entryCount(t, conversationKey)).toBe(0);
  });

  test("the account cascade removes 20 MB of entries in bounded batches", async (): Promise<void> => {
    const { t, accountId, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 40, BIG_ENTRY);

    while (
      !(await t.mutation(internal.account.accounts.removeBatch, {
        accountId: accountId,
      }))
    ) {
      continue;
    }
    expect(await entryCount(t, conversationKey)).toBe(0);
  });

  test("a read page holds at most 512 rows and every row once", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 600, "{}");

    const pages = await readAllPages(t, conversationKey, "s1");
    expect(pages[0]!.length).toBeLessThanOrEqual(512);
    const ids = pages.flat();
    expect(ids).toHaveLength(600);
    expect(new Set(ids).size).toBe(600);
  });

  test("a read page counts UTF-8 bytes, not characters", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    const cjk = "字".repeat(170_000);
    await seed(t, conversationKey, "s1", 30, cjk);

    const page = await t.query(internal.runtime.readHarnessSessionEntries, {
      conversationKey: conversationKey,
      sessionId: "s1",
    });
    const bytes = page.entries.reduce(
      (total, row) => total + new TextEncoder().encode(row.entry).byteLength,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(
      4 * 1_024 * 1_024 + MAX_HARNESS_SESSION_ENTRY_BYTES,
    );
  });

  test("a turn's 17 MB of entries lands through staged batches, then the checkpoint", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    const entries = Array.from({ length: 34 }, (_, index) => ({
      entryId: `e${index}`,
      ...(index > 0 ? { parentEntryId: `e${index - 1}` } : {}),
      version: 3,
      entry: BIG_ENTRY,
    }));
    const batches = harnessEntryBatches(entries);
    let afterSequence: number | undefined;
    for (const batch of batches.slice(0, -1)) {
      afterSequence = await t.mutation(
        internal.runtimeIngress.appendHarnessSessionEntries,
        {
          conversationKey: conversationKey,
          ...OWNER,
          sessionId: "s1",
          entries: batch,
          ...(afterSequence === undefined
            ? {}
            : { afterSequence: afterSequence }),
        },
      );
    }
    await t.mutation(internal.runtimeIngress.saveHarnessSession, {
      conversationKey: conversationKey,
      ...OWNER,
      harnessType: "pi",
      sessionId: "s1",
      resumeState: { data: { leafId: "e33" } },
      entries: batches.at(-1)!,
      ...(afterSequence === undefined ? {} : { afterSequence: afterSequence }),
    });

    expect(batches.length).toBeGreaterThan(1);
    expect((await readAllPages(t, conversationKey, "s1")).flat()).toEqual(
      entries.map((entry) => entry.entryId),
    );
  });

  test("a save after a partial clear prunes the cleared session's entries", async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { t, conversationKey } = await conversation();
      await t.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ...OWNER,
        harnessType: "pi",
        sessionId: "s1",
        resumeState: { data: { leafId: "e0" } },
        entries: [{ entryId: "e0", version: 3, entry: "{}" }],
      });
      await seed(t, conversationKey, "s1", 300, "{}");
      expect(
        (
          await t.mutation(internal.runtimeIngress.clearConversation, {
            conversationKey: conversationKey,
            ...OWNER,
          })
        ).hasMore,
      ).toBe(true);

      await t.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ...OWNER,
        harnessType: "pi",
        sessionId: "s2",
        resumeState: { data: { leafId: "f0" } },
        entries: [{ entryId: "f0", version: 3, entry: "{}" }],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await readAllPages(t, conversationKey, "s1")).flat()).toEqual([]);
      expect((await readAllPages(t, conversationKey, "s2")).flat()).toEqual([
        "f0",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("harness session context window", () => {
  test("a read spans the leaf's latest compaction to the leaf, and each branch keeps its own", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    await save(t, conversationKey, [
      ...chain(["e1", "e2", "e3", "e4", "e5", "e6"]),
      { entryId: "e7", parentEntryId: "e6", firstKeptEntryId: "e4" },
      { entryId: "e8", parentEntryId: "e7" },
    ]);
    await save(t, conversationKey, [
      { entryId: "e9", parentEntryId: "e8" },
      { entryId: "f4", parentEntryId: "e3" },
    ]);

    expect((await readAllPages(t, conversationKey, "s1", "e9")).flat()).toEqual(
      ["e4", "e5", "e6", "e7", "e8", "e9"],
    );
    expect((await readAllPages(t, conversationKey, "s1", "f4")).flat()).toEqual(
      ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "f4"],
    );
  });

  test("a retried staging before the first checkpoint never reuses a sequence", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    const staged = chain(["e1", "e2", "e3"]).map((link) => ({
      ...link,
      version: 3,
      entry: "{}",
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await t.mutation(internal.runtimeIngress.appendHarnessSessionEntries, {
        conversationKey: conversationKey,
        ...OWNER,
        sessionId: "s1",
        entries: staged,
      });
    }
    await save(t, conversationKey, [{ entryId: "e4", parentEntryId: "e3" }]);

    expect((await readAllPages(t, conversationKey, "s1", "e4")).flat()).toEqual(
      ["e1", "e2", "e3", "e4"],
    );
  });

  test("a leaf saved before context starts existed reads from the first row", async (): Promise<void> => {
    const { t, conversationKey } = await conversation();
    await seed(t, conversationKey, "s1", 3, "{}");

    expect(
      (await readAllPages(t, conversationKey, "s1", "seed-2")).flat(),
    ).toEqual(["seed-0", "seed-1", "seed-2"]);
  });
});

async function conversation(): Promise<Conversation> {
  const t = convexTest({
    schema: schema,
    modules: modules,
    transactionLimits: true,
  });
  const now = Date.now();
  const accountId = await t.run(
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
  const conversationKey = `acct:${accountId}:agent:test-agent:api:entries`;
  await t.mutation(internal.runtimeIngress.accept, {
    accountId: accountId,
    agentId: "test-agent",
    conversationKey: conversationKey,
    eventId: "owner",
    runId: "run_owner",
    idempotencyKey: "owner",
    payloadDigest: "digest:owner",
    events: [{ role: "user", content: "owner" }],
    delivery: {
      kind: "async",
      publicEventId: "owner",
      publicConversationKey: conversationKey,
      statusUrl: "https://example.test/v1/runs/run_owner",
    },
    requestedMode: "reject",
    sizeBytes: 32,
    leaseTtlMs: 60_000,
    envelopeTtlMs: 60_000,
    statusTtlMs: 7 * 24 * 60 * 60 * 1000,
    maxQueuedCount: 100,
    maxQueuedBytes: 1024 * 1024,
  });

  return { t: t, accountId: accountId, conversationKey: conversationKey };
}

async function entryCount(
  t: TestConvex<typeof schema>,
  conversationKey: string,
): Promise<number> {
  return (await readAllPages(t, conversationKey, "s1")).flat().length;
}

function chain(ids: string[]): EntryLink[] {
  return ids.map((entryId, index): EntryLink => ({
    entryId: entryId,
    ...(index > 0 ? { parentEntryId: ids[index - 1] } : {}),
  }));
}

async function readAllPages(
  t: TestConvex<typeof schema>,
  conversationKey: string,
  sessionId: string,
  leafEntryId?: string,
): Promise<string[][]> {
  const pages: string[][] = [];
  let afterSequence: number | undefined;
  for (;;) {
    const page = await t.query(internal.runtime.readHarnessSessionEntries, {
      conversationKey: conversationKey,
      sessionId: sessionId,
      ...(leafEntryId === undefined ? {} : { leafEntryId: leafEntryId }),
      ...(afterSequence === undefined ? {} : { afterSequence: afterSequence }),
    });
    pages.push(page.entries.map((row) => row.entryId));
    if (page.nextSequence === null) {
      return pages;
    }
    afterSequence = page.nextSequence;
  }
}

// One checkpoint of session s1 carrying these entries, leaf last.
async function save(
  t: TestConvex<typeof schema>,
  conversationKey: string,
  links: EntryLink[],
): Promise<void> {
  await t.mutation(internal.runtimeIngress.saveHarnessSession, {
    conversationKey: conversationKey,
    ...OWNER,
    harnessType: "pi",
    sessionId: "s1",
    resumeState: { data: { leafId: links.at(-1)!.entryId } },
    entries: links.map((link) => ({ ...link, version: 3, entry: "{}" })),
  });
}

// Written straight to the table, a few rows per transaction, as many turns would.
async function seed(
  t: TestConvex<typeof schema>,
  conversationKey: string,
  sessionId: string,
  count: number,
  entry: string,
): Promise<void> {
  const accountId = conversationKey.split(":")[1] as Id<"accounts">;
  const perTransaction = entry.length > 1_024 ? 5 : 200;
  for (let start = 0; start < count; start += perTransaction) {
    await t.run(async (ctx) => {
      for (
        let index = start;
        index < Math.min(count, start + perTransaction);
        index += 1
      ) {
        await ctx.db.insert("runtimeHarnessSessionEntries", {
          accountId: accountId,
          conversationKey: conversationKey,
          sessionId: sessionId,
          sequence: 1_000 + index,
          entryId: `seed-${index}`,
          version: 3,
          entry: entry,
        });
      }
    });
  }
}

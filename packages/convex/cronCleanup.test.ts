/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** One live cron with a run, plus two runs whose cron is already gone. */
async function seed(tt: T): Promise<{ accountId: Id<"accounts"> }> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "cleanup-test",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "agent",
      createdAt: now,
      updatedAt: now,
    });
    const liveCronId = await ctx.db.insert("crons", {
      accountId: accountId,
      name: "live",
      agentId: agentId,
      events: [],
      scheduleExpression: "rate(1 day)",
      status: "active" as const,
      schedulerName: "s-live",
      schedulerGroupName: "g",
      createdAt: now,
      updatedAt: now,
    });
    // Insert a second cron only to mint a valid id, then delete it: that is
    // exactly the state every pre-cascade `DELETE /v1/crons/{id}` left behind.
    const goneCronId = await ctx.db.insert("crons", {
      accountId: accountId,
      name: "gone",
      agentId: agentId,
      events: [],
      scheduleExpression: "rate(1 day)",
      status: "active" as const,
      schedulerName: "s-gone",
      schedulerGroupName: "g",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.delete(goneCronId);

    for (const cronId of [liveCronId, goneCronId, goneCronId]) {
      await ctx.db.insert("cronRuns", {
        accountId: accountId,
        cronId: cronId,
        eventId: `evt-${cronId}`,
        conversationKey: "cron:key",
        status: "completed" as const,
        startedAt: now,
      });
    }

    return { accountId: accountId };
  });
}

describe("deleteOrphanedCronRuns", () => {
  test("reports orphans without touching them on a dry run", async () => {
    const tt = t();
    await seed(tt);

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedCronRuns, {
        dryRun: true,
      }),
    ).toMatchObject({ scanned: 3, orphaned: 2, isDone: true });
    expect(
      await tt.run(async (ctx) => await ctx.db.query("cronRuns").collect()),
    ).toHaveLength(3);
  });

  test("keeps every run when dryRun is left out", async () => {
    const tt = t();
    await seed(tt);

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedCronRuns, {}),
    ).toMatchObject({ orphaned: 2, isDone: true });
    expect(
      await tt.run(async (ctx) => await ctx.db.query("cronRuns").collect()),
    ).toHaveLength(3);
  });

  test("deletes only the runs whose cron is gone", async () => {
    const tt = t();
    await seed(tt);

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedCronRuns, {
        dryRun: false,
      }),
    ).toMatchObject({ orphaned: 2, isDone: true });
    const left = await tt.run(
      async (ctx) => await ctx.db.query("cronRuns").collect(),
    );
    expect(left).toHaveLength(1);
    expect(await tt.run(async (ctx) => ctx.db.get(left[0]!.cronId))).not.toBe(
      null,
    );
  });

  test("pages through the table with the returned cursor", async () => {
    const tt = t();
    await seed(tt);

    const first = await tt.mutation(
      internal.migrations.deleteOrphanedCronRuns,
      {
        numItems: 2,
        dryRun: true,
      },
    );
    expect(first).toMatchObject({ scanned: 2, isDone: false });
    expect(
      await tt.mutation(internal.migrations.deleteOrphanedCronRuns, {
        cursor: first.cursor,
        numItems: 2,
        dryRun: true,
      }),
    ).toMatchObject({ scanned: 1, isDone: true });
  });
});

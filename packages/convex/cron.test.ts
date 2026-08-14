/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

describe("list", () => {
  test("returns only the named agent's jobs", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    expect(
      (
        await tt.query(internal.cron.list, {
          accountId: accountId,
          agentId: agentId,
        })
      ).map((cron) => cron.name),
    ).toEqual(["mine"]);
    expect(
      (await tt.query(internal.cron.list, { accountId: accountId })).length,
    ).toBe(2);
  });
});

/** One account whose two agents own one cron job each. */
async function seed(
  tt: T,
): Promise<{ accountId: Id<"accounts">; agentId: Id<"agents"> }> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "cron-test",
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
    const otherAgentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "other",
      createdAt: now,
      updatedAt: now,
    });
    for (const [name, owner] of [
      ["mine", agentId],
      ["theirs", otherAgentId],
    ] as const) {
      await ctx.db.insert("crons", {
        accountId: accountId,
        name: name,
        agentId: owner,
        events: [],
        scheduleExpression: "rate(1 day)",
        status: "active" as const,
        schedulerName: `s-${name}`,
        schedulerGroupName: "g",
        createdAt: now,
        updatedAt: now,
      });
    }

    return { accountId: accountId, agentId: agentId };
  });
}

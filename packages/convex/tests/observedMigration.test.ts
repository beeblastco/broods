/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
// More rows than one page, so the strip schedules itself across pages.
const ROWS_PER_TABLE = 60;

test("strips observed from every row of both result tables, page by page", async (): Promise<void> => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  await t.run(async (ctx): Promise<void> => {
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org",
      username: "user",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const stamp = new Date(now).toISOString();
    for (let i = 0; i < ROWS_PER_TABLE; i += 1) {
      await ctx.db.insert("runtimeAsyncAgentResults", {
        accountId: accountId,
        eventId: `event-${i}`,
        conversationKey: "conversation",
        observed: i % 2 === 0,
        handback: "stored",
        status: "completed",
        createdAt: stamp,
        updatedAt: stamp,
        expiresAt: now,
      });
      await ctx.db.insert("runtimeAsyncToolResults", {
        accountId: accountId,
        resultId: `result-${i}`,
        parentEventId: "parent",
        conversationKey: "conversation",
        toolName: "bash",
        toolCallId: `call-${i}`,
        input: {},
        observed: true,
        status: "completed",
        createdAt: stamp,
        updatedAt: stamp,
        expiresAt: now,
      });
    }
  });

  await t.mutation(internal.observedMigration.stripObserved, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();

  const rows = await t.run(
    async (
      ctx,
    ): Promise<
      Array<Doc<"runtimeAsyncAgentResults"> | Doc<"runtimeAsyncToolResults">>
    > => [
      ...(await ctx.db.query("runtimeAsyncAgentResults").collect()),
      ...(await ctx.db.query("runtimeAsyncToolResults").collect()),
    ],
  );
  expect(rows).toHaveLength(2 * ROWS_PER_TABLE);
  expect(rows.filter((row): boolean => row.observed !== undefined)).toEqual([]);
  // Only the flag goes.
  expect(rows[0]).toMatchObject({ handback: "stored", status: "completed" });
});

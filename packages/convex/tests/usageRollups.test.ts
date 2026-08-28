/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { collectUsageRollups, usageGrainForBinSeconds } from "../logs";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ENDPOINT_ID = "ep-usage-test";

// 2026-01-15T13:07:30Z — misaligned with every grain so the three floors differ.
const FINISHED_AT = Date.UTC(2026, 0, 15, 13, 7, 30);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

// fetchUsageStats itself needs the WorkOS AuthKit component that convex-test
// does not register here (see projectScope.test.ts), so the reader test hits
// the exported grain-selection and row-collection helpers it delegates to.

async function seedAccount(tt: T): Promise<Id<"accounts">> {
  return await tt.run(async (ctx) => {
    const now = Date.now();

    return await ctx.db.insert("accounts", {
      orgId: "org-usage",
      username: "usage-test-account",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function taskUsageArgs(
  accountId: Id<"accounts">,
  taskId: string,
  finishedAt: number,
) {
  return {
    accountId: accountId,
    endpointId: ENDPOINT_ID,
    agentId: "agent-1",
    conversationKey: "conv-1",
    taskId: taskId,
    modelProvider: "anthropic",
    modelId: "claude-test",
    finishedAt: finishedAt,
    durationMs: 1000,
    status: "completed" as const,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedInputTokens: 10,
    cacheWriteTokens: 2,
    totalTokens: 137,
    runtimeKind: "microvm",
    runtimeWallMs: 1500,
    runtimeMemoryMb: 512,
    sandboxUsage: [],
    stepCount: 3,
    toolCallCount: 1,
  };
}

test("recordTaskUsage folds each sample into 5m, hour, and day buckets", async () => {
  const tt = t();
  const accountId = await seedAccount(tt);

  await tt.mutation(
    internal.usage.recordTaskUsage,
    taskUsageArgs(accountId, "task-1", FINISHED_AT),
  );
  // Same hour, different 5-minute window: must open a second 5m bucket but
  // accumulate into the existing hour and day buckets.
  await tt.mutation(
    internal.usage.recordTaskUsage,
    taskUsageArgs(accountId, "task-2", FINISHED_AT + 10 * 60 * 1000),
  );

  const rows = await tt.run(
    async (ctx) => await ctx.db.query("usageRollups").collect(),
  );
  const byGrain = (grain: "5m" | "hour" | "day") =>
    rows.filter((row) => row.grain === grain);

  expect(rows).toHaveLength(4);
  expect(
    byGrain("5m")
      .map((row) => row.bucketStart)
      .sort(),
  ).toEqual([Date.UTC(2026, 0, 15, 13, 5), Date.UTC(2026, 0, 15, 13, 15)]);
  expect(byGrain("hour")).toMatchObject([
    {
      bucketStart: Math.floor(FINISHED_AT / HOUR_MS) * HOUR_MS,
      inputTokens: 200,
      totalTokens: 274,
      invocations: 2,
      modelCalls: 6,
    },
  ]);
  expect(byGrain("day")).toMatchObject([
    {
      bucketStart: Math.floor(FINISHED_AT / DAY_MS) * DAY_MS,
      totalTokens: 274,
      invocations: 2,
    },
  ]);
});

test("long ranges read day-grain rows; 5m still merges legacy rows", async () => {
  const tt = t();
  const accountId = await seedAccount(tt);

  await tt.run(async (ctx) => {
    const base = {
      accountId: accountId,
      endpointId: ENDPOINT_ID,
      modelProvider: "anthropic",
      modelId: "claude-test",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      invocations: 1,
      modelCalls: 1,
      runtimeWallMs: 10,
      agentSandboxCpuUsec: 0,
      toolSandboxCpuUsec: 0,
      updatedAt: FINISHED_AT,
    };
    await ctx.db.insert("usageRollups", {
      ...base,
      grain: "day" as const,
      bucketStart: Math.floor(FINISHED_AT / DAY_MS) * DAY_MS,
    });
    await ctx.db.insert("usageRollups", {
      ...base,
      grain: "hour" as const,
      bucketStart: Math.floor(FINISHED_AT / HOUR_MS) * HOUR_MS,
    });
    await ctx.db.insert("usageRollups", {
      ...base,
      grain: "5m" as const,
      bucketStart: Date.UTC(2026, 0, 15, 13, 5),
    });
    // Legacy pre-backfill row: no grain, implicitly 5m.
    await ctx.db.insert("usageRollups", {
      ...base,
      bucketStart: Date.UTC(2026, 0, 15, 13, 10),
    });
  });

  // The 30d range displays 24h bins, so it must select the day grain.
  const grain = usageGrainForBinSeconds(24 * 60 * 60);
  expect(grain).toBe("day");

  const startMs = FINISHED_AT - 30 * DAY_MS;
  const dayRows = await tt.run(
    async (ctx) => await collectUsageRollups(ctx, ENDPOINT_ID, grain, startMs),
  );
  expect(dayRows.map((row) => row.grain)).toEqual(["day"]);

  const fiveMinuteRows = await tt.run(
    async (ctx) => await collectUsageRollups(ctx, ENDPOINT_ID, "5m", startMs),
  );
  expect(fiveMinuteRows.map((row) => row.grain ?? "legacy").sort()).toEqual([
    "5m",
    "legacy",
  ]);
});

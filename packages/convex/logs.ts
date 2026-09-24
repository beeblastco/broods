/**
 * Reactive reads for the dashboard usage panel. Queries the pre-aggregated
 * `usageRollups` table (written by `usage.recordTaskUsage`) so the panel streams
 * live token/compute totals via Convex subscriptions. Durable/raw logs now
 * live in Loki and are streamed via the gateway (NATS + Loki backfill).
 */

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { authKit } from "./auth";
import { projectEndpointIds } from "./model/usageEndpoints";
import { type UsageGrain } from "./usage";

const usageRange = v.union(
  v.literal("1h"),
  v.literal("3h"),
  v.literal("1d"),
  v.literal("7d"),
  v.literal("30d"),
  v.literal("1y"),
);

/** Time-bucketed token usage point grouped by model/provider. */
const usageBucket = v.object({
  bucketStart: v.number(),
  modelProvider: v.string(),
  modelId: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  reasoningTokens: v.number(),
  cachedInputTokens: v.number(),
  cacheWriteTokens: v.number(),
  totalTokens: v.number(),
  invocations: v.number(),
  modelCalls: v.number(),
  runtimeWallMs: v.number(),
  agentSandboxCpuUsec: v.number(),
  toolSandboxCpuUsec: v.number(),
});

const usageStats = v.object({
  range: usageRange,
  binSeconds: v.number(),
  startTimeMs: v.number(),
  endTimeMs: v.number(),
  buckets: v.array(usageBucket),
  totals: v.object({
    inputTokens: v.number(),
    outputTokens: v.number(),
    reasoningTokens: v.number(),
    cachedInputTokens: v.number(),
    cacheWriteTokens: v.number(),
    totalTokens: v.number(),
    invocations: v.number(),
    modelCalls: v.number(),
    runtimeWallMs: v.number(),
    agentSandboxCpuUsec: v.number(),
    toolSandboxCpuUsec: v.number(),
  }),
});

const RANGE_CONFIG: Record<
  "1h" | "3h" | "1d" | "7d" | "30d" | "1y",
  { lookbackMs: number; binSeconds: number }
> = {
  "1h": { lookbackMs: 60 * 60 * 1000, binSeconds: 5 * 60 },
  "3h": { lookbackMs: 3 * 60 * 60 * 1000, binSeconds: 15 * 60 },
  "1d": { lookbackMs: 24 * 60 * 60 * 1000, binSeconds: 60 * 60 },
  "7d": { lookbackMs: 7 * 24 * 60 * 60 * 1000, binSeconds: 6 * 60 * 60 },
  "30d": { lookbackMs: 30 * 24 * 60 * 60 * 1000, binSeconds: 24 * 60 * 60 },
  "1y": { lookbackMs: 365 * 24 * 60 * 60 * 1000, binSeconds: 7 * 24 * 60 * 60 },
};

// Bounds the drill-down read: rows scanned per endpoint, and tasks returned.
const USAGE_TASK_SCAN_LIMIT = 1000;
const USAGE_TASK_RETURN_LIMIT = 100;

/** One finished task behind a usage bin, linked to its trace. */
const usageTask = v.object({
  /** Null for rows written without a trace suffix on `taskId`. */
  traceId: v.union(v.string(), v.null()),
  agentId: v.string(),
  modelProvider: v.string(),
  modelId: v.string(),
  finishedAt: v.number(),
  durationMs: v.number(),
  status: v.union(v.literal("completed"), v.literal("failed")),
  inputTokens: v.number(),
  outputTokens: v.number(),
  reasoningTokens: v.number(),
  cachedInputTokens: v.number(),
  cacheWriteTokens: v.number(),
  totalTokens: v.number(),
  stepCount: v.number(),
});

/** One aggregated usage point: bin start, model identity, and the 11 metric counters. */
type UsageBucketRow = {
  bucketStart: number;
  modelProvider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  invocations: number;
  modelCalls: number;
  runtimeWallMs: number;
  agentSandboxCpuUsec: number;
  toolSandboxCpuUsec: number;
};

/** The metric counters summed across every bucket in range. */
type UsageTotals = Omit<
  UsageBucketRow,
  "bucketStart" | "modelProvider" | "modelId"
>;

/**
 * Reactive token-usage aggregates for the dashboard usage panel, scoped to the
 * caller's project/stage. Reads the coarsest rollup grain that fits the
 * range's display bins and re-groups it into the requested range. Subscribed
 * via `useQuery`, so totals update live.
 * @returns time-bucketed usage grouped by (modelProvider, modelId) plus totals
 */
export const fetchUsageStats = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.optional(v.id("stages")),
    range: usageRange,
  },
  returns: usageStats,
  handler: async (ctx, args) => {
    const { projectId, stageId, range } = args;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const cfg = RANGE_CONFIG[range];
    const nowMs = Date.now();
    const startMs = nowMs - cfg.lookbackMs;

    const endpointIds = await projectEndpointIds(
      ctx,
      authUser.id,
      projectId,
      stageId,
    );
    const base = {
      range: range,
      binSeconds: cfg.binSeconds,
      startTimeMs: startMs,
      endTimeMs: nowMs,
    };
    if (endpointIds.length === 0) {
      return {
        ...base,
        buckets: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          invocations: 0,
          modelCalls: 0,
          runtimeWallMs: 0,
          agentSandboxCpuUsec: 0,
          toolSandboxCpuUsec: 0,
        },
      };
    }

    const grain = usageGrainForBinSeconds(cfg.binSeconds);
    const batches = await Promise.all(
      endpointIds.map((endpointId) =>
        collectUsageRollups(ctx, endpointId, grain, startMs),
      ),
    );

    const { buckets, totals } = aggregateUsage(batches.flat(), cfg.binSeconds);

    return { ...base, buckets: buckets, totals: totals };
  },
});

/**
 * Finished tasks inside one usage chart bin, heaviest first, so the dashboard
 * can show which traces a bin's tokens came from. Scans at most
 * `USAGE_TASK_SCAN_LIMIT` rows per endpoint and says so via `truncated`.
 * `taskUsage` is pruned after 90 days, so older bins return no tasks.
 */
export const fetchUsageTasks = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.optional(v.id("stages")),
    startMs: v.number(),
    endMs: v.number(),
  },
  returns: v.object({
    tasks: v.array(usageTask),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const endpointIds = await projectEndpointIds(
      ctx,
      authUser.id,
      args.projectId,
      args.stageId,
    );
    const batches = await Promise.all(
      endpointIds.map((endpointId) =>
        collectUsageTasks(ctx, endpointId, args.startMs, args.endMs),
      ),
    );
    const rows = batches.flat();
    const truncated =
      rows.length > USAGE_TASK_RETURN_LIMIT ||
      batches.some((batch) => batch.length === USAGE_TASK_SCAN_LIMIT);
    const tasks = rows
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, USAGE_TASK_RETURN_LIMIT)
      .map((row) => ({
        traceId: traceIdFromTaskId(row.taskId),
        agentId: row.agentId,
        modelProvider: row.modelProvider,
        modelId: row.modelId,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        status: row.status,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        totalTokens: row.totalTokens,
        stepCount: row.stepCount,
      }));

    return { tasks: tasks, truncated: truncated };
  },
});

/**
 * Rollup rows for one endpoint at one grain since `startMs`. Exported for
 * `fetchUsageStats` and its test; not a registered Convex function.
 */
export async function collectUsageRollups(
  ctx: QueryCtx,
  endpointId: string,
  grain: UsageGrain,
  startMs: number,
): Promise<Doc<"usageRollups">[]> {
  return await ctx.db
    .query("usageRollups")
    .withIndex("by_endpointId_and_grain_and_bucketStart", (q) =>
      q
        .eq("endpointId", endpointId)
        .eq("grain", grain)
        .gte("bucketStart", startMs),
    )
    .collect();
}

/**
 * Task usage rows for one endpoint that finished in `[startMs, endMs)`.
 * Exported for `fetchUsageTasks` and its test; not a registered Convex function.
 */
export async function collectUsageTasks(
  ctx: QueryCtx,
  endpointId: string,
  startMs: number,
  endMs: number,
): Promise<Doc<"taskUsage">[]> {
  return await ctx.db
    .query("taskUsage")
    .withIndex("by_endpointId_and_finishedAt", (q) =>
      q
        .eq("endpointId", endpointId)
        .gte("finishedAt", startMs)
        .lt("finishedAt", endMs),
    )
    .take(USAGE_TASK_SCAN_LIMIT);
}

/**
 * Rollup grain to read for a display bin: bins under an hour need "5m" rows,
 * under a day "hour" rows, and a day or wider "day" rows. Keeps long ranges
 * from collecting every 5-minute bucket.
 */
export function usageGrainForBinSeconds(binSeconds: number): UsageGrain {
  if (binSeconds < 60 * 60) {
    return "5m";
  }
  if (binSeconds < 24 * 60 * 60) {
    return "hour";
  }

  return "day";
}

function aggregateUsage(
  rows: UsageBucketRow[],
  binSeconds: number,
): { buckets: UsageBucketRow[]; totals: UsageTotals } {
  const binMs = binSeconds * 1000;
  const byKey = new Map<string, UsageBucketRow>();
  for (const row of rows) {
    const bucketStart = Math.floor(row.bucketStart / binMs) * binMs;
    const key = `${bucketStart}|${row.modelProvider}|${row.modelId}`;
    const acc = byKey.get(key);
    if (acc) {
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.reasoningTokens += row.reasoningTokens;
      acc.cachedInputTokens += row.cachedInputTokens;
      acc.cacheWriteTokens += row.cacheWriteTokens;
      acc.totalTokens += row.totalTokens;
      acc.invocations += row.invocations;
      acc.modelCalls += row.modelCalls;
      acc.runtimeWallMs += row.runtimeWallMs;
      acc.agentSandboxCpuUsec += row.agentSandboxCpuUsec;
      acc.toolSandboxCpuUsec += row.toolSandboxCpuUsec;
    } else {
      byKey.set(key, {
        bucketStart: bucketStart,
        modelProvider: row.modelProvider,
        modelId: row.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        totalTokens: row.totalTokens,
        invocations: row.invocations,
        modelCalls: row.modelCalls,
        runtimeWallMs: row.runtimeWallMs,
        agentSandboxCpuUsec: row.agentSandboxCpuUsec,
        toolSandboxCpuUsec: row.toolSandboxCpuUsec,
      });
    }
  }

  const buckets = [...byKey.values()].sort(
    (a, b) => a.bucketStart - b.bucketStart,
  );
  const totals = buckets.reduce(
    (acc, b) => {
      acc.inputTokens += b.inputTokens;
      acc.outputTokens += b.outputTokens;
      acc.reasoningTokens += b.reasoningTokens;
      acc.cachedInputTokens += b.cachedInputTokens;
      acc.cacheWriteTokens += b.cacheWriteTokens;
      acc.totalTokens += b.totalTokens;
      acc.invocations += b.invocations;
      acc.modelCalls += b.modelCalls;
      acc.runtimeWallMs += b.runtimeWallMs;
      acc.agentSandboxCpuUsec += b.agentSandboxCpuUsec;
      acc.toolSandboxCpuUsec += b.toolSandboxCpuUsec;

      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      invocations: 0,
      modelCalls: 0,
      runtimeWallMs: 0,
      agentSandboxCpuUsec: 0,
      toolSandboxCpuUsec: 0,
    },
  );

  return { buckets: buckets, totals: totals };
}

/** Trace id from a `${eventId}#${traceId}` task id, or null when it has none. */
function traceIdFromTaskId(taskId: string): string | null {
  const separator = taskId.lastIndexOf("#");

  return separator === -1 ? null : taskId.slice(separator + 1) || null;
}

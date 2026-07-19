/**
 * Reactive reads for the dashboard usage panel. Queries the pre-aggregated
 * `usageRollups` table (written by `usage.recordTaskUsage`) so the panel streams
 * live token/compute totals via Convex subscriptions. Durable/raw logs now
 * live in Loki and are streamed via the gateway (NATS + Loki backfill).
 */

import { v } from "convex/values";
import { action, query } from "./_generated/server";
import { authKit } from "./auth";
import { projectEndpointIds } from "./logsHelpers";

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

/**
 * Re-group 5-minute usage rollups into the requested range's bins and total them.
 */
function aggregateUsage(
  rows: Array<{
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
  }>,
  binSeconds: number,
) {
  const binMs = binSeconds * 1000;
  const byKey = new Map<string, (typeof rows)[number]>();
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

/**
 * Reactive token-usage aggregates for the dashboard usage panel, scoped to the
 * caller's project/environment. Re-groups the 5-minute rollups into the
 * requested range. Subscribed via `useQuery`, so totals update live.
 * @returns time-bucketed usage grouped by (modelProvider, modelId) plus totals
 */
export const fetchUsageStats = query({
  args: {
    projectId: v.id("projects"),
    environmentId: v.optional(v.id("environments")),
    range: usageRange,
  },
  returns: usageStats,
  handler: async (ctx, args) => {
    const { projectId, environmentId, range } = args;

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
      environmentId,
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

    const batches = await Promise.all(
      endpointIds.map((endpointId) =>
        ctx.db
          .query("usageRollups")
          .withIndex("by_endpointId_and_bucketStart", (q) =>
            q.eq("endpointId", endpointId).gte("bucketStart", startMs),
          )
          .collect(),
      ),
    );

    const { buckets, totals } = aggregateUsage(batches.flat(), cfg.binSeconds);

    return { ...base, buckets: buckets, totals: totals };
  },
});

/**
 * Placeholder for deep/cold log search beyond the hot window. The realtime hot
 * path covers ~48h; older logs are durable in Loki and queried through Grafana.
 * Wire a Grafana datasource-proxy fetch here when product needs in-app history.
 */
export const searchHistory = action({
  args: {
    projectId: v.id("projects"),
    environmentId: v.optional(v.id("environments")),
    query: v.optional(v.string()),
  },
  returns: v.array(v.any()),
  handler: async () => {
    return [];
  },
});

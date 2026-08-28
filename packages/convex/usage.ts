/**
 * Usage write path: records one finished task row and folds its token/compute
 * counts into the matching 5-minute, hour, and day rollup buckets. Called by
 * core via the deploy-key admin client at task completion; never blocks the
 * agent reply. Pricing is intentionally absent — only raw counts are stored;
 * the dashboard computes cost at render from the shared hardcoded pricing table.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";

const TASK_USAGE_PRUNE_BATCH_SIZE = 100;
const TASK_USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Fixed base bin for usage rollups: 5 minutes in ms, shared with telemetry.ts. */
export const USAGE_BIN_MS = 5 * 60 * 1000;

/** Bucket width per rollup grain; bucketStart = floor(ts / width) * width (UTC). */
export const USAGE_GRAIN_MS: Record<UsageGrain, number> = {
  "5m": USAGE_BIN_MS,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/** Rollup grain. Stored rows missing `grain` are legacy "5m" rows. */
export type UsageGrain = "5m" | "hour" | "day";

/** Counter fields folded into a rollup bucket, summed identically per grain. */
type RollupCounters = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  runtimeWallMs: number;
  agentSandboxCpuUsec: number;
  toolSandboxCpuUsec: number;
  invocations: number;
  modelCalls: number;
};

/**
 * Upsert one usage rollup bucket: add `counters` onto the row keyed by
 * (account, endpoint, grain, bucketStart, provider, model), inserting it when
 * absent. The composite index predates `grain`, so grains sharing an aligned
 * bucketStart are narrowed in JS; a legacy row with no grain counts as "5m"
 * and gets stamped on first touch. Shared with the backfill in migrations.ts.
 */
export async function foldRollupBucket(
  ctx: MutationCtx,
  target: {
    accountId: Id<"accounts">;
    endpointId: string;
    grain: UsageGrain;
    bucketStart: number;
    modelProvider: string;
    modelId: string;
    counters: RollupCounters;
  },
): Promise<void> {
  const candidates = await ctx.db
    .query("usageRollups")
    .withIndex(
      "by_accountId_endpointId_bucketStart_modelProvider_modelId",
      (q) =>
        q
          .eq("accountId", target.accountId)
          .eq("endpointId", target.endpointId)
          .eq("bucketStart", target.bucketStart)
          .eq("modelProvider", target.modelProvider)
          .eq("modelId", target.modelId),
    )
    .collect();
  const existing = candidates.find(
    (row) => (row.grain ?? "5m") === target.grain,
  );

  if (existing) {
    await ctx.db.patch(existing._id, {
      grain: target.grain,
      inputTokens: existing.inputTokens + target.counters.inputTokens,
      outputTokens: existing.outputTokens + target.counters.outputTokens,
      reasoningTokens:
        existing.reasoningTokens + target.counters.reasoningTokens,
      cachedInputTokens:
        existing.cachedInputTokens + target.counters.cachedInputTokens,
      cacheWriteTokens:
        existing.cacheWriteTokens + target.counters.cacheWriteTokens,
      totalTokens: existing.totalTokens + target.counters.totalTokens,
      runtimeWallMs: existing.runtimeWallMs + target.counters.runtimeWallMs,
      agentSandboxCpuUsec:
        existing.agentSandboxCpuUsec + target.counters.agentSandboxCpuUsec,
      toolSandboxCpuUsec:
        existing.toolSandboxCpuUsec + target.counters.toolSandboxCpuUsec,
      invocations: existing.invocations + target.counters.invocations,
      modelCalls: existing.modelCalls + target.counters.modelCalls,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("usageRollups", {
      accountId: target.accountId,
      endpointId: target.endpointId,
      grain: target.grain,
      bucketStart: target.bucketStart,
      modelProvider: target.modelProvider,
      modelId: target.modelId,
      inputTokens: target.counters.inputTokens,
      outputTokens: target.counters.outputTokens,
      reasoningTokens: target.counters.reasoningTokens,
      cachedInputTokens: target.counters.cachedInputTokens,
      cacheWriteTokens: target.counters.cacheWriteTokens,
      totalTokens: target.counters.totalTokens,
      runtimeWallMs: target.counters.runtimeWallMs,
      agentSandboxCpuUsec: target.counters.agentSandboxCpuUsec,
      toolSandboxCpuUsec: target.counters.toolSandboxCpuUsec,
      invocations: target.counters.invocations,
      modelCalls: target.counters.modelCalls,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Record one finished agent task: insert a `taskUsage` row and fold its
 * token/compute counts into the 5-minute, hour, and day `usageRollups`
 * buckets. Deduplicated by `(accountId, taskId)` so a Lambda retry never
 * double-counts without allowing one tenant's task identifier to suppress
 * another tenant's usage.
 */
export const recordTaskUsage = internalMutation({
  args: {
    accountId: v.id("accounts"),
    endpointId: v.string(),
    agentId: v.string(),
    conversationKey: v.string(),
    taskId: v.string(),
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
    runtimeKind: v.string(),
    runtimeWallMs: v.number(),
    runtimeMemoryMb: v.number(),
    sandboxUsage: v.array(
      v.object({
        type: v.string(),
        role: v.union(v.literal("agent"), v.literal("tool")),
        toolName: v.optional(v.string()),
        cpuUsec: v.number(),
      }),
    ),
    stepCount: v.number(),
    toolCallCount: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Idempotency across Lambda retries: the harness `usageFinalized` flag only
    // guards within one process, so a retried invocation (same taskId, new
    // process) would otherwise insert a duplicate row and double-fold the
    // rollups. Skip if this task was already recorded.
    const already = await ctx.db
      .query("taskUsage")
      .withIndex("by_accountId_and_taskId", (q) =>
        q.eq("accountId", args.accountId).eq("taskId", args.taskId),
      )
      .unique();
    if (already) {
      return null;
    }

    // Split sandbox CPU by role so the flat rollup keeps the agent/tool breakdown.
    let agentSandboxCpuUsec = 0;
    let toolSandboxCpuUsec = 0;
    for (const s of args.sandboxUsage) {
      if (s.role === "tool") {
        toolSandboxCpuUsec += s.cpuUsec;
      } else {
        agentSandboxCpuUsec += s.cpuUsec;
      }
    }

    // Insert per-task row for line-item cost history.
    await ctx.db.insert("taskUsage", {
      accountId: args.accountId,
      endpointId: args.endpointId,
      agentId: args.agentId,
      conversationKey: args.conversationKey,
      taskId: args.taskId,
      modelProvider: args.modelProvider,
      modelId: args.modelId,
      finishedAt: args.finishedAt,
      durationMs: args.durationMs,
      status: args.status,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      reasoningTokens: args.reasoningTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      totalTokens: args.totalTokens,
      runtimeKind: args.runtimeKind,
      runtimeWallMs: args.runtimeWallMs,
      runtimeMemoryMb: args.runtimeMemoryMb,
      sandboxUsage: args.sandboxUsage,
      stepCount: args.stepCount,
      toolCallCount: args.toolCallCount,
    });

    // Fold the same task's counts into one bucket per grain so long dashboard
    // ranges read hour/day rows instead of every 5-minute bucket.
    const counters: RollupCounters = {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      reasoningTokens: args.reasoningTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      totalTokens: args.totalTokens,
      runtimeWallMs: args.runtimeWallMs,
      agentSandboxCpuUsec: agentSandboxCpuUsec,
      toolSandboxCpuUsec: toolSandboxCpuUsec,
      invocations: 1,
      modelCalls: args.stepCount,
    };
    const grains: UsageGrain[] = ["5m", "hour", "day"];
    for (const grain of grains) {
      const grainMs = USAGE_GRAIN_MS[grain];
      await foldRollupBucket(ctx, {
        accountId: args.accountId,
        endpointId: args.endpointId,
        grain: grain,
        bucketStart: Math.floor(args.finishedAt / grainMs) * grainMs,
        modelProvider: args.modelProvider,
        modelId: args.modelId,
        counters: counters,
      });
    }

    return null;
  },
});

/**
 * Deletes raw task usage samples older than the retention window, one bounded
 * batch per invocation. Samples exist for retry dedup (a window of minutes)
 * and are folded into `usageRollups` at write time, so old rows are pure
 * storage growth. The creation-index range reads nothing when nothing is due.
 */
export const pruneExpiredTaskUsage = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - TASK_USAGE_RETENTION_MS;
    const rows = await ctx.db
      .query("taskUsage")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(TASK_USAGE_PRUNE_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === TASK_USAGE_PRUNE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.usage.pruneExpiredTaskUsage, {});
    }

    return rows.length;
  },
});

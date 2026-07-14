/**
 * Usage write path: records one finished task row and folds its token/compute
 * counts into the matching 5-minute rollup bucket. Called by core via the
 * deploy-key admin client at task completion; never blocks the agent reply.
 * Pricing is intentionally absent — only raw counts are stored; the dashboard
 * computes cost at render from the shared hardcoded pricing table.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Fixed base bin for usage rollups: 5 minutes in ms, shared with telemetry.ts. */
export const USAGE_BIN_MS = 5 * 60 * 1000;

/**
 * Record one finished agent task: insert a `taskUsage` row and fold its
 * token/compute counts into the 5-minute `usageRollups` bucket. Deduplicated by
 * `(accountId, taskId)` so a Lambda retry never double-counts without allowing
 * one tenant's task identifier to suppress another tenant's usage.
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
        // rollup. Skip if this task was already recorded.
        const already = await ctx.db
            .query("taskUsage")
            .withIndex("by_accountId_and_taskId", (q) => q.eq("accountId", args.accountId).eq("taskId", args.taskId))
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

        // Fold the same task's counts into the 5-minute rollup bucket.
        const bucketStart = Math.floor(args.finishedAt / USAGE_BIN_MS) * USAGE_BIN_MS;
        const existing = await ctx.db
            .query("usageRollups")
            .withIndex("by_accountId_endpointId_bucketStart_modelProvider_modelId", (q) =>
                q
                    .eq("accountId", args.accountId)
                    .eq("endpointId", args.endpointId)
                    .eq("bucketStart", bucketStart)
                    .eq("modelProvider", args.modelProvider)
                    .eq("modelId", args.modelId),
            )
            .unique();

        if (existing) {
            await ctx.db.patch(existing._id, {
                inputTokens: existing.inputTokens + args.inputTokens,
                outputTokens: existing.outputTokens + args.outputTokens,
                reasoningTokens: existing.reasoningTokens + args.reasoningTokens,
                cachedInputTokens: existing.cachedInputTokens + args.cachedInputTokens,
                cacheWriteTokens: existing.cacheWriteTokens + args.cacheWriteTokens,
                totalTokens: existing.totalTokens + args.totalTokens,
                runtimeWallMs: existing.runtimeWallMs + args.runtimeWallMs,
                agentSandboxCpuUsec: existing.agentSandboxCpuUsec + agentSandboxCpuUsec,
                toolSandboxCpuUsec: existing.toolSandboxCpuUsec + toolSandboxCpuUsec,
                invocations: existing.invocations + 1,
                modelCalls: existing.modelCalls + args.stepCount,
                updatedAt: Date.now(),
            });
        } else {
            await ctx.db.insert("usageRollups", {
                accountId: args.accountId,
                endpointId: args.endpointId,
                bucketStart: bucketStart,
                modelProvider: args.modelProvider,
                modelId: args.modelId,
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
                updatedAt: Date.now(),
            });
        }

        return null;
    },
});

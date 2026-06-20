/**
 * Convex UsageStore implementation. Calls internal.usage.recordTask via the
 * deploy-key ConvexHttpClient. Fire-and-forget safe — errors are caught and
 * logged; they never propagate into the agent execution path.
 *
 * endpointId, project, and environment are passed when present (Convex has
 * full per-env scope). DynamoDB ignores those fields; see dynamo/usage.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@filthy-panty/convex/_generated/api").internal;
import type { UsageStore, UsageTaskInput } from "../types.ts";
import { getConvexClient } from "./client.ts";
import { logError } from "../../log.ts";

export const usage: UsageStore = {
  async recordTask(input: UsageTaskInput): Promise<void> {
    try {
      await getConvexClient().mutation(internal.usage.recordTask, {
        accountId: input.accountId as any,
        endpointId: input.endpointId ?? "",
        agentId: input.agentId,
        conversationKey: input.conversationKey,
        taskId: input.taskId,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        status: input.status,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reasoningTokens: input.reasoningTokens,
        cachedInputTokens: input.cachedInputTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
        runtimeKind: input.runtimeKind,
        runtimeWallMs: input.runtimeWallMs,
        runtimeMemoryMb: input.runtimeMemoryMb,
        sandboxUsage: input.sandboxUsage,
        stepCount: input.stepCount,
        toolCallCount: input.toolCallCount,
      });
    } catch (err) {
      logError("Usage write failed (convex)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

import { logError } from "../log.ts";
import type { Storage } from "../storage.ts";
import { adminMutation, internal } from "./client.ts";

export const taskUsage: Storage["taskUsage"] = {
  record: async function (input): Promise<void> {
    try {
      // Runs share rollups and the account audit head, so keep these writes queued.
      await adminMutation(internal.usage.recordTaskUsage, {
        accountId: input.accountId,
        endpointId: input.endpointId ?? "",
        agentId: input.agentId,
        principalChain: input.principalChain,
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
        inputPreview: input.inputPreview,
      });
    } catch (err) {
      logError("Usage write failed (convex)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

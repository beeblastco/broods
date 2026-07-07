/**
 * DynamoDB UsageStore implementation. Writes two items per finished task:
 *   - per-task row: PK=ACCOUNT#<accountId>, SK=TASK#<taskId>
 *   - rollup row:   PK=ACCOUNT#<accountId>, SK=ROLLUP#<agentId>#<provider>#<modelId>#<bucketStart>
 *     (5-minute buckets, counts folded with atomic ADD)
 *
 * coarser account+agent scope only — endpointId, project, and environment are
 * intentionally ignored (plan §8d: DynamoDB has no per-env scope). Both writes
 * are fire-and-forget; errors are caught and logged and never propagate into
 * the agent execution path.
 */

import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "./client.ts";
import { requireEnv } from "../../env.ts";
import { logError } from "../../log.ts";
import type { UsageStore, UsageTaskInput } from "../types.ts";

function usageTableName(): string {
  return requireEnv("USAGE_TABLE_NAME");
}

/** Bucket size in ms (5 minutes). */
const BUCKET_MS = 300_000;

function bucketStart(finishedAt: number): number {
  return Math.floor(finishedAt / BUCKET_MS) * BUCKET_MS;
}

export const dynamoUsageStore: UsageStore = {
  async recordTask(input: UsageTaskInput): Promise<void> {
    const table = usageTableName();
    const pk = `ACCOUNT#${input.accountId}`;
    const taskSk = `TASK#${input.taskId}`;
    const rollupSk = `ROLLUP#${input.agentId}#${input.modelProvider}#${input.modelId}#${bucketStart(input.finishedAt)}`;

    // Flatten sandbox CPU by role — the coarse DynamoDB rows keep the agent/tool
    // split but not per-type/per-tool detail (that lives in the Convex backend).
    let agentSandboxCpuUsec = 0;
    let toolSandboxCpuUsec = 0;
    for (const s of input.sandboxUsage) {
      if (s.role === "tool") {
        toolSandboxCpuUsec += s.cpuUsec;
      } else {
        agentSandboxCpuUsec += s.cpuUsec;
      }
    }

    // The conditional task insert and rollup increment must commit together.
    // Otherwise a retry can either double-count the rollup or leave it missing.
    try {
      await dynamo.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  pk: { S: pk },
                  sk: { S: taskSk },
                  agentId: { S: input.agentId },
                  conversationKey: { S: input.conversationKey },
                  taskId: { S: input.taskId },
                  modelProvider: { S: input.modelProvider },
                  modelId: { S: input.modelId },
                  finishedAt: { N: String(input.finishedAt) },
                  durationMs: { N: String(input.durationMs) },
                  status: { S: input.status },
                  inputTokens: { N: String(input.inputTokens) },
                  outputTokens: { N: String(input.outputTokens) },
                  reasoningTokens: { N: String(input.reasoningTokens) },
                  cachedInputTokens: { N: String(input.cachedInputTokens) },
                  cacheWriteTokens: { N: String(input.cacheWriteTokens) },
                  totalTokens: { N: String(input.totalTokens) },
                  runtimeKind: { S: input.runtimeKind },
                  runtimeWallMs: { N: String(input.runtimeWallMs) },
                  runtimeMemoryMb: { N: String(input.runtimeMemoryMb) },
                  agentSandboxCpuUsec: { N: String(agentSandboxCpuUsec) },
                  toolSandboxCpuUsec: { N: String(toolSandboxCpuUsec) },
                  stepCount: { N: String(input.stepCount) },
                  toolCallCount: { N: String(input.toolCallCount) },
                },
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: table,
                Key: {
                  pk: { S: pk },
                  sk: { S: rollupSk },
                },
                UpdateExpression:
                  "ADD inputTokens :inputTokens, outputTokens :outputTokens," +
                  " reasoningTokens :reasoningTokens, cachedInputTokens :cachedInputTokens," +
                  " cacheWriteTokens :cacheWriteTokens, totalTokens :totalTokens," +
                  " runtimeWallMs :runtimeWallMs, agentSandboxCpuUsec :agentSandboxCpuUsec," +
                  " toolSandboxCpuUsec :toolSandboxCpuUsec," +
                  " stepCount :stepCount, toolCallCount :toolCallCount, taskCount :one",
                ExpressionAttributeValues: {
                  ":inputTokens": { N: String(input.inputTokens) },
                  ":outputTokens": { N: String(input.outputTokens) },
                  ":reasoningTokens": { N: String(input.reasoningTokens) },
                  ":cachedInputTokens": { N: String(input.cachedInputTokens) },
                  ":cacheWriteTokens": { N: String(input.cacheWriteTokens) },
                  ":totalTokens": { N: String(input.totalTokens) },
                  ":runtimeWallMs": { N: String(input.runtimeWallMs) },
                  ":agentSandboxCpuUsec": { N: String(agentSandboxCpuUsec) },
                  ":toolSandboxCpuUsec": { N: String(toolSandboxCpuUsec) },
                  ":stepCount": { N: String(input.stepCount) },
                  ":toolCallCount": { N: String(input.toolCallCount) },
                  ":one": { N: "1" },
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const duplicate =
        err instanceof Error &&
        err.name === "TransactionCanceledException" &&
        "CancellationReasons" in err &&
        Array.isArray(err.CancellationReasons) &&
        err.CancellationReasons[0]?.Code === "ConditionalCheckFailed";
      if (!duplicate) {
        logError("Usage write failed (dynamo transaction)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
};

/** DynamoDB usage writes are account-scoped and atomically idempotent. */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";
import { dynamoUsageStore } from "../functions/_shared/storage/dynamo/usage.ts";
import type { UsageTaskInput } from "../functions/_shared/storage/types.ts";

const originalSend = dynamo.send;

afterEach(() => {
  dynamo.send = originalSend;
  delete process.env.USAGE_TABLE_NAME;
});

function usage(accountId: string): UsageTaskInput {
  return {
    accountId: accountId,
    agentId: "agent-1",
    conversationKey: "conversation-1",
    taskId: "shared-task-id",
    modelProvider: "openai",
    modelId: "gpt-5-mini",
    finishedAt: 1_800_000,
    durationMs: 250,
    status: "completed",
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: 5,
    cachedInputTokens: 20,
    cacheWriteTokens: 10,
    totalTokens: 150,
    runtimeKind: "lambda",
    runtimeWallMs: 250,
    runtimeMemoryMb: 1024,
    sandboxUsage: [],
    stepCount: 2,
    toolCallCount: 1,
  };
}

describe("dynamo usage store", () => {
  it("commits the task marker and rollup increment in one account-scoped transaction", async () => {
    process.env.USAGE_TABLE_NAME = "usage";
    const send = mock(async (_command: unknown) => ({}));
    dynamo.send = send as never;

    await dynamoUsageStore.recordTask(usage("account-a"));
    await dynamoUsageStore.recordTask(usage("account-b"));

    const first = send.mock.calls[0]?.[0] as TransactWriteItemsCommand;
    const second = send.mock.calls[1]?.[0] as TransactWriteItemsCommand;
    expect(first).toBeInstanceOf(TransactWriteItemsCommand);
    expect(first.input.TransactItems).toHaveLength(2);
    expect(first.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      pk: { S: "ACCOUNT#account-a" },
      sk: { S: "TASK#shared-task-id" },
    });
    expect(first.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    expect(first.input.TransactItems?.[1]?.Update?.Key?.sk?.S).toContain("ROLLUP#agent-1#openai#gpt-5-mini#");
    expect(second.input.TransactItems?.[0]?.Put?.Item?.pk).toEqual({
      S: "ACCOUNT#account-b",
    });
  });

  it("treats a duplicate task cancellation as a successful no-op", async () => {
    process.env.USAGE_TABLE_NAME = "usage";
    const duplicate = new Error("transaction cancelled") as Error & {
      CancellationReasons: Array<{ Code: string }>;
    };
    duplicate.name = "TransactionCanceledException";
    duplicate.CancellationReasons = [{ Code: "ConditionalCheckFailed" }, { Code: "None" }];
    dynamo.send = mock(async () => {
      throw duplicate;
    }) as never;

    await expect(dynamoUsageStore.recordTask(usage("account-a"))).resolves.toBeUndefined();
  });
});

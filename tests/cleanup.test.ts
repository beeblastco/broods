/**
 * Account cleanup tests.
 * Cover DynamoDB scan-and-delete batching, pagination, missing env vars, S3 namespace cleanup,
 * and error handling for destructive account teardown.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  BatchWriteItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { dynamo, toAttributeValue } from "../functions/_shared/storage/dynamo/client.ts";
import type { AccountRecord } from "../functions/_shared/storage/index.ts";
import { normalizeFilesystemNamespace } from "../functions/_shared/runtime-keys.ts";

let mockDeleteS3PrefixResult = 0;
let mockDeleteS3PrefixCalls: [string, string][] = [];

mock.module("../functions/_shared/s3.ts", () => ({
  deleteS3Prefix: mock(async (bucketName: string, prefix: string) => {
    mockDeleteS3PrefixCalls.push([bucketName, prefix]);
    return mockDeleteS3PrefixResult;
  }),
  readS3Text: mock(async () => ""),
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: mock(async () => 200),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  deleteS3Object: mock(async () => {}),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: mock(() => false),
}));

function resetS3MockState() {
  mockDeleteS3PrefixResult = 0;
  mockDeleteS3PrefixCalls = [];
}

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
  resetS3MockState();
});

const testAccount: AccountRecord = {
  accountId: "acct_test",
  username: "testuser",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

describe("deleteAccountRuntimeData", () => {
  it("returns zeroed summary when no table env vars are set", async () => {
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary).toEqual({
      conversationsDeleted: 0,
      processedEventsDeleted: 0,
      asyncAgentResultDeleted: 0,
      asyncToolResultDeleted: 0,
      filesystemObjectsDeleted: 0,
    });
  });

  it("deletes conversations across paginated scan results", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    let deleteScanPage = 0;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          const pages = [
            {
              Items: [
                conversationItem("acct_test:agent:agent_abc:api:conv1", "2026-05-01T00:00:00.000Z"),
                conversationItem("acct_test:agent:agent_abc:api:conv2", "2026-05-01T01:00:00.000Z"),
              ],
              LastEvaluatedKey: {
                conversationKey: { S: "acct_test:agent:agent_abc:api:conv2" },
                createdAt: { S: "2026-05-01T01:00:00.000Z" },
              },
            },
            {
              Items: [
                conversationItem("acct_test:agent:agent_abc:api:conv3", "2026-05-01T02:00:00.000Z"),
              ],
            },
          ];
          return pages[deleteScanPage++] ?? { Items: [] };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(3);

    const scanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand =>
        cmd instanceof ScanCommand &&
        cmd.input.TableName === "conversations" &&
        cmd.input.ProjectionExpression === "conversationKey, createdAt",
      );
    expect(scanCalls).toHaveLength(2);
    expect(scanCalls[1]?.input.ExclusiveStartKey).toEqual({
      conversationKey: { S: "acct_test:agent:agent_abc:api:conv2" },
      createdAt: { S: "2026-05-01T01:00:00.000Z" },
    });
  });

  it("deletes processed events with account-prefix filter", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "processed-events") {
          return {
            Items: [
              { eventId: { S: "acct_test:event1" }, conversationKey: { S: "acct_test:conv1" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.processedEventsDeleted).toBe(1);
  });

  it("deletes async agent results with account-prefix filter", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-results";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "async-agent-results") {
          return {
            Items: [
              { eventId: { S: "acct_test:async1" }, conversationKey: { S: "acct_test:conv1" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.asyncAgentResultDeleted).toBe(1);
  });

  it("cascades persistent subagent conversations, status rows, and filesystem namespaces", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-results";
    process.env.FILESYSTEM_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    mockDeleteS3PrefixResult = 1;
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    const parentConversationKey = "acct:acct_test:agent:agent_parent:api:parent";
    const childConversationKey = "acct:acct_test:agent:virtual_subagent_subagent_1:api:subagent-persistent-1";
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey") {
          return {
            Items: [
              { conversationKey: { S: parentConversationKey } },
              { conversationKey: { S: childConversationKey } },
            ],
          };
        }
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return {
            Items: [
              conversationItem(parentConversationKey, "2026-05-01T00:00:00.000Z"),
              conversationItem(childConversationKey, "2026-05-01T00:00:01.000Z"),
            ],
          };
        }
        if (command.input.TableName === "async-agent-results") {
          return {
            Items: [
              { eventId: { S: "acct:acct_test:agent:virtual_subagent_subagent_1:api:subagent_1" }, conversationKey: { S: childConversationKey } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(2);
    expect(summary.asyncAgentResultDeleted).toBe(1);
    expect(summary.filesystemObjectsDeleted).toBe(2);
    expect(mockDeleteS3PrefixCalls).toContainEqual([
      "test-bucket",
      `${normalizeFilesystemNamespace(`acct_test:virtual_subagent_subagent_1:${childConversationKey}`)}/`,
    ]);
  });

  it("deletes async tool results with parent-event and conversation filters", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "async-tool-results") {
          return {
            Items: [
              { resultId: { S: "result1" }, parentEventId: { S: "acct_test:event1" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.asyncToolResultDeleted).toBe(1);
  });

  it("flushes remaining items when scan ends with partial batch", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return {
            Items: [
              conversationItem("acct_test:agent:agent_abc:api:conv1", "2026-05-01T00:00:00.000Z"),
              conversationItem("acct_test:agent:agent_abc:api:conv2", "2026-05-01T01:00:00.000Z"),
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(2);

    const batchCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is BatchWriteItemCommand => cmd instanceof BatchWriteItemCommand);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.input.RequestItems?.["conversations"]).toHaveLength(2);
  });

  it("handles unprocessed items by retrying in flushBatchDeletes", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    let batchCallCount = 0;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return {
            Items: [
              conversationItem("acct_test:agent:agent_abc:api:conv1", "2026-05-01T00:00:00.000Z"),
              conversationItem("acct_test:agent:agent_abc:api:conv2", "2026-05-01T01:00:00.000Z"),
              conversationItem("acct_test:agent:agent_abc:api:conv3", "2026-05-01T02:00:00.000Z"),
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        batchCallCount++;
        if (batchCallCount === 1) {
          return {
            UnprocessedItems: {
              conversations: [
                { DeleteRequest: { Key: { conversationKey: { S: "acct_test:agent:agent_abc:api:conv2" }, createdAt: { S: "2026-05-01T01:00:00.000Z" } } } },
                { DeleteRequest: { Key: { conversationKey: { S: "acct_test:agent:agent_abc:api:conv3" }, createdAt: { S: "2026-05-01T02:00:00.000Z" } } } },
              ],
            },
          };
        }
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(3);
    expect(batchCallCount).toBe(2);
  });

  it("skips items with missing key attributes in projectKey", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return {
            Items: [
              { conversationKey: { S: "acct_test:agent:agent_abc:api:conv1" }, createdAt: { S: "2026-05-01T00:00:00.000Z" } },
              { conversationKey: { S: "acct_test:agent:agent_abc:api:conv2" } },
              { createdAt: { S: "2026-05-01T01:00:00.000Z" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(1);

    const batchCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is BatchWriteItemCommand => cmd instanceof BatchWriteItemCommand);
    expect(batchCalls[0]?.input.RequestItems?.["conversations"]).toHaveLength(1);
  });

  it("deletes filesystem objects for agent namespaces and conversation keys", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.FILESYSTEM_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    dynamo.send = sendMock as never;

    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations") {
          return {
            Items: [
              { conversationKey: { S: "acct_test:agent:agent_abc:api:conv1" }, createdAt: { S: "2026-05-01T00:00:00.000Z" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(1);
  });

  it("returns zero filesystem deletions when bucket env var is missing", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;

    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.filesystemObjectsDeleted).toBe(0);
  });

  it("resolves filesystem namespaces from agent workspace config", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = "test-secret-32-bytes-long!!";
    dynamo.send = sendMock as never;

    const { encryptAgentConfig } = await import("../functions/_shared/storage/index.ts");
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    const encryptedConfig = toAttributeValue(encryptAgentConfig({
      workspace: {
        memory: {
          namespace: "support-memory",
        },
      },
    }));

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        return {
          Items: [
            {
              accountId: { S: "acct_test" },
              agentId: { S: "agent_abc123" },
              name: { S: "test-agent" },
              status: { S: "active" },
              config: encryptedConfig,
              createdAt: { S: "2026-05-01T00:00:00.000Z" },
              updatedAt: { S: "2026-05-01T00:00:00.000Z" },
            },
          ],
        };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.filesystemObjectsDeleted).toBe(0);
  });

  it("handles listAgents failure gracefully by defaulting to empty array", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        throw new Error("DynamoDB unavailable");
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(0);
    expect(summary.filesystemObjectsDeleted).toBe(0);
  });

  it("skips conversations that do not start with account prefix in namespace resolution", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.FILESYSTEM_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    dynamo.send = sendMock as never;

    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations") {
          return {
            Items: [
              { conversationKey: { S: "acct_test:agent:agent_abc:api:conv1" }, createdAt: { S: "2026-05-01T00:00:00.000Z" } },
              { conversationKey: { S: "acct_other:agent:agent_xyz:api:conv2" }, createdAt: { S: "2026-05-01T01:00:00.000Z" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(2);
  });

  it("handles conversations without agent match in namespace resolution", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.FILESYSTEM_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIGS_TABLE_NAME = "agent-configs";
    dynamo.send = sendMock as never;

    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations") {
          return {
            Items: [
              { conversationKey: { S: "acct_test:some-other-key" }, createdAt: { S: "2026-05-01T00:00:00.000Z" } },
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(1);
  });

  it("handles empty scan results without errors", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-results";
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary).toEqual({
      conversationsDeleted: 0,
      processedEventsDeleted: 0,
      asyncAgentResultDeleted: 0,
      asyncToolResultDeleted: 0,
      filesystemObjectsDeleted: 0,
    });
  });

  it("uses correct filter expression for conversations delete scan", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAccountRuntimeData(testAccount);

    const deleteScanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand =>
        cmd instanceof ScanCommand &&
        cmd.input.TableName === "conversations" &&
        cmd.input.ProjectionExpression === "conversationKey, createdAt",
      );

    expect(deleteScanCalls.length).toBe(1);
    expect(deleteScanCalls[0]?.input.FilterExpression).toBe("begins_with(conversationKey, :accountPrefix)");
  });

  it("uses correct projection for conversation reference scan", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAccountRuntimeData(testAccount);

    const refScanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand =>
        cmd instanceof ScanCommand &&
        cmd.input.TableName === "conversations" &&
        cmd.input.ProjectionExpression === "conversationKey",
      );

    expect(refScanCalls.length).toBe(1);
    expect(refScanCalls[0]?.input.FilterExpression).toBe("begins_with(conversationKey, :accountPrefix)");
  });

  it("uses correct filter expression for processed events table", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAccountRuntimeData(testAccount);

    const scanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand => cmd instanceof ScanCommand && cmd.input.TableName === "processed-events");

    expect(scanCalls.length).toBe(1);
    expect(scanCalls[0]?.input.FilterExpression).toBe("begins_with(eventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)");
    expect(scanCalls[0]?.input.ProjectionExpression).toBe("eventId");
  });

  it("uses correct filter expression for async agent result table", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-results";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAccountRuntimeData(testAccount);

    const scanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand => cmd instanceof ScanCommand && cmd.input.TableName === "async-agent-results");

    expect(scanCalls.length).toBe(1);
    expect(scanCalls[0]?.input.FilterExpression).toBe("begins_with(eventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)");
    expect(scanCalls[0]?.input.ProjectionExpression).toBe("eventId");
  });

  it("uses correct filter expression for async tool result table", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAccountRuntimeData(testAccount);

    const scanCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is ScanCommand => cmd instanceof ScanCommand && cmd.input.TableName === "async-tool-results");

    expect(scanCalls.length).toBe(1);
    expect(scanCalls[0]?.input.FilterExpression).toBe("begins_with(parentEventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)");
    expect(scanCalls[0]?.input.ProjectionExpression).toBe("resultId");
  });

  it("batches deletes at the DynamoDB limit of 25 items", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    const items = Array.from({ length: 30 }, (_, i) =>
      conversationItem(`acct_test:agent:agent_abc:api:conv${i}`, `2026-05-01T00:00:${i < 10 ? "0" : ""}${i}.000Z`),
    );

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return { Items: items };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(30);

    const batchCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is BatchWriteItemCommand => cmd instanceof BatchWriteItemCommand);

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]?.input.RequestItems?.["conversations"]).toHaveLength(25);
    expect(batchCalls[1]?.input.RequestItems?.["conversations"]).toHaveLength(5);
  });

  it("counts deleted items correctly when unprocessed items are returned", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    let callCount = 0;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === "conversations" && command.input.ProjectionExpression === "conversationKey, createdAt") {
          return {
            Items: [
              conversationItem("acct_test:agent:agent_abc:api:conv1", "2026-05-01T00:00:00.000Z"),
              conversationItem("acct_test:agent:agent_abc:api:conv2", "2026-05-01T01:00:00.000Z"),
              conversationItem("acct_test:agent:agent_abc:api:conv3", "2026-05-01T02:00:00.000Z"),
            ],
          };
        }
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        callCount++;
        if (callCount === 1) {
          return {
            UnprocessedItems: {
              conversations: [
                { DeleteRequest: { Key: { conversationKey: { S: "acct_test:agent:agent_abc:api:conv3" }, createdAt: { S: "2026-05-01T02:00:00.000Z" } } } },
              ],
            },
          };
        }
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(3);
  });

  it("returns zero when conversations table env var is not set", async () => {
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.conversationsDeleted).toBe(0);
  });

  it("returns zero when processed events table env var is not set", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.processedEventsDeleted).toBe(0);
  });

  it("returns zero when async agent result table env var is not set", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.asyncAgentResultDeleted).toBe(0);
  });

  it("returns zero when async tool result table env var is not set", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    dynamo.send = sendMock as never;
    const { deleteAccountRuntimeData } = await import("../functions/account-manage/cleanup.ts");

    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ScanCommand) {
        return { Items: [] };
      }
      if (command instanceof BatchWriteItemCommand) {
        return {};
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const summary = await deleteAccountRuntimeData(testAccount);

    expect(summary.asyncToolResultDeleted).toBe(0);
  });
});

function conversationItem(conversationKey: string, createdAt: string): Record<string, AttributeValue> {
  return {
    conversationKey: { S: conversationKey },
    createdAt: { S: createdAt },
  };
}

/**
 * Async result persistence tests.
 * Cover subagent and tool result rows without running the harness.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamo, toAttributeValue } from "../functions/_shared/dynamo.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("async agent result persistence", () => {
  it("stores tool approval summaries for awaiting approval results", async () => {
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-result";
    dynamo.send = sendMock as never;
    const { markAsyncAgentResultAwaitingApproval } = await import("../functions/harness-processing/async-agent-result.ts");

    await markAsyncAgentResultAwaitingApproval({
      eventId: "event-1",
      approvals: [{
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        toolName: "filesystem",
        input: { shell: "rm file.txt" },
      }],
    });

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateItemCommand);
    if (!(command instanceof UpdateItemCommand)) {
      throw new Error("Expected UpdateItemCommand");
    }

    expect(command.input.TableName).toBe("async-agent-result");
    expect(command.input.ExpressionAttributeValues?.[":status"]).toEqual({ S: "awaiting_approval" });
    expect(command.input.ExpressionAttributeValues?.[":approvals"]).toEqual({
      L: [{
        M: {
          approvalId: { S: "approval-1" },
          toolCallId: { S: "tool-call-1" },
          toolName: { S: "filesystem" },
          input: {
            M: {
              shell: { S: "rm file.txt" },
            },
          },
        },
      }],
    });
  });

  it("decodes awaiting approval status records", async () => {
    process.env.ASYNC_AGENT_RESULT_TABLE_NAME = "async-agent-result";
    dynamo.send = sendMock as never;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        return {
          Item: {
            eventId: { S: "event-1" },
            conversationKey: { S: "conversation-1" },
            status: { S: "awaiting_approval" },
            createdAt: { S: "2026-05-10T00:00:00.000Z" },
            updatedAt: { S: "2026-05-10T00:00:01.000Z" },
            expiresAt: { N: "1770000000" },
            approvals: toAttributeValue([{
              approvalId: "approval-1",
              toolCallId: "tool-call-1",
              toolName: "filesystem",
              input: { shell: "rm file.txt" },
            }]),
          },
        };
      }
      throw new Error("unexpected command");
    });
    const { getAsyncAgentResult } = await import("../functions/harness-processing/async-agent-result.ts");

    await expect(getAsyncAgentResult("event-1")).resolves.toEqual({
      eventId: "event-1",
      conversationKey: "conversation-1",
      status: "awaiting_approval",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:01.000Z",
      expiresAt: 1770000000,
      response: undefined,
      error: undefined,
      approvals: [{
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        toolName: "filesystem",
        input: { shell: "rm file.txt" },
      }],
    });
  });
});

describe("async tool result persistence", () => {
  it("stores pending async tool result rows with structured input", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    const { createPendingAsyncToolResult } = await import("../functions/harness-processing/async-tool-result.ts");

    await createPendingAsyncToolResult({
      resultId: "result-1",
      parentEventId: "event-1",
      conversationKey: "conversation-1",
      toolName: "slowLookup",
      toolCallId: "tool-call-1",
      input: { query: "alpha" },
    });

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutItemCommand);
    if (!(command instanceof PutItemCommand)) {
      throw new Error("Expected PutItemCommand");
    }

    expect(command.input.TableName).toBe("async-tool-result");
    expect(command.input.Item?.status).toEqual({ S: "processing" });
    expect(command.input.Item?.input).toEqual({
      M: {
        query: { S: "alpha" },
      },
    });
  });

  it("stores NATS delivery metadata on external async tool rows", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    const { createPendingAsyncToolResult } = await import("../functions/harness-processing/async-tool-result.ts");

    await createPendingAsyncToolResult({
      resultId: "result-1",
      parentEventId: "event-1",
      conversationKey: "conversation-1",
      toolName: "slowLookup",
      toolCallId: "tool-call-1",
      input: { query: "alpha" },
      delivery: {
        kind: "nats",
        connectionId: "connection-1",
        publicEventId: "event-public-1",
        publicConversationKey: "conversation-public-1",
      },
    });

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutItemCommand);
    if (!(command instanceof PutItemCommand)) {
      throw new Error("Expected PutItemCommand");
    }

    expect(command.input.Item?.delivery).toEqual({
      M: {
        kind: { S: "nats" },
        connectionId: { S: "connection-1" },
        publicEventId: { S: "event-public-1" },
        publicConversationKey: { S: "conversation-public-1" },
      },
    });
    const groupCommand = sendMock.mock.calls.find(([sentCommand]) =>
      sentCommand instanceof UpdateItemCommand &&
      sentCommand.input.ExpressionAttributeValues?.[":itemType"]?.S === "external-dispatch-group"
    )?.[0];
    expect(groupCommand).toBeInstanceOf(UpdateItemCommand);
  });

  it("seals external async tool dispatch groups", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return {
          Attributes: {
            resultId: { S: "event-1:async-tool-dispatch-group" },
            parentEventId: { S: "event-1" },
            resultIds: { SS: ["result-2", "result-1"] },
            sealed: { BOOL: true },
            updatedAt: { S: "2026-05-10T00:00:01.000Z" },
            expiresAt: { N: "1770000000" },
          },
        };
      }
      throw new Error("unexpected command");
    });
    const { sealExternalAsyncToolDispatchGroup } = await import("../functions/harness-processing/async-tool-result.ts");

    await expect(sealExternalAsyncToolDispatchGroup("event-1")).resolves.toEqual({
      parentEventId: "event-1",
      resultIds: ["result-1", "result-2"],
      sealed: true,
    });

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateItemCommand);
    if (!(command instanceof UpdateItemCommand)) {
      throw new Error("Expected UpdateItemCommand");
    }
    expect(command.input.ExpressionAttributeValues?.[":sealed"]).toEqual({ BOOL: true });
  });

  it("lists async tool results by parent event", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [{
            resultId: { S: "result-1" },
            parentEventId: { S: "event-1" },
            conversationKey: { S: "conversation-1" },
            toolName: { S: "slowLookup" },
            toolCallId: { S: "tool-call-1" },
            input: toAttributeValue({ query: "alpha" }),
            status: { S: "processing" },
            createdAt: { S: "2026-05-10T00:00:00.000Z" },
            updatedAt: { S: "2026-05-10T00:00:01.000Z" },
            expiresAt: { N: "1770000000" },
          }],
        };
      }
      throw new Error("unexpected command");
    });
    const { listAsyncToolResultsByParentEvent } = await import("../functions/harness-processing/async-tool-result.ts");

    await expect(listAsyncToolResultsByParentEvent("event-1")).resolves.toMatchObject([{
      resultId: "result-1",
      parentEventId: "event-1",
      status: "processing",
    }]);

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(QueryCommand);
    if (!(command instanceof QueryCommand)) {
      throw new Error("Expected QueryCommand");
    }
    expect(command.input.IndexName).toBe("ParentEventIdIndex");
    expect(command.input.KeyConditionExpression).toBe("parentEventId = :parentEventId");
  });

  it("decodes completed async tool result rows", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        return {
          Item: {
            resultId: { S: "result-1" },
            parentEventId: { S: "event-1" },
            conversationKey: { S: "conversation-1" },
            toolName: { S: "slowLookup" },
            toolCallId: { S: "tool-call-1" },
            input: toAttributeValue({ query: "alpha" }),
            status: { S: "completed" },
            createdAt: { S: "2026-05-10T00:00:00.000Z" },
            updatedAt: { S: "2026-05-10T00:00:01.000Z" },
            expiresAt: { N: "1770000000" },
            response: toAttributeValue({ answer: "done" }),
          },
        };
      }
      throw new Error("unexpected command");
    });
    const { getAsyncToolResult } = await import("../functions/harness-processing/async-tool-result.ts");

    await expect(getAsyncToolResult("result-1")).resolves.toEqual({
      resultId: "result-1",
      parentEventId: "event-1",
      conversationKey: "conversation-1",
      toolName: "slowLookup",
      toolCallId: "tool-call-1",
      input: { query: "alpha" },
      status: "completed",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:01.000Z",
      expiresAt: 1770000000,
      response: { answer: "done" },
      error: undefined,
    });
  });

  it("settles external async tool results only while processing", async () => {
    process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";
    dynamo.send = sendMock as never;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return {
          Attributes: {
            resultId: { S: "result-1" },
            parentEventId: { S: "event-1" },
            conversationKey: { S: "conversation-1" },
            toolName: { S: "slowLookup" },
            toolCallId: { S: "tool-call-1" },
            input: toAttributeValue({ query: "alpha" }),
            status: { S: "completed" },
            createdAt: { S: "2026-05-10T00:00:00.000Z" },
            updatedAt: { S: "2026-05-10T00:00:01.000Z" },
            expiresAt: { N: "1770000000" },
            response: toAttributeValue({ answer: "done" }),
          },
        };
      }
      throw new Error("unexpected command");
    });
    const { settleExternalAsyncToolResult } = await import("../functions/harness-processing/async-tool-result.ts");

    await expect(settleExternalAsyncToolResult({
      resultId: "result-1",
      status: "completed",
      response: { answer: "done" },
    })).resolves.toMatchObject({
      resultId: "result-1",
      status: "completed",
      response: { answer: "done" },
    });

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateItemCommand);
    if (!(command instanceof UpdateItemCommand)) {
      throw new Error("Expected UpdateItemCommand");
    }
    expect(command.input.ConditionExpression).toBe("#status = :processing");
    expect(command.input.ReturnValues).toBe("ALL_NEW");
  });
});

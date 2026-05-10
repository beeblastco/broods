/**
 * Async status persistence tests.
 * Cover approval-pending status without running the harness.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamo, toAttributeValue } from "../functions/_shared/dynamo.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("async status persistence", () => {
  it("stores tool approval summaries for awaiting approval results", async () => {
    process.env.ASYNC_RESULTS_TABLE_NAME = "async-results";
    dynamo.send = sendMock as never;
    const { markAsyncResultAwaitingApproval } = await import("../functions/harness-processing/status.ts");

    await markAsyncResultAwaitingApproval({
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

    expect(command.input.TableName).toBe("async-results");
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
    process.env.ASYNC_RESULTS_TABLE_NAME = "async-results";
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
    const { getAsyncResult } = await import("../functions/harness-processing/status.ts");

    await expect(getAsyncResult("event-1")).resolves.toEqual({
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

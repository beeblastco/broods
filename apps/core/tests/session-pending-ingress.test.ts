/**
 * Session pending-ingress queue tests.
 * Cover buffering channel messages that arrive mid-turn (enqueue) and the atomic
 * drain (take) so a busy conversation answers follow-ups in order instead of
 * dropping them.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  DeleteItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { UserModelMessage } from "ai";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}) as Record<string, unknown>);

process.env.CONVERSATIONS_TABLE_NAME = "conversations";
process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
process.env.FILESYSTEM_BUCKET_NAME = "filesystem";

const { Session } = await import("../functions/harness-processing/session.ts");

function newSession() {
  return new Session("event-1", "tg:123", "acct", "agent");
}

beforeEach(() => {
  dynamo.send = sendMock as never;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("Session pending ingress queue", () => {
  it("enqueues messages with an atomic JSON list_append under a per-conversation key", async () => {
    const session = newSession();
    const message: UserModelMessage = { role: "user", content: "second message" };

    await session.enqueuePendingIngress([message]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    // One pending item per conversation, namespaced off the (hashed) lease key.
    expect(command.input.Key?.eventId?.S).toStartWith("pending:conversation-lease:");
    // list_append keeps concurrent enqueues from clobbering each other.
    expect(command.input.UpdateExpression).toContain("list_append");
    expect(command.input.UpdateExpression).toContain("if_not_exists(queued");
    const queued = command.input.ExpressionAttributeValues?.[":events"]?.L ?? [];
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.S!)).toEqual(message);
  });

  it("does not touch DynamoDB when there is nothing to enqueue", async () => {
    const session = newSession();

    await session.enqueuePendingIngress([]);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("drains and clears the buffer in one delete, decoding the queued events", async () => {
    const session = newSession();
    const first: UserModelMessage = { role: "user", content: "first" };
    const second: UserModelMessage = { role: "user", content: "second" };
    sendMock.mockImplementation(async () => ({
      Attributes: {
        queued: { L: [{ S: JSON.stringify(first) }, { S: JSON.stringify(second) }] },
      },
    }));

    const drained = await session.takePendingIngress();

    const command = sendMock.mock.calls[0]![0] as DeleteItemCommand;
    expect(command).toBeInstanceOf(DeleteItemCommand);
    // ALL_OLD makes the read-and-clear a single atomic op.
    expect(command.input.ReturnValues).toBe("ALL_OLD");
    expect(drained).toEqual([first, second]);
  });

  it("returns an empty list when the buffer is absent", async () => {
    const session = newSession();
    sendMock.mockImplementation(async () => ({}));

    const drained = await session.takePendingIngress();

    expect(drained).toEqual([]);
  });

  it("skips a malformed buffered entry rather than failing the whole drain", async () => {
    const session = newSession();
    const valid: UserModelMessage = { role: "user", content: "ok" };
    sendMock.mockImplementation(async () => ({
      Attributes: {
        queued: { L: [{ S: "{not json" }, { S: JSON.stringify(valid) }] },
      },
    }));

    const drained = await session.takePendingIngress();

    expect(drained).toEqual([valid]);
  });
});

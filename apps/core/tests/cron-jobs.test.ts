/**
 * Cron job persistence tests.
 * Cover account-owned scheduled agent records without AWS Scheduler calls.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("cron job persistence", () => {
  it("creates account-scoped cron job records", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    dynamo.send = sendMock as never;
    const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();

    const cron = await getStorage().crons.create("acct_test", {
      name: "Daily maintainer",
      agentId: "agent_main",
      input: "Run maintenance.",
      conversationKey: "cron:daily-maintenance",
      scheduleExpression: "cron(0 8 * * ? *)",
      timezone: "Europe/Amsterdam",
    }, {
      schedulerGroupName: "dev-filthy-panty-cron",
    });

    expect(cron.accountId).toBe("acct_test");
    expect(cron.agentId).toBe("agent_main");
    expect(cron.events).toEqual([{ role: "user", content: [{ type: "text", text: "Run maintenance." }] }]);
    expect(cron.status).toBe("active");
    expect(cron.schedulerName.startsWith("acct_test-cron_")).toBe(true);

    const putCommand = sendMock.mock.calls[0]?.[0];
    expect(putCommand).toBeInstanceOf(PutItemCommand);
    expect((putCommand as PutItemCommand).input.TableName).toBe("crons");
    expect((putCommand as PutItemCommand).input.Item?.agentId).toEqual({ S: "agent_main" });
    expect((putCommand as PutItemCommand).input.Item?.events).toEqual({
      S: JSON.stringify([{ role: "user", content: [{ type: "text", text: "Run maintenance." }] }]),
    });
  });

  it("lists cron jobs by account", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    dynamo.send = sendMock as never;
    const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [cronItem("acct_test", "cron_one")],
        };
      }
      throw new Error("unexpected command");
    });

    const jobs = await getStorage().crons.list("acct_test");

    expect(jobs.map((job) => job.cronId)).toEqual(["cron_one"]);
    const queryCommand = sendMock.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCommand.input.KeyConditionExpression).toBe("accountId = :accountId");
    expect(queryCommand.input.ExpressionAttributeValues?.[":accountId"]).toEqual({ S: "acct_test" });
  });

  it("updates and deletes cron jobs", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    dynamo.send = sendMock as never;
    const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return {
          Attributes: {
            ...cronItem("acct_test", "cron_one"),
            status: { S: "paused" },
          },
        };
      }
      if (command instanceof DeleteItemCommand) {
        return {};
      }
      throw new Error("unexpected command");
    });

    const updated = await getStorage().crons.update("acct_test", "cron_one", { status: "paused" });
    const deleted = await getStorage().crons.remove("acct_test", "cron_one");

    expect(updated?.status).toBe("paused");
    expect(deleted).toBe(true);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(UpdateItemCommand);
    expect(sendMock.mock.calls[1]?.[0]).toBeInstanceOf(DeleteItemCommand);
  });

  it("loads one cron job by account and id", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    dynamo.send = sendMock as never;
    const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        return { Item: cronItem("acct_test", "cron_one") };
      }
      throw new Error("unexpected command");
    });

    const job = await getStorage().crons.getById("acct_test", "cron_one");

    expect(job?.cronId).toBe("cron_one");
    expect(job?.agentId).toBe("agent_main");
    expect(job?.events).toEqual([{ role: "user", content: [{ type: "text", text: "Run." }] }]);
  });

  it("records and lists cron job run history", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    dynamo.send = sendMock as never;
    const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
    resetStorageForTests();
    let runItem: Record<string, AttributeValue> | undefined;
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof PutItemCommand) {
        runItem = command.input.Item as Record<string, AttributeValue>;
        return {};
      }
      if (command instanceof QueryCommand) {
        return { Items: runItem ? [runItem] : [] };
      }
      throw new Error("unexpected command");
    });

    const run = await getStorage().crons.createRun({
      accountId: "acct_test",
      cronId: "cron_one",
      eventId: "cron_one-event",
      conversationKey: "cron:daily-maintenance",
    });
    const runs = await getStorage().crons.listRuns("acct_test", "cron_one", 5);

    expect(run.status).toBe("started");
    expect(runs[0]?.eventId).toBe("cron_one-event");
    expect(runs[0]?.conversationKey).toBe("cron:daily-maintenance");
    const queryCommand = sendMock.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCommand.input.KeyConditionExpression).toBe("accountId = :accountId AND begins_with(cronId, :prefix)");
    expect(queryCommand.input.ExpressionAttributeValues?.[":prefix"]).toEqual({ S: "run#cron_one#" });
  });
});

function cronItem(accountId: string, cronId: string): Record<string, AttributeValue> {
  return {
    accountId: { S: accountId },
    cronId: { S: cronId },
    name: { S: "Daily maintainer" },
    agentId: { S: "agent_main" },
    events: { S: JSON.stringify([{ role: "user", content: [{ type: "text", text: "Run." }] }]) },
    conversationKey: { S: "cron:daily-maintenance" },
    scheduleExpression: { S: "cron(0 8 * * ? *)" },
    timezone: { S: "Europe/Amsterdam" },
    status: { S: "active" },
    schedulerName: { S: `${accountId}-${cronId}` },
    schedulerGroupName: { S: "dev-filthy-panty-cron" },
    createdAt: { S: "2026-05-22T00:00:00.000Z" },
    updatedAt: { S: "2026-05-22T00:00:00.000Z" },
  };
}

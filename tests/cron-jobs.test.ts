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
import { dynamo } from "../functions/_shared/dynamo.ts";

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
    process.env.CRON_JOBS_TABLE_NAME = "cron-jobs";
    dynamo.send = sendMock as never;
    const { createCronJob } = await import("../functions/_shared/cron-jobs.ts");

    const cronJob = await createCronJob("acct_test", {
      name: "Daily maintainer",
      agentId: "agent_main",
      prompt: "Run maintenance.",
      conversationKey: "cron:daily-maintenance",
      scheduleExpression: "cron(0 8 * * ? *)",
      timezone: "Europe/Amsterdam",
    }, {
      schedulerGroupName: "dev-filthy-panty-cron",
    });

    expect(cronJob.accountId).toBe("acct_test");
    expect(cronJob.agentId).toBe("agent_main");
    expect(cronJob.prompt).toBe("Run maintenance.");
    expect(cronJob.status).toBe("active");
    expect(cronJob.schedulerName.startsWith("acct_test-cron_")).toBe(true);

    const putCommand = sendMock.mock.calls[0]?.[0];
    expect(putCommand).toBeInstanceOf(PutItemCommand);
    expect((putCommand as PutItemCommand).input.TableName).toBe("cron-jobs");
    expect((putCommand as PutItemCommand).input.Item?.agentId).toEqual({ S: "agent_main" });
    expect((putCommand as PutItemCommand).input.Item?.prompt).toEqual({ S: "Run maintenance." });
  });

  it("lists cron jobs by account", async () => {
    process.env.CRON_JOBS_TABLE_NAME = "cron-jobs";
    dynamo.send = sendMock as never;
    const { listCronJobs } = await import("../functions/_shared/cron-jobs.ts");
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [cronJobItem("acct_test", "cron_one")],
        };
      }
      throw new Error("unexpected command");
    });

    const jobs = await listCronJobs("acct_test");

    expect(jobs.map((job) => job.cronJobId)).toEqual(["cron_one"]);
    const queryCommand = sendMock.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCommand.input.KeyConditionExpression).toBe("accountId = :accountId");
    expect(queryCommand.input.ExpressionAttributeValues?.[":accountId"]).toEqual({ S: "acct_test" });
  });

  it("updates and deletes cron jobs", async () => {
    process.env.CRON_JOBS_TABLE_NAME = "cron-jobs";
    dynamo.send = sendMock as never;
    const { deleteCronJob, updateCronJob } = await import("../functions/_shared/cron-jobs.ts");
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return {
          Attributes: {
            ...cronJobItem("acct_test", "cron_one"),
            status: { S: "paused" },
          },
        };
      }
      if (command instanceof DeleteItemCommand) {
        return {};
      }
      throw new Error("unexpected command");
    });

    const updated = await updateCronJob("acct_test", "cron_one", { status: "paused" });
    const deleted = await deleteCronJob("acct_test", "cron_one");

    expect(updated?.status).toBe("paused");
    expect(deleted).toBe(true);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(UpdateItemCommand);
    expect(sendMock.mock.calls[1]?.[0]).toBeInstanceOf(DeleteItemCommand);
  });

  it("loads one cron job by account and id", async () => {
    process.env.CRON_JOBS_TABLE_NAME = "cron-jobs";
    dynamo.send = sendMock as never;
    const { getCronJob } = await import("../functions/_shared/cron-jobs.ts");
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        return { Item: cronJobItem("acct_test", "cron_one") };
      }
      throw new Error("unexpected command");
    });

    const job = await getCronJob("acct_test", "cron_one");

    expect(job?.cronJobId).toBe("cron_one");
    expect(job?.agentId).toBe("agent_main");
    expect(job?.prompt).toBe("Run.");
  });
});

function cronJobItem(accountId: string, cronJobId: string): Record<string, AttributeValue> {
  return {
    accountId: { S: accountId },
    cronJobId: { S: cronJobId },
    name: { S: "Daily maintainer" },
    agentId: { S: "agent_main" },
    prompt: { S: "Run." },
    conversationKey: { S: "cron:daily-maintenance" },
    scheduleExpression: { S: "cron(0 8 * * ? *)" },
    timezone: { S: "Europe/Amsterdam" },
    status: { S: "active" },
    schedulerName: { S: `${accountId}-${cronJobId}` },
    schedulerGroupName: { S: "dev-filthy-panty-cron" },
    createdAt: { S: "2026-05-22T00:00:00.000Z" },
    updatedAt: { S: "2026-05-22T00:00:00.000Z" },
  };
}

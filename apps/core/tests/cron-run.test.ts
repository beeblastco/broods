/**
 * Scheduled cron invocation tests.
 * Cover which conversation a cron run resumes and where its answer is delivered.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelMessage } from "ai";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { CronRecord, CronRunRecord } from "../src/shared/domain/cron.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";

const { handler } = await import("../src/harness/handler.ts");

const AGENT: AgentRecord = {
  accountId: "acct_1",
  agentId: "agent_1",
  name: "scheduler",
  status: "active",
  config: { model: { provider: "openai", modelId: "gpt-5.5" } },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const CHANNEL_TARGET = {
  agentConfig: { channels: { slack: {} } },
  channelName: "slack",
  source: { teamId: "T1", channelId: "C1" },
};

const originalQuery = runtime.query;
const originalMutate = runtime.mutate;

let channelTarget: typeof CHANNEL_TARGET | null;
let conversationKey: string | undefined;
let scheduleExpression: string;
let admitted: Record<string, unknown>[];
let failures: string[];
let removed: string[];

beforeEach(() => {
  channelTarget = null;
  conversationKey = undefined;
  scheduleExpression = "cron(0 9 * * ? *)";
  admitted = [];
  failures = [];
  removed = [];
  setStorageForTests({
    agents: {
      getById: async function (accountId: string, agentId: string) {
        return accountId === AGENT.accountId && agentId === AGENT.agentId
          ? AGENT
          : null;
      },
    },
    agentDeployments: {
      getByAgentId: async function () {
        return null;
      },
    },
    crons: {
      getById: async function (): Promise<CronRecord> {
        return cron();
      },
      markStarted: async function (): Promise<void> {},
      markFailed: async function (): Promise<void> {},
      createRun: async function (): Promise<CronRunRecord> {
        return {
          accountId: "acct_1",
          cronId: "cron_1",
          runId: "run_1",
          eventId: "evt_1",
          conversationKey: conversationKey ?? "",
          status: "started",
          startedAt: "2026-08-14T09:00:00.000Z",
        };
      },
      failRun: async function (
        _accountId: string,
        _cronId: string,
        _runId: string,
        error: string,
      ): Promise<void> {
        failures.push(error);
      },
      remove: async function (
        _accountId: string,
        cronId: string,
      ): Promise<boolean> {
        removed.push(cronId);

        return true;
      },
    },
  } as unknown as Storage);
  runtime.query = async function (name: string) {
    return name === "getConversationTarget" ? channelTarget : null;
  } as never;
  // Admitting as "queued" stops before the async worker: the envelope the cron
  // hands to the coordinator is what these tests assert.
  runtime.mutate = async function (name: string, args: unknown) {
    if (name === "acceptIngress") {
      admitted.push(args as Record<string, unknown>);
    }

    return { outcome: "queued" };
  } as never;
});

afterEach(() => {
  resetStorageForTests();
  runtime.query = originalQuery;
  runtime.mutate = originalMutate;
});

describe("handleScheduledCron", () => {
  it("resumes the channel session named by the cron and replies there", async () => {
    channelTarget = CHANNEL_TARGET;
    conversationKey = "slack:T1:C1";

    await expect(invokeCron()).rejects.toThrow(
      "Cron conversation is already processing another turn",
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.conversationKey).toBe(
      "acct:acct_1:agent:agent_1:slack:T1:C1",
    );
    expect(admitted[0]?.delivery).toEqual({
      kind: "channel",
      channel: "slack",
      source: CHANNEL_TARGET.source,
    });
    expect(admitted[0]?.agentConfig).toEqual(CHANNEL_TARGET.agentConfig);
    expect(failures).toEqual([
      "Cron conversation is already processing another turn",
    ]);
  });

  it("keeps a cron with no live session on its own direct conversation", async () => {
    conversationKey = "nightly-maintenance";

    await expect(invokeCron()).rejects.toThrow(
      "Cron conversation is already processing another turn",
    );
    expect(admitted[0]?.conversationKey).toBe(
      "acct:acct_1:agent:agent_1:api:nightly-maintenance",
    );
    expect(admitted[0]?.delivery).toMatchObject({ kind: "async" });
    expect(removed).toEqual([]);
  });

  it("retires a one-time job whose run could not even start", async () => {
    scheduleExpression = "at(2027-01-01T09:00:00)";

    await expect(invokeCron()).rejects.toThrow(
      "Cron conversation is already processing another turn",
    );
    expect(removed).toEqual(["cron_1"]);
  });

  it("frames the stored instructions with the schedule that fired", async () => {
    await expect(
      invokeCron({ scheduledTime: "2026-08-14T09:00:00Z" }),
    ).rejects.toThrow("Cron conversation is already processing another turn");

    const [event] = admitted[0]?.events as ModelMessage[];
    expect(event?.role).toBe("user");
    expect(event?.content).toContain(
      '<scheduled-task name="daily-standup" schedule="cron(0 9 * * ? *)">',
    );
    expect(event?.content).toContain(
      "The scheduler started this run at 2026-08-14T09:00:00.000Z",
    );
    expect(event?.content).toContain(
      "A scheduled run has no scheduling tools at all",
    );
    expect(event?.content).toContain("Post the standup summary.");
  });
});

describe("settleCronRun", () => {
  it("retires a one-time job once its run settles", async () => {
    const { settleCronRun } = await import("../src/harness/handler.ts");
    const completeRun = mock(async function (): Promise<void> {});
    const remove = mock(async function (): Promise<boolean> {
      return true;
    });
    setStorageForTests({
      crons: { completeRun: completeRun, remove: remove },
    } as unknown as Storage);

    await settleCronRun(
      "acct_1",
      { cronId: "cron_1", runId: "run_1", oneShot: true },
      { result: "done" },
    );

    expect(completeRun).toHaveBeenCalledWith(
      "acct_1",
      "cron_1",
      "run_1",
      "done",
    );
    expect(remove).toHaveBeenCalledWith("acct_1", "cron_1");
  });

  it("retires a one-time job whose run failed, and keeps a recurring one", async () => {
    const { settleCronRun } = await import("../src/harness/handler.ts");
    const failRun = mock(async function (): Promise<void> {});
    const remove = mock(async function (): Promise<boolean> {
      return true;
    });
    setStorageForTests({
      crons: { failRun: failRun, remove: remove },
    } as unknown as Storage);

    await settleCronRun(
      "acct_1",
      { cronId: "cron_1", runId: "run_1", oneShot: true },
      { error: "model refused" },
    );
    await settleCronRun(
      "acct_1",
      { cronId: "cron_2", runId: "run_2" },
      { error: "model refused" },
    );

    expect(failRun).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("acct_1", "cron_1");
  });

  it("keeps the run alive when the cleanup delete fails", async () => {
    const { settleCronRun } = await import("../src/harness/handler.ts");
    setStorageForTests({
      crons: {
        completeRun: async function (): Promise<void> {},
        remove: async function (): Promise<boolean> {
          throw new Error("scheduler unreachable");
        },
      },
    } as unknown as Storage);

    expect(
      await settleCronRun(
        "acct_1",
        { cronId: "cron_1", runId: "run_1", oneShot: true },
        { result: "done" },
      ),
    ).toBeUndefined();
  });
});

function cron(): CronRecord {
  return {
    accountId: "acct_1",
    cronId: "cron_1",
    name: "daily-standup",
    agentId: "agent_1",
    events: [{ role: "user", content: "Post the standup summary." }],
    ...(conversationKey ? { conversationKey: conversationKey } : {}),
    scheduleExpression: scheduleExpression,
    status: "active",
    schedulerName: "acct_1-abc",
    schedulerGroupName: "broods-crons",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function invokeCron(
  overrides: { scheduledTime?: string } = {},
): Promise<Response> {
  return handler({
    kind: "cron",
    accountId: "acct_1",
    cronId: "cron_1",
    ...overrides,
  } as Parameters<typeof handler>[0]);
}

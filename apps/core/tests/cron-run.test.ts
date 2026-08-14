/**
 * Scheduled cron invocation tests.
 * Cover which conversation a cron run resumes and where its answer is delivered.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
let admitted: Record<string, unknown>[];
let failures: string[];

beforeEach(() => {
  channelTarget = null;
  conversationKey = undefined;
  admitted = [];
  failures = [];
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
    },
  } as unknown as Storage);
  runtime.query = (async function (name: string) {
    return name === "getConversationTarget" ? channelTarget : null;
  }) as never;
  // Admitting as "queued" stops before the async worker: the envelope the cron
  // hands to the coordinator is what these tests assert.
  runtime.mutate = (async function (name: string, args: unknown) {
    if (name === "acceptIngress") {
      admitted.push(args as Record<string, unknown>);
    }

    return { outcome: "queued" };
  }) as never;
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
    scheduleExpression: "cron(0 9 * * ? *)",
    status: "active",
    schedulerName: "acct_1-abc",
    schedulerGroupName: "broods-crons",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function invokeCron(): Promise<Response> {
  return handler({
    kind: "cron",
    accountId: "acct_1",
    cronId: "cron_1",
  } as Parameters<typeof handler>[0]);
}

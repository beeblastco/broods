import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelMessage } from "ai";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { ConversationDispatchTarget } from "../src/harness/ingress.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { ChannelRecord } from "../src/shared/domain/channel-record.ts";
import type { CronRecord, CronRunRecord } from "../src/shared/domain/cron.ts";
import type { SandboxConfigRecord } from "../src/shared/domain/sandbox-config.ts";
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
  config: {
    model: { provider: "openai", modelId: "gpt-5.5" },
    channels: { slack: { botToken: "current-token" } },
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const CHANNEL_RECORD: ChannelRecord = {
  accountId: "acct_1",
  channelRecordId: "rec_1",
  platform: "slack",
  externalId: "C1",
  name: "general",
  config: { agentBindings: [], denyTools: ["bash"] },
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const CHANNEL_TARGET: ConversationDispatchTarget = {
  channelName: "slack",
  source: { teamId: "T1", channelId: "C1" },
};

const originalQuery = runtime.query.bind(runtime);
const originalMutate = runtime.mutate.bind(runtime);

let channelTarget: ConversationDispatchTarget | null;
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
    channelRecords: {
      getById: async function (_accountId: string, channelRecordId: string) {
        return channelRecordId === CHANNEL_RECORD.channelRecordId
          ? CHANNEL_RECORD
          : null;
      },
    },
    crons: {
      getById: async function (): Promise<CronRecord> {
        return cron();
      },
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

    expect(invokeCron()).rejects.toThrow(
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
    // The envelope carries the rows to rebuild from, never the config itself.
    expect(admitted[0]?.configRef).toEqual({
      channel: { channelName: "slack" },
    });
    expect(admitted[0]).not.toHaveProperty("agentConfig");
    expect(failures).toEqual([
      "Cron conversation is already processing another turn",
    ]);
  });

  it("admits a run under the same id its own status URL names", async () => {
    conversationKey = "nightly-maintenance";

    expect(invokeCron()).rejects.toThrow(
      "Cron conversation is already processing another turn",
    );

    const candidate = admitted[0];
    const delivery = candidate?.delivery as {
      kind: string;
      statusUrl?: string;
    };
    expect(delivery.kind).toBe("async");
    // The envelope was once stored under an id minted at admission while its
    // own statusUrl still named the one built before it, so a client following
    // that URL resolved nothing.
    expect(candidate?.runId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(delivery.statusUrl).toBe(`/v1/runs/${String(candidate?.runId)}`);
  });

  it("keeps a cron with no live session on its own direct conversation", async () => {
    conversationKey = "nightly-maintenance";

    expect(invokeCron()).rejects.toThrow(
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

    expect(invokeCron()).rejects.toThrow(
      "Cron conversation is already processing another turn",
    );
    expect(removed).toEqual(["cron_1"]);
  });

  it("frames the stored instructions with the schedule that fired", async () => {
    expect(
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

describe("background job continuation", () => {
  it("resumes a channel session on its record-narrowed config", async () => {
    const job: AsyncToolResultRecord = {
      resultId: "job_1",
      parentEventId: "acct:acct_1:agent:agent_1:evt_1",
      conversationKey: "acct:acct_1:agent:agent_1:slack:T1:C1",
      toolName: "bash",
      toolCallId: "call_1",
      input: {},
      status: "processing",
      createdAt: "2026-08-14T09:00:00.000Z",
      updatedAt: "2026-08-14T09:00:00.000Z",
      delivery: {
        kind: "channel",
        channelName: "slack",
        source: CHANNEL_TARGET.source,
      },
      expiresAt: 0,
    };
    const answers: Record<string, unknown> = {
      getAsyncToolResult: job,
      getAsyncToolToken: true,
      getConversationTarget: {
        ...CHANNEL_TARGET,
        channelRecordId: CHANNEL_RECORD.channelRecordId,
      },
    };
    runtime.query = async function (name: string) {
      return answers[name] ?? null;
    } as never;
    runtime.mutate = async function (name: string, args: unknown) {
      if (name === "updateAsyncToolResult") {
        return { ...job, status: "completed", response: "done" };
      }
      admitted.push(args as Record<string, unknown>);

      return { outcome: "queued" };
    } as never;

    const response = await handler({
      method: "POST",
      path: "/v1/sandbox-jobs/job_1/complete",
      search: "",
      query: new URLSearchParams(),
      headers: { "x-job-token": "token" },
      body: JSON.stringify({ status: "completed", response: "done" }),
      cookies: [],
      clientIp: "127.0.0.1",
    });

    expect(response.status).toBe(202);
    expect(admitted[0]?.configRef).toEqual({
      channel: {
        channelName: "slack",
        channelRecordId: CHANNEL_RECORD.channelRecordId,
      },
    });
    expect(admitted[0]).not.toHaveProperty("agentConfig");
  });

  it("stores a job's output scrubbed of its sandbox's env values", async () => {
    setStorageForTests({
      agents: {
        getById: async function (): Promise<AgentRecord> {
          return { ...AGENT, config: { ...AGENT.config, sandboxes: ["sb_1"] } };
        },
      },
      agentDeployments: {
        getByAgentId: async function () {
          return null;
        },
      },
      sandboxConfigs: {
        getById: async function (): Promise<SandboxConfigRecord> {
          return {
            accountId: "acct_1",
            sandboxId: "sb_1",
            name: "box",
            config: {
              provider: "lambda",
              envVars: { DATABASE_URL: "postgres://sandbox-env-value" },
            },
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
        },
      },
    } as unknown as Storage);
    const job: AsyncToolResultRecord = {
      resultId: "job_2",
      parentEventId: "acct:acct_1:agent:agent_1:evt_2",
      conversationKey: "acct:acct_1:agent:agent_1:api:c1",
      toolName: "bash",
      toolCallId: "call_2",
      input: {},
      status: "processing",
      createdAt: "2026-08-14T09:00:00.000Z",
      updatedAt: "2026-08-14T09:00:00.000Z",
      expiresAt: 0,
    };
    const answers: Record<string, unknown> = {
      getAsyncToolResult: job,
      getAsyncToolToken: true,
    };
    runtime.query = async function (name: string) {
      return answers[name] ?? null;
    } as never;
    const settles: Record<string, unknown>[] = [];
    runtime.mutate = async function (name: string, args: unknown) {
      if (name === "updateAsyncToolResult") {
        settles.push(args as Record<string, unknown>);

        return { ...job, status: "completed", response: "done" };
      }

      return { outcome: "queued" };
    } as never;

    await handler({
      method: "POST",
      path: "/v1/sandbox-jobs/job_2/complete",
      search: "",
      query: new URLSearchParams(),
      headers: { "x-job-token": "token" },
      body: JSON.stringify({
        status: "completed",
        response: {
          stdout: "connected to postgres://sandbox-env-value",
          nextPageToken: "page-2",
        },
      }),
      cookies: [],
      clientIp: "127.0.0.1",
    });

    expect(settles[0]?.response).toEqual({
      stdout: "connected to [redacted]",
      nextPageToken: "page-2",
    });
  });
});

describe("queued envelope without a config ref", () => {
  it("is settled failed instead of running on another turn's config", async () => {
    const { dispatchAppliedIngress } =
      await import("../src/harness/handler.ts");
    const writes: { name: string; args: Record<string, unknown> }[] = [];
    runtime.mutate = async function (name: string, args: unknown) {
      writes.push({ name: name, args: args as Record<string, unknown> });

      return null;
    } as never;

    expect(
      dispatchAppliedIngress(
        {
          accountId: "acct_1",
          agentId: "agent_1",
          conversationKey: "acct:acct_1:agent:agent_1:api:c1",
          publicConversationKey: "c1",
        },
        {
          eventId: "evt_old_pod",
          events: [{ role: "user", content: "queued before the rollout" }],
          delivery: {
            kind: "async",
            publicEventId: "evt_old_pod",
            publicConversationKey: "c1",
            statusUrl: "/v1/runs/run_old",
          },
          requestedMode: "followup",
          appliedMode: "followup",
          appliedToEventId: "evt_old_pod",
          contributingEventIds: ["evt_old_pod"],
          ownerGeneration: 2,
        },
      ),
    ).rejects.toThrow("Queued turn was admitted before config refs; retry");

    expect(
      writes.find((write) => write.args.status === "failed")?.args,
    ).toMatchObject({
      ownerEventId: "evt_old_pod",
      ownerGeneration: 2,
      status: "failed",
      error: "Queued turn was admitted before config refs; retry",
    });
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
      { status: "completed", response: "done" },
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
      { status: "failed", error: "model refused" },
    );
    await settleCronRun(
      "acct_1",
      { cronId: "cron_2", runId: "run_2" },
      { status: "failed", error: "model refused" },
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
        { status: "completed", response: "done" },
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

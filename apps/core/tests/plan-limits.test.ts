import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  setSystemTime,
} from "bun:test";
import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import {
  admitRun,
  BudgetExhaustedError,
  flushUsage,
  planRefusalResponse,
  recordUsage,
  refundRun,
  resetPlanLimitsForTests,
} from "../src/harness/plan-limits.ts";
import { createSandboxExecutor } from "../src/harness/sandbox/index.ts";
import type { CronRecord } from "../src/shared/domain/cron.ts";
import { drainInFlight } from "../src/shared/in-flight.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
  type UsageSource,
} from "../src/shared/storage.ts";
import { settleOnFakeClock } from "./helpers/fake-clock.ts";

const { handler } = await import("../src/harness/handler.ts");

type MeterUsage = Parameters<Storage["budgets"]["record"]>[1];

interface MeterWrite {
  accountId: string;
  usage: MeterUsage;
  source?: UsageSource;
}

const ACCOUNT_ID = "acct_1";
const SERVICE_SECRET = "service-secret";

let budget: BudgetStatus;
let cronFailures: string[];
let held: (() => void)[];
let holdWrites: boolean;
let started: string[];
let recorded: MeterWrite[];
let warningClaims: number;

beforeEach(() => {
  budget = {
    enforced: true,
    plan: "free",
    month: "2026-09",
    usedPercent: 20,
    shares: { sandboxHours: 0, hostedMcpHours: 0, storageGb: 0, egressGb: 0 },
    runsPerMinute: 600,
    warned: false,
  };
  cronFailures = [];
  held = [];
  holdWrites = false;
  started = [];
  recorded = [];
  warningClaims = 0;
  resetPlanLimitsForTests();
  setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
  process.env.SERVICE_AUTH_SECRET = SERVICE_SECRET;
  setStorageForTests({
    budgets: {
      get: async function (): Promise<BudgetStatus> {
        return { ...budget };
      },
      record: async function (
        accountId: string,
        usage: MeterUsage,
        source?: UsageSource,
      ): Promise<void> {
        started.push(`${accountId}:${source?.agentId}`);
        if (holdWrites) {
          const write = Promise.withResolvers<void>();
          held.push(write.resolve);
          await write.promise;
        }
        recorded.push({
          accountId: accountId,
          usage: usage,
          ...(source ? { source: source } : {}),
        });
      },
      claimWarning: async function (): Promise<boolean> {
        warningClaims += 1;

        return warningClaims === 1;
      },
    },
    crons: {
      getById: async function (): Promise<CronRecord> {
        return {
          accountId: ACCOUNT_ID,
          cronId: "cron_1",
          name: "nightly",
          agentId: "agent_1",
          events: [{ role: "user", content: "run" }],
          scheduleExpression: "cron(0 9 * * ? *)",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        };
      },
      markFailed: async function (
        _accountId: string,
        _cronId: string,
        error: string,
      ): Promise<void> {
        cronFailures.push(error);
      },
    },
  } as unknown as Storage);
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  resetStorageForTests();
  delete process.env.SERVICE_AUTH_SECRET;
});

describe("admitRun", () => {
  it("refuses every run once the month's budget is used", async () => {
    budget.usedPercent = 100;

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.kind).toBe("budget");
    expect(refusal?.message).toContain("monthly resource caps for 2026-09");
  });

  it("names the storage limit when storage is what is full", async () => {
    budget.usedPercent = 100;
    budget.shares = { ...budget.shares, storageGb: 100 };

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.kind).toBe("budget");
    expect(refusal?.message).toBe(
      "This account has reached its storage limit of 10 GB of workspaces and files on the free plan. Delete files or upgrade to keep running agents; storage is measured once a day.",
    );
  });

  it("names both when storage and a monthly cap are full", async () => {
    budget.usedPercent = 130;
    budget.shares = { ...budget.shares, sandboxHours: 130, storageGb: 110 };

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.message).toBe(
      "This account has reached its storage limit of 10 GB of workspaces and files and one of its monthly resource caps for 2026-09 on the free plan. Delete files, then upgrade or wait for next month, to keep running agents; storage is measured once a day.",
    );
  });

  it("does not tell a pro account to upgrade when storage and a monthly cap are full", async () => {
    budget.plan = "pro";
    budget.usedPercent = 120;
    budget.shares = { ...budget.shares, egressGb: 120, storageGb: 100 };

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.message).toBe(
      "This account has reached its storage limit of 50 GB of workspaces and files and one of its monthly resource caps for 2026-09 on the pro plan. Delete files, then wait for next month, to keep running agents; storage is measured once a day.",
    );
  });

  it("refuses a burst past the plan's runs per minute", async () => {
    await admitMany(budget.runsPerMinute);

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.kind).toBe("rate");
    expect(refusal?.retryAfterSeconds).toBe(60);
  });

  it("gives back a run the intake refunds, within the same window", async () => {
    await admitMany(budget.runsPerMinute - 1);
    refundRun(await admitRun(ACCOUNT_ID), ACCOUNT_ID);

    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
    expect((await admitRun(ACCOUNT_ID)).refusal?.kind).toBe("rate");
  });

  it("reads a refusal without counting the run or claiming the notice", async () => {
    budget.usedPercent = 80;
    await admitMany(budget.runsPerMinute - 1);

    for (let read = 0; read < 3; read += 1) {
      expect(
        await admitRun(ACCOUNT_ID, { claimWarning: true, count: false }),
      ).toMatchObject({ refusal: null, warning: null });
    }
    expect(warningClaims).toBe(0);
    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
    expect((await admitRun(ACCOUNT_ID, { count: false })).refusal?.kind).toBe(
      "rate",
    );
  });

  it("does not start the minute's window with a read", async () => {
    budget.runsPerMinute = 1;
    setSystemTime(new Date("2026-09-15T00:00:00Z"));
    await admitRun(ACCOUNT_ID, { count: false });
    setSystemTime(new Date("2026-09-15T00:00:59Z"));
    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
    // A window the read had opened at :00 would have turned over at :01:00.
    setSystemTime(new Date("2026-09-15T00:01:01Z"));

    expect((await admitRun(ACCOUNT_ID)).refusal?.kind).toBe("rate");
  });

  it("does not refund into a window the run was not counted in", async () => {
    setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const stale = await admitRun(ACCOUNT_ID);
    setSystemTime(new Date("2026-09-15T00:01:01Z"));
    await admitMany(budget.runsPerMinute);
    refundRun(stale, ACCOUNT_ID);

    expect((await admitRun(ACCOUNT_ID)).refusal?.kind).toBe("rate");
  });

  it("limits nothing on a self-hosted install", async () => {
    budget.enforced = false;
    budget.usedPercent = 1000;
    await admitMany(budget.runsPerMinute + 1);

    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
  });

  it("warns a channel once when the budget passes 80%", async () => {
    budget.usedPercent = 80;

    const first = await admitRun(ACCOUNT_ID, { claimWarning: true });
    const second = await admitRun(ACCOUNT_ID, { claimWarning: true });

    expect(first.warning).toContain("80% of one of its monthly resource caps");
    expect(second.warning).toBeNull();
    expect(warningClaims).toBe(1);
  });

  it("names the storage limit when storage passes 80%", async () => {
    budget.usedPercent = 80;
    budget.shares = { ...budget.shares, storageGb: 80 };

    const { warning } = await admitRun(ACCOUNT_ID, { claimWarning: true });

    expect(warning).toContain(
      "80% of its storage limit of 10 GB of workspaces and files on the free plan",
    );
  });

  it("admits the run when claiming the notice fails", async () => {
    budget.usedPercent = 80;
    setStorageForTests({
      budgets: {
        get: async (): Promise<BudgetStatus> => ({ ...budget }),
        claimWarning: async (): Promise<boolean> => {
          throw new Error("convex unavailable");
        },
      },
    } as unknown as Storage);

    const admission = await admitRun(ACCOUNT_ID, { claimWarning: true });

    expect(admission).toMatchObject({ refusal: null, warning: null });
  });
});

describe("recordUsage", () => {
  it("sends one write per account and source with the amounts summed", async () => {
    for (let call = 0; call < 3; call += 1) {
      recordUsage(
        ACCOUNT_ID,
        { workerMs: 10, workerRequests: 1 },
        { agentId: "a" },
      );
    }
    recordUsage(ACCOUNT_ID, { egressGb: 0.5 }, { agentId: "a" });
    await flushUsage();

    expect(recorded).toEqual([
      {
        accountId: ACCOUNT_ID,
        usage: { workerMs: 30, workerRequests: 3, egressGb: 0.5 },
        source: { agentId: "a" },
      },
    ]);
  });

  it("writes one account's sources in turn and different accounts in parallel", async () => {
    holdWrites = true;
    recordUsage(ACCOUNT_ID, { workerRequests: 1 }, { agentId: "a" });
    recordUsage(ACCOUNT_ID, { workerRequests: 2 }, { agentId: "b" });
    recordUsage("acct_2", { workerRequests: 3 }, { agentId: "a" });
    const flushed = flushUsage();
    await Bun.sleep(0);
    expect(started).toEqual([`${ACCOUNT_ID}:a`, "acct_2:a"]);

    releaseHeld();
    await Bun.sleep(0);
    expect(started).toEqual([`${ACCOUNT_ID}:a`, "acct_2:a", `${ACCOUNT_ID}:b`]);
    releaseHeld();
    await flushed;

    expect(recorded).toHaveLength(3);
  });

  it("does not hold one account's usage behind another account's slow write", async () => {
    holdWrites = true;
    recordUsage(ACCOUNT_ID, { workerRequests: 1 });
    const slow = flushUsage();
    await Bun.sleep(0);
    holdWrites = false;
    recordUsage("acct_2", { workerRequests: 2 });
    await flushUsage();
    expect(recorded).toEqual([
      { accountId: "acct_2", usage: { workerRequests: 2 } },
    ]);
    releaseHeld();
    await slow;
  });

  it("keeps usage recorded during a flush for the next one", async () => {
    jest.useFakeTimers();
    holdWrites = true;
    recordUsage(ACCOUNT_ID, { ingressGb: 1 });
    const flushed = flushUsage();
    await Promise.resolve();
    recordUsage(ACCOUNT_ID, { ingressGb: 2 });
    holdWrites = false;
    releaseHeld();
    await flushed;
    expect(recorded.map((write) => write.usage)).toEqual([{ ingressGb: 1 }]);

    await settleOnFakeClock(drainInFlight());

    expect(recorded.map((write) => write.usage)).toEqual([
      { ingressGb: 1 },
      { ingressGb: 2 },
    ]);
  });

  it("lets shutdown drain a pending meter write", async () => {
    jest.useFakeTimers();
    recordUsage(ACCOUNT_ID, { ingressGb: 0.5 });
    const drained = drainInFlight();
    jest.advanceTimersByTime(4_999);
    await Promise.resolve();
    expect(recorded).toEqual([]);

    await settleOnFakeClock(drained);

    expect(recorded).toEqual([
      { accountId: ACCOUNT_ID, usage: { ingressGb: 0.5 } },
    ]);
  });
});

describe("refusal over HTTP", () => {
  it("answers an exhausted budget with 402 budget_exhausted", async () => {
    const response = planRefusalResponse({
      kind: "budget",
      message: "Budget used.",
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        message: "Budget used.",
        type: "invalid_request_error",
        code: "budget_exhausted",
      },
    });
  });

  it("answers a burst with 429 and Retry-After", async () => {
    const response = planRefusalResponse({
      kind: "rate",
      message: "Slow down.",
      limit: 600,
      retryAfterSeconds: 42,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
  });

  it("skips a cron fire with the reason once the budget is used", async () => {
    budget.usedPercent = 100;

    const response = await handler({
      method: "POST",
      path: "/v1/cron-runs",
      search: "",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
      body: JSON.stringify({
        kind: "cron",
        accountId: ACCOUNT_ID,
        cronId: "cron_1",
      }),
      clientIp: "",
    });

    expect(response.status).toBe(402);
    expect(cronFailures).toHaveLength(1);
    expect(cronFailures[0]).toContain("monthly resource caps");
  });
});

describe("sandbox start", () => {
  it("refuses to launch compute once the budget is used", async () => {
    budget.usedPercent = 100;
    const executor = createSandboxExecutor({
      provider: "sandbox",
      options: { workdirUrl: "https://workdir.example.com", apiKey: "key" },
      controlPlane: {
        accountId: ACCOUNT_ID,
        name: "default",
        specs: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
      },
    });

    await expect(
      executor.run({
        code: "echo hi",
        timeoutSeconds: 5,
        outputLimitBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

function releaseHeld(): void {
  for (const release of held.splice(0)) release();
}

async function admitMany(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
  }
}

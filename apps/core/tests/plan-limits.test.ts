/**
 * Plan enforcement in core: budget and burst admission, the 80% notice, the
 * refusal's HTTP shape, the cron refusal path and the sandbox launch check.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import {
  admitRun,
  BudgetExhaustedError,
  planRefusalResponse,
  recordUsage,
  resetPlanLimitsForTests,
} from "../src/harness/plan-limits.ts";
import { createSandboxExecutor } from "../src/harness/sandbox/index.ts";
import type { CronRecord } from "../src/shared/domain/cron.ts";
import { drainInFlight } from "../src/shared/in-flight.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";

const { handler } = await import("../src/harness/handler.ts");

type MeterUsage = Parameters<Storage["budgets"]["record"]>[1];

const ACCOUNT_ID = "acct_1";
const SERVICE_SECRET = "service-secret";

let budget: BudgetStatus;
let cronFailures: string[];
let recorded: MeterUsage[];
let warningClaims: number;

beforeEach(() => {
  budget = {
    enforced: true,
    plan: "free",
    month: "2026-09",
    usedEur: 1,
    limitEur: 5,
    runsPerMinute: 600,
    warned: false,
  };
  cronFailures = [];
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
        _accountId: string,
        usage: MeterUsage,
      ): Promise<void> {
        await Bun.sleep(5);
        recorded.push(usage);
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
  setSystemTime();
  resetStorageForTests();
  delete process.env.SERVICE_AUTH_SECRET;
});

describe("admitRun", () => {
  it("refuses every run once the month's budget is used", async () => {
    budget.usedEur = 5;

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.kind).toBe("budget");
    expect(refusal?.message).toContain("monthly compute allowance for 2026-09");
  });

  it("refuses a burst past the plan's runs per minute", async () => {
    await admitMany(budget.runsPerMinute);

    const { refusal } = await admitRun(ACCOUNT_ID);

    expect(refusal?.kind).toBe("rate");
    expect(refusal?.retryAfterSeconds).toBe(60);
  });

  it("limits nothing on a self-hosted install", async () => {
    budget.enforced = false;
    budget.usedEur = 50;
    await admitMany(budget.runsPerMinute + 1);

    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
  });

  it("warns a channel once when the budget passes 80%", async () => {
    budget.usedEur = 4;

    const first = await admitRun(ACCOUNT_ID, { claimWarning: true });
    const second = await admitRun(ACCOUNT_ID, { claimWarning: true });

    expect(first.warning).toContain("80% of its monthly compute allowance");
    expect(second.warning).toBeNull();
    expect(warningClaims).toBe(1);
  });

  it("admits the run when claiming the notice fails", async () => {
    budget.usedEur = 4;
    setStorageForTests({
      budgets: {
        get: async (): Promise<BudgetStatus> => ({ ...budget }),
        claimWarning: async (): Promise<boolean> => {
          throw new Error("convex unavailable");
        },
      },
    } as unknown as Storage);

    const admission = await admitRun(ACCOUNT_ID, { claimWarning: true });

    expect(admission).toEqual({ refusal: null, warning: null });
  });
});

describe("recordUsage", () => {
  it("lets shutdown drain a pending meter write", async () => {
    recordUsage(ACCOUNT_ID, { ingressGb: 0.5 });
    await drainInFlight();

    expect(recorded).toEqual([{ ingressGb: 0.5 }]);
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
    budget.usedEur = 5;

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
      cookies: [],
      clientIp: "",
    });

    expect(response.status).toBe(402);
    expect(cronFailures).toHaveLength(1);
    expect(cronFailures[0]).toContain("compute allowance");
  });
});

describe("sandbox start", () => {
  it("refuses to launch compute once the budget is used", async () => {
    budget.usedEur = 5;
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

async function admitMany(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    expect((await admitRun(ACCOUNT_ID)).refusal).toBeNull();
  }
}

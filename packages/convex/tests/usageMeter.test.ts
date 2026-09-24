/// <reference types="vite/client" />
/**
 * The monthly usage meter: the sandbox billing math, the price of a meter,
 * the sandbox mirror writing to it, and the budget read core enforces.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { EMPTY_USAGE, meterCostEur } from "../model/pricing";
import {
  budgetUsage,
  SANDBOX_IDLE_BILL_MS,
  sandboxAccrual,
} from "../model/usageMeter";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12);

const meterTest = () => convexTest(schema, modules);

type T = ReturnType<typeof meterTest>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("sandboxAccrual", () => {
  const microvm = {
    provider: "lambda" as const,
    specs: { vcpu: 0.25, memoryMb: 512, storageGb: 8 },
    status: "running" as const,
  };

  test("bills a MicroVM in use at its 1 vCPU / 2 GB baseline", () => {
    const accrual = sandboxAccrual(
      { ...microvm, lastUsedAt: NOW, meteredUntil: NOW - HOUR_MS },
      NOW,
    );

    expect(accrual.usage).toEqual({
      sandboxVcpuSeconds: 3600,
      sandboxGbSeconds: 7200,
    });
    expect(accrual.meteredUntil).toBe(NOW);
  });

  test("stops billing an idle sandbox at its idle timeout", () => {
    const lastUsedAt = NOW - HOUR_MS;
    const accrual = sandboxAccrual(
      { ...microvm, lastUsedAt: lastUsedAt, meteredUntil: lastUsedAt },
      NOW,
    );

    expect(accrual.usage.sandboxVcpuSeconds).toBe(SANDBOX_IDLE_BILL_MS / 1000);
    expect(accrual.meteredUntil).toBe(lastUsedAt + SANDBOX_IDLE_BILL_MS);
  });

  test("bills nothing the platform does not pay for", () => {
    const base = { ...microvm, lastUsedAt: NOW, meteredUntil: NOW - HOUR_MS };
    const daytona = {
      ...base,
      provider: "daytona" as const,
      specs: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
    };

    expect(sandboxAccrual({ ...base, status: "suspended" }, NOW).usage).toEqual(
      {},
    );
    expect(sandboxAccrual({ ...base, provider: "machine" }, NOW).usage).toEqual(
      {},
    );
    expect(
      sandboxAccrual({ ...daytona, ownCredentials: true }, NOW).usage,
    ).toEqual({});
    expect(sandboxAccrual(daytona, NOW).usage).toEqual({
      sandboxVcpuSeconds: 7200,
      sandboxGbSeconds: 14400,
    });
  });
});

test("an hour of the default MicroVM costs about €0.14", () => {
  const cost = meterCostEur({
    ...EMPTY_USAGE,
    sandboxVcpuSeconds: 3600,
    sandboxGbSeconds: 7200,
  });

  expect(cost).toBeCloseTo(0.1368, 4);
});

test("a sandbox's launch and running time land on its account's meter", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = meterTest();
  const accountId = await seedAccount(t);

  await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: "lambda",
    reservationKey: "fs-abc",
    externalId: "vm-1",
    name: "default",
    specs: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
  });
  vi.setSystemTime(NOW + 10 * 60 * 1000);
  await t.mutation(internal.sandbox.instances.remove, {
    accountId: accountId,
    reservationKey: "fs-abc",
  });

  const meter = await t.run(async (ctx) =>
    ctx.db.query("usageMeters").unique(),
  );
  expect(meter).toMatchObject({
    month: "2026-09",
    sandboxVcpuSeconds: 600,
    sandboxGbSeconds: 1200,
    sandboxSnapshotGb: 2,
  });
});

test("a sandbox on the account's own credentials never reaches the meter", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = meterTest();
  const accountId = await seedAccount(t);

  await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: "daytona",
    reservationKey: "fs-own",
    externalId: "dt-1",
    name: "own-daytona",
    specs: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
    ownCredentials: true,
  });
  vi.setSystemTime(NOW + 10 * 60 * 1000);
  await t.mutation(internal.sandbox.instances.remove, {
    accountId: accountId,
    reservationKey: "fs-own",
  });

  expect(
    await t.run(async (ctx) => ctx.db.query("usageMeters").collect()),
  ).toEqual([]);
});

test("the hourly accrual pages through every recent sandbox", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = meterTest();
  const accountId = await seedAccount(t);
  await t.run(async (ctx) => {
    for (let index = 0; index < 150; index += 1) {
      await ctx.db.insert("sandboxInstances", {
        accountId: accountId,
        provider: "sandbox",
        reservationKey: `fs-${index}`,
        externalId: `sbx-${index}`,
        name: "default",
        status: "running",
        specs: { vcpu: 1, memoryMb: 1024, storageGb: 8 },
        createdAt: NOW - HOUR_MS,
        lastUsedAt: NOW,
        meteredUntil: NOW - 60_000,
      });
    }
  });

  await t.mutation(internal.sandbox.instances.accrueRecent, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const meter = await t.run(async (ctx) =>
    ctx.db.query("usageMeters").unique(),
  );
  // 150 sandboxes × 60 s each, across two pages.
  expect(meter?.sandboxVcpuSeconds).toBe(150 * 60);
});

test("a storage snapshot lands in the month it was taken", async () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 0, 5) });
  const t = meterTest();
  const accountId = await seedAccount(t);

  await t.mutation(internal.account.budget.record, {
    accountId: accountId,
    usage: { storageGbMonths: 1 },
    at: Date.UTC(2026, 8, 30, 23, 59),
  });

  const meter = await t.run(async (ctx) =>
    ctx.db.query("usageMeters").unique(),
  );
  expect(meter).toMatchObject({ month: "2026-09", storageGbMonths: 1 });
});

test("a retried usage write with the same id counts once", async () => {
  const t = meterTest();
  const accountId = await seedAccount(t);
  const write = {
    accountId: accountId,
    usage: { egressGb: 1 },
    writeId: "write-1",
  };

  await t.mutation(internal.account.budget.record, write);
  await t.mutation(internal.account.budget.record, write);

  const meter = await t.run(async (ctx) =>
    ctx.db.query("usageMeters").unique(),
  );
  expect(meter?.egressGb).toBe(1);
});

describe("budget", () => {
  test("is not enforced unless this is the managed service", async () => {
    const t = meterTest();
    const accountId = await seedAccount(t);

    const budget = await t.query(internal.account.budget.get, {
      accountId: accountId,
    });

    expect(budget).toMatchObject({ enforced: false, limitEur: 5 });
  });

  test("prices the month's meter against the plan and warns once at 80%", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const accountId = await seedAccount(t);
    await t.mutation(internal.account.budget.record, {
      accountId: accountId,
      usage: { egressGb: 50 },
    });

    const budget = await t.query(internal.account.budget.get, {
      accountId: accountId,
    });
    const claims = [
      await t.mutation(internal.account.budget.claimWarning, {
        accountId: accountId,
      }),
      await t.mutation(internal.account.budget.claimWarning, {
        accountId: accountId,
      }),
    ];

    expect(budget).toMatchObject({ enforced: true, plan: "free" });
    expect(budget?.usedEur).toBeCloseTo(4, 6);
    expect(claims).toEqual([true, false]);
  });

  test("reaches the dashboard as amounts and percentages with no euro figures", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const accountId = await seedAccount(t);
    await t.mutation(internal.account.budget.record, {
      accountId: accountId,
      usage: { egressGb: 50, storageGbMonths: 50, ingressGb: 2 },
    });

    const usage = await t.run(async (ctx) => budgetUsage(ctx, accountId, NOW));

    const amounts = {
      sandboxHours: 0,
      hostedMcpCalls: 0,
      storageGb: 1500,
      egressGb: 50,
      ingressGb: 2,
    };
    expect(usage).toEqual({
      enforced: true,
      plan: "free",
      month: "2026-09",
      months: ["2026-09"],
      usedPercent: 101,
      categories: { sandboxes: 0, hostedMcp: 0, storage: 21, egress: 80 },
      level: "exhausted",
      runsPerMinute: 600,
      totals: amounts,
      days: [{ day: "2026-09-23", ...amounts }],
    });
  });

  test("shows the latest storage snapshot, even an empty one", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const accountId = await seedAccount(t);
    // Two snapshots on the 21st (a rescheduled cron), then an empty one.
    for (const [day, hour, storageGbMonths] of [
      [21, 1, 0.1],
      [21, 20, 0.1],
      [22, 1, 0],
    ] as const) {
      await t.mutation(internal.account.budget.record, {
        accountId: accountId,
        usage: { storageGbMonths: storageGbMonths },
        at: Date.UTC(2026, 8, day, hour),
      });
    }

    const usage = await t.run(async (ctx) => budgetUsage(ctx, accountId, NOW));

    expect(usage.totals.storageGb).toBe(0);
    expect(usage.days).toMatchObject([{ day: "2026-09-21", storageGb: 3 }]);
  });

  test("reads a past month from the picker, and nothing outside it", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const accountId = await seedAccount(t);
    await t.mutation(internal.account.budget.record, {
      accountId: accountId,
      usage: { egressGb: 100 },
      at: Date.UTC(2026, 7, 10),
    });

    const [august, unknown] = await t.run(async (ctx) =>
      Promise.all([
        budgetUsage(ctx, accountId, NOW, "2026-08"),
        budgetUsage(ctx, accountId, NOW, "x"),
      ]),
    );

    expect(august).toMatchObject({
      month: "2026-08",
      months: ["2026-09", "2026-08"],
      usedPercent: 160,
      totals: { storageGb: null },
    });
    expect(august.days.map((day) => day.day)).toEqual(["2026-08-10"]);
    expect(unknown.month).toBe("2026-09");
  });

  test("splits all usage on a self-hosted install, with no limit", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const accountId = await seedAccount(t);
    await t.mutation(internal.account.budget.record, {
      accountId: accountId,
      usage: { egressGb: 1, storageGbMonths: 1 },
    });

    const usage = await t.run(async (ctx) => budgetUsage(ctx, accountId, NOW));

    expect(usage.usedPercent).toBeNull();
    expect(usage.level).toBe("ok");
    expect(usage.categories.egress + usage.categories.storage).toBeCloseTo(
      100,
      0,
    );
  });
});

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

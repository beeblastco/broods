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
import { SANDBOX_IDLE_BILL_MS, sandboxAccrual } from "../model/usageMeter";
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

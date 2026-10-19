/// <reference types="vite/client" />
/**
 * The payer's usage pool: every org one user owns is metered together, the
 * plan's caps stop all of them at once, and each org's own amounts stay its
 * own. Org-count limits are in `stripeBilling.test.ts`, with the Stripe seam.
 */

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { purgeOrg } from "../model/cascade";
import { PLAN_LIMITS, type Plan } from "../model/planLimits";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.UTC(2026, 8, 23, 12);
const PAYER = "auth_payer";
const MEMBER = "auth_member";
const PRO_EGRESS = PLAN_LIMITS.pro.caps.egressGb;
const NO_SHARES = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
};

// Who is signed in.
const caller = vi.hoisted(() => ({ authId: "auth_payer" }));

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({
      id: caller.authId,
      email: `${caller.authId}@example.com`,
    }),
    registerRoutes: () => undefined,
  },
}));

const poolTest = () => convexTest(schema, modules);

type T = ReturnType<typeof poolTest>;

interface SeededOrg {
  orgId: Id<"orgs">;
  accountId: Id<"accounts">;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  caller.authId = PAYER;
});

test("a Pro owner's orgs draw on one pool: usage on one stops the other, and the owner is warned once", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const b = await seedOrg(t, PAYER, "pro", "B");

  await record(t, a.accountId, { egressGb: PRO_EGRESS * 0.8 });
  const claims = [await claim(t, a.accountId), await claim(t, b.accountId)];
  await record(t, a.accountId, { egressGb: PRO_EGRESS * 0.2 });

  expect(claims).toEqual([true, false]);
  expect(await status(t, b.accountId)).toMatchObject({
    enforced: true,
    plan: "pro",
    usedPercent: 100,
    warned: true,
  });
  await activate(t, PAYER, b.orgId);
  const usage = await t.query(api.account.budget.getForActiveOrg, {});
  // B's own month is empty, but what it shows as used is what stops its runs.
  expect(usage).toMatchObject({
    usedPercent: 100,
    level: "exhausted",
    shares: { ...NO_SHARES, egressGb: 100 },
    orgShares: NO_SHARES,
    pool: { orgs: 2, shared: true },
  });
  expect(usage?.totals.egressGb).toBe(0);
  // The pool's amounts come with it, so the dashboard never rebuilds them from a rounded share.
  expect(usage?.pool?.totals.egressGb).toBe(PRO_EGRESS);
});

test("pools never mix: another payer's org and a member's own Hobby workspace stay at zero", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const other = await seedOrg(t, "auth_other", "pro", "Other");
  await addMember(t, MEMBER, a.orgId);
  const own = await seedOrg(t, MEMBER, "free", "Mine");

  await record(t, a.accountId, { egressGb: PRO_EGRESS });

  expect((await status(t, a.accountId))?.usedPercent).toBe(100);
  expect((await status(t, other.accountId))?.usedPercent).toBe(0);
  expect((await status(t, own.accountId))?.usedPercent).toBe(0);
});

test("a member sees the pool's percent and that it is shared, not the owner's org count", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  await seedOrg(t, PAYER, "pro", "B");
  await addMember(t, MEMBER, a.orgId);
  await record(t, a.accountId, { egressGb: PRO_EGRESS / 2 });

  caller.authId = MEMBER;
  const usage = await t.query(api.account.budget.getForActiveOrg, {});

  expect(usage).toMatchObject({ usedPercent: 50, pool: { shared: true } });
  expect(usage?.pool).not.toHaveProperty("orgs");
});

test("usage metered before the pool existed counts: reads sum the owner's meters, the first write seeds the row once", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const b = await seedOrg(t, PAYER, "pro", "B");
  const other = await seedOrg(t, "auth_other", "pro", "Other");
  await t.run(async (ctx) => {
    for (const [accountId, egressGb, storageGb] of [
      [a.accountId, 6, 2],
      [b.accountId, 9, 3],
      [other.accountId, 30, 50],
    ] as const) {
      await ctx.db.insert("usageMeters", {
        accountId: accountId,
        month: "2026-09",
        sandboxVcpuSeconds: 0,
        sandboxGbSeconds: 0,
        sandboxSnapshotGb: 0,
        sandboxSnapshotGbMonths: 0,
        hostedMcpGbSeconds: 0,
        hostedMcpRequests: 0,
        storageGbMonths: 0,
        egressGb: egressGb,
        ingressGb: 0,
        storageGb: storageGb,
        updatedAt: NOW,
      });
    }
  });
  const pools = async (): Promise<
    Array<{ egressGb: number; storageGb?: number }>
  > =>
    (await t.run(async (ctx) => ctx.db.query("usagePools").collect())).map(
      (row) => ({ egressGb: row.egressGb, storageGb: row.storageGb }),
    );

  // Before any write: (6 + 9) / 30 of egress, 5 / 50 of storage, no row.
  expect((await status(t, b.accountId))?.shares).toEqual({
    ...NO_SHARES,
    egressGb: 50,
    storageGb: 10,
  });
  expect(await pools()).toEqual([]);

  // The first write starts the row from the meters, the delta counted once.
  await record(t, a.accountId, { egressGb: 3 });
  expect(await pools()).toEqual([{ egressGb: 18, storageGb: 5 }]);
  // A later write adds to the row and seeds nothing again.
  await record(t, b.accountId, { egressGb: 3 });
  expect(await pools()).toEqual([{ egressGb: 21, storageGb: 5 }]);
  expect((await status(t, a.accountId))?.shares.egressGb).toBe(70);
});

test("deleting an org leaves the owner's pool where it was", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const b = await seedOrg(t, PAYER, "pro", "B");
  await record(t, a.accountId, { egressGb: PRO_EGRESS });

  await t.run(async (ctx) => purgeOrg(ctx, a.orgId));
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await t.run(async (ctx) => ctx.db.get(a.accountId))).toBeNull();
  expect((await status(t, b.accountId))?.usedPercent).toBe(100);
});

test("a retried write with the same id counts once in the pool", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const write = {
    accountId: a.accountId,
    usage: { egressGb: 1 },
    writeId: "write-1",
  };

  await t.mutation(internal.account.budget.record, write);
  await t.mutation(internal.account.budget.record, write);

  const pool = await t.run(async (ctx) => ctx.db.query("usagePools").unique());
  expect(pool).toMatchObject({
    ownerAuthId: PAYER,
    month: "2026-09",
    egressGb: 1,
  });
});

test("the owner's accounts' storage snapshots sum in the pool, and carry into the next month", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const a = await seedOrg(t, PAYER, "pro", "A");
  const b = await seedOrg(t, PAYER, "pro", "B");
  const stored = async (): Promise<number | undefined> =>
    (await t.run(async (ctx) => ctx.db.query("usagePools").unique()))
      ?.storageGb;

  await record(t, a.accountId, { storageGbMonths: 10 / 30 });
  expect(await stored()).toBe(10);
  await record(t, b.accountId, { storageGbMonths: 10 / 30 });
  expect(await stored()).toBe(20);
  // A's next snapshot replaces A's size, not the pool's.
  await record(t, a.accountId, { storageGbMonths: 5 / 30 });
  expect(await stored()).toBe(15);
  expect((await status(t, b.accountId))?.shares.storageGb).toBe(30);

  vi.setSystemTime(Date.UTC(2026, 9, 1, 0, 30));
  expect(await status(t, b.accountId)).toMatchObject({
    month: "2026-10",
    shares: { storageGb: 30 },
  });
});

test("an account no org owns is metered on its own", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.useFakeTimers({ now: NOW });
  const t = poolTest();
  const accountId = await t.run(async (ctx) =>
    ctx.db.insert("accounts", {
      orgId: "external:service",
      username: "service",
      secretHash: "hash",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );

  await record(t, accountId, { egressGb: PLAN_LIMITS.free.caps.egressGb });

  expect(await status(t, accountId)).toMatchObject({
    plan: "free",
    usedPercent: 100,
  });
  expect([await claim(t, accountId), await claim(t, accountId)]).toEqual([
    true,
    false,
  ]);
  expect(
    await t.run(async (ctx) => ctx.db.query("usagePools").collect()),
  ).toEqual([]);
});

// Makes `authId` a member of the org, as an admin, with a user row if new.
async function addMember(
  t: T,
  authId: string,
  orgId: Id<"orgs">,
): Promise<void> {
  await t.run(async (ctx) => {
    const memberId = await userId(ctx, authId, "free");
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: memberId,
      role: "admin",
      createdAt: NOW,
    });
    await ctx.db.patch(memberId, { activeOrgId: orgId });
  });
}

// Makes `orgId` the org `authId` sees in the dashboard.
async function activate(
  t: T,
  authId: string,
  orgId: Id<"orgs">,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch(await userId(ctx, authId, "free"), {
      activeOrgId: orgId,
    });
  });
}

async function claim(t: T, accountId: Id<"accounts">): Promise<boolean> {
  return await t.mutation(internal.account.budget.claimWarning, {
    accountId: accountId,
  });
}

async function record(
  t: T,
  accountId: Id<"accounts">,
  usage: { egressGb?: number; storageGbMonths?: number },
): Promise<void> {
  await t.mutation(internal.account.budget.record, {
    accountId: accountId,
    usage: usage,
  });
}

// An org `owner` owns, on `plan`, with its account, and active for the owner.
async function seedOrg(
  t: T,
  owner: string,
  plan: Plan,
  name: string,
): Promise<SeededOrg> {
  return await t.run(async (ctx) => {
    const ownerId = await userId(ctx, owner, plan);
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name.toLowerCase(),
      ownerAuthId: owner,
      plan: plan,
      createdAt: NOW,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: ownerId,
      role: "owner",
      createdAt: NOW,
    });
    await ctx.db.patch(ownerId, { activeOrgId: orgId });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: name.toLowerCase(),
      secretHash: `hash-${name}`,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });

    return { orgId: orgId, accountId: accountId };
  });
}

async function status(
  t: T,
  accountId: Id<"accounts">,
): Promise<Awaited<ReturnType<typeof budgetGet>>> {
  return await budgetGet(t, accountId);
}

const budgetGet = (t: T, accountId: Id<"accounts">) =>
  t.query(internal.account.budget.get, { accountId: accountId });

// The user row for `authId`, inserted on `plan` if new.
async function userId(
  ctx: Parameters<Parameters<T["run"]>[0]>[0],
  authId: string,
  plan: Plan,
): Promise<Id<"users">> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();

  return (
    user?._id ??
    (await ctx.db.insert("users", {
      authId: authId,
      email: `${authId}@example.com`,
      name: authId,
      plan: plan,
    }))
  );
}

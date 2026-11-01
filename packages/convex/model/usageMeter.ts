// Usage lands on the account's month and day meters and on the pool of the user owning its org:
// plan caps are measured against that pool, so one owner's orgs share one allowance.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accountOrg,
  BUDGET_WARNING_RATIO,
  type BudgetLevel,
  budgetLevel,
  isManagedService,
  PLAN_LIMITS,
  type Plan,
  type ResourceCaps,
} from "./planLimits";
import {
  DAYS_PER_MONTH,
  EMPTY_USAGE,
  HOSTED_MCP_MEMORY_GB,
  meterCostByCategoryEur,
  MICROVM_BASELINE,
  UNIT_RATES_EUR,
  type UsageQuantities,
} from "./pricing";
import { workspaceSandboxLimits } from "./sandboxRules";

// core's DEFAULT_IDLE_TIMEOUT_SECONDS: the provider bills an idle sandbox until then.
export const DEFAULT_SANDBOX_IDLE_MS = 15 * 60 * 1000;

// Hours are cost over one default-size hour: a bigger sandbox, a resume or a snapshot use more.
const SANDBOX_HOUR_EUR =
  3600 *
  (MICROVM_BASELINE.vcpu * UNIT_RATES_EUR.sandboxVcpuSeconds +
    MICROVM_BASELINE.memoryGb * UNIT_RATES_EUR.sandboxGbSeconds);
const HOSTED_MCP_HOUR_EUR =
  3600 * HOSTED_MCP_MEMORY_GB * UNIT_RATES_EUR.hostedMcpGbSeconds;

const MONTH_SECONDS = DAYS_PER_MONTH * 24 * 60 * 60;
// core's MAX_MICROVM_DURATION_SECONDS: gone 8 h after last use, whatever its row says.
const MICROVM_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;
// Covers a MicroVM's `maximumDuration` (its timeout + 60 s) and a workdir call's mount.
const EPHEMERAL_SANDBOX_GRACE_MS = 2 * 60 * 1000;

const MONTHS_SHOWN = 12;

const BILLED_STATUSES: ReadonlySet<Doc<"sandboxInstances">["status"]> = new Set(
  ["running", "suspending", "terminating"],
);

export interface BudgetStatus {
  enforced: boolean;
  plan: Plan;
  month: string;
  usedPercent: number;
  shares: Record<keyof ResourceCaps, number>;
  runsPerMinute: number;
  warned: boolean;
}

export interface PoolUsage {
  /** Absent for a member: `account/budget.ts` strips it. */
  orgs?: number;
  shared: boolean;
  totals: UsageAmounts;
}

/**
 * Never euros, so each plan's budget stays private. `usedPercent`, `shares` and `level` are
 * the pool's (what core enforces); `totals`, `days`, `projects` and `orgShares` this org's.
 */
export interface BudgetUsage {
  enforced: boolean;
  plan: Plan;
  month: string;
  months: string[];
  usedPercent: number | null;
  caps: ResourceCaps | null;
  shares: Record<keyof ResourceCaps, number>;
  orgShares: Record<keyof ResourceCaps, number>;
  level: BudgetLevel;
  totals: UsageAmounts;
  days: Array<UsageAmounts & { day: string }>;
  projects?: ProjectUsage[];
  pool?: PoolUsage;
}

export interface ProjectUsage {
  projectId: Id<"projects">;
  name: string;
  totals: UsageAmounts;
  days: Array<UsageAmounts & { day: string }>;
}

export interface UsageAmounts {
  sandboxHours: number;
  hostedMcpHours: number;
  storageGb: number | null;
  egressGb: number;
  ingressGb: number;
}

export type BurstTotals = NonNullable<Doc<"sandboxInstances">["burstBilled"]>;

export interface SandboxAccrual {
  usage: Partial<UsageQuantities>;
  meteredUntil: number;
}

export async function addUsage(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  usage: Partial<UsageQuantities>,
  now: number,
  projectId?: Id<"projects">,
): Promise<void> {
  if (!hasUsage(usage)) return;
  const snapshot = snapshotFields(usage);
  const month = meterMonth(now);
  const meter = await readMeter(ctx, accountId, month);
  if (meter) {
    await ctx.db.patch(meter._id, {
      ...withUsage(meter, usage),
      ...snapshot,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("usageMeters", {
      accountId: accountId,
      month: month,
      ...withUsage(null, usage),
      ...snapshot,
      updatedAt: now,
    });
  }
  await addPoolUsage(ctx, accountId, usage, month, now);
  const day = meterDay(now);
  const daily = await ctx.db
    .query("usageDays")
    .withIndex("by_accountId_and_day", (q) =>
      q.eq("accountId", accountId).eq("day", day),
    )
    .unique();
  if (daily) {
    await ctx.db.patch(daily._id, {
      ...withUsage(daily, usage),
      ...snapshot,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("usageDays", {
      accountId: accountId,
      day: day,
      ...withUsage(null, usage),
      ...snapshot,
      updatedAt: now,
    });
  }
  if (projectId) await addProjectUsage(ctx, accountId, projectId, usage, now);
}

// Project day only: the storage snapshot splits a size the account's meter already took whole.
export async function addProjectUsage(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  projectId: Id<"projects">,
  usage: Partial<UsageQuantities>,
  now: number,
): Promise<void> {
  if (!hasUsage(usage)) return;
  const day = meterDay(now);
  const row = await ctx.db
    .query("usageProjectDays")
    .withIndex("by_accountId_and_day_and_projectId", (q) =>
      q.eq("accountId", accountId).eq("day", day).eq("projectId", projectId),
    )
    .unique();
  if (row) {
    await ctx.db.patch(row._id, {
      ...withUsage(row, usage),
      ...snapshotFields(usage),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("usageProjectDays", {
      accountId: accountId,
      projectId: projectId,
      day: day,
      ...withUsage(null, usage),
      ...snapshotFields(usage),
      updatedAt: now,
    });
  }
}

// Projects need not sum to the account: account-wide and pre-project usage is in none.
export async function projectUsage(
  ctx: QueryCtx,
  account: Doc<"accounts">,
  usage: BudgetUsage,
): Promise<ProjectUsage[]> {
  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) return [];
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
    .collect();
  const rows = await ctx.db
    .query("usageProjectDays")
    .withIndex("by_accountId_and_day_and_projectId", (q) =>
      q
        .eq("accountId", account._id)
        .gte("day", `${usage.month}-01`)
        .lte("day", `${usage.month}-31`),
    )
    .collect();
  const snapshotDays = usage.days
    .filter((day) => day.storageGb !== null)
    .map((day) => day.day);
  const snapshotDaySet = new Set(snapshotDays);
  const lastSnapshot = snapshotDays.at(-1) ?? null;
  const byProject = new Map<Id<"projects">, Doc<"usageProjectDays">[]>();
  for (const row of rows) {
    const list = byProject.get(row.projectId);
    if (list) list.push(row);
    else byProject.set(row.projectId, [row]);
  }

  return projects.map((project): ProjectUsage => {
    const own = byProject.get(project._id) ?? [];
    let total = pickUsage(null);
    for (const row of own) total = withUsage(row, total);
    const byDay = new Map(own.map((row) => [row.day, row]));
    const storedOn = (day: string | null): number | null =>
      day === null
        ? null
        : (byDay.get(day)?.storageGb ?? (snapshotDaySet.has(day) ? 0 : null));
    const days = [...new Set([...byDay.keys(), ...snapshotDays])].sort();

    return {
      projectId: project._id,
      name: project.name,
      totals: toAmounts(total, storedOn(lastSnapshot)),
      days: days.map((day) => {
        const row = byDay.get(day) ?? null;

        return { day: day, ...toAmounts(pickUsage(row), storedOn(day)) };
      }),
    };
  });
}

export async function budgetStatus(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<BudgetStatus> {
  return (await readBudget(ctx, accountId, now)).status;
}

export async function budgetUsage(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
  requestedMonth?: string,
): Promise<BudgetUsage> {
  const org = await accountOrg(ctx, accountId);
  const plan = org?.plan ?? "free";
  const currentMonth = meterMonth(now);
  const meters = await ctx.db
    .query("usageMeters")
    .withIndex("by_accountId_and_month", (q) => q.eq("accountId", accountId))
    .order("desc")
    .take(MONTHS_SHOWN);
  const months = [
    currentMonth,
    ...meters.map((row) => row.month).filter((row) => row !== currentMonth),
  ].slice(0, MONTHS_SHOWN);
  const month =
    requestedMonth !== undefined && months.includes(requestedMonth)
      ? requestedMonth
      : currentMonth;
  const meter = meters.find((row) => row.month === month) ?? null;
  const usage = pickUsage(meter);
  const totals = toAmounts(
    usage,
    month === currentMonth
      ? await latestStorageGb(ctx, accountId, month, meter)
      : (meter?.storageGb ?? null),
  );
  const enforced = isManagedService();
  const caps = PLAN_LIMITS[plan].caps;
  const orgShares = enforced ? capShares(totals, caps) : costShares(usage);
  // An account no org owns is its own pool.
  const pool =
    enforced && org
      ? await readPool(ctx, accountId, org, month, month === currentMonth)
      : null;
  const poolTotals = pool ? toAmounts(pool.usage, pool.storageGb) : null;
  const shares = poolTotals ? capShares(poolTotals, caps) : orgShares;
  const usedPercent = closestShare(shares);
  const owned =
    org && pool
      ? await ctx.db
          .query("orgs")
          .withIndex("by_ownerAuthId", (q) =>
            q.eq("ownerAuthId", org.ownerAuthId),
          )
          .collect()
      : [];
  const dayRows = await ctx.db
    .query("usageDays")
    .withIndex("by_accountId_and_day", (q) =>
      q
        .eq("accountId", accountId)
        .gte("day", `${month}-01`)
        .lte("day", `${month}-31`),
    )
    .collect();
  const days = dayRows.map((row) => ({
    day: row.day,
    ...toAmounts(pickUsage(row), row.storageGb ?? null),
  }));

  return {
    enforced: enforced,
    plan: plan,
    month: month,
    months: months,
    usedPercent: enforced ? usedPercent : null,
    caps: enforced ? caps : null,
    shares: shares,
    orgShares: orgShares,
    level: enforced ? budgetLevel(usedPercent) : "ok",
    totals: totals,
    days: days,
    ...(poolTotals
      ? {
          pool: {
            orgs: owned.length,
            shared: owned.length > 1,
            totals: poolTotals,
          },
        }
      : {}),
  };
}

export async function claimBudgetWarning(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<boolean> {
  const { status, pool } = await readBudget(ctx, accountId, now);
  if (status.warned || status.usedPercent < BUDGET_WARNING_RATIO * 100)
    return false;
  // Usage metered before the pool existed can cross 80% with no row yet.
  const rowId =
    pool.row?._id ??
    (await addPoolUsage(ctx, accountId, {}, status.month, now));
  if (!rowId) return false;
  await ctx.db.patch(rowId, { warnedAt: now });

  return true;
}

export function meterDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function meterMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function ephemeralSandboxMaxMs(
  provider: Doc<"sandboxInstances">["provider"],
): number {
  return (
    workspaceSandboxLimits(provider).maxTimeoutSeconds * 1000 +
    EPHEMERAL_SANDBOX_GRACE_MS
  );
}

// Billed running until its idle timeout, then a suspended MicroVM stores its snapshot until it
// dies. A worker is metered per command (`workerMs`) instead, so its row bills nothing.
export function sandboxAccrual(
  instance: Pick<
    Doc<"sandboxInstances">,
    | "provider"
    | "specs"
    | "status"
    | "lastUsedAt"
    | "meteredUntil"
    | "ownCredentials"
    | "idleTimeoutSeconds"
    | "ephemeral"
  >,
  now: number,
): SandboxAccrual {
  const start = instance.meteredUntil ?? instance.lastUsedAt;
  if (
    instance.ownCredentials === true ||
    instance.provider === "machine" ||
    instance.provider === "worker" ||
    instance.status === "error"
  ) {
    return { usage: {}, meteredUntil: start };
  }
  const size = billedSize(instance);
  const ephemeral = instance.ephemeral === true;
  const lambda = instance.provider === "lambda";
  const aliveUntil = Math.min(
    now,
    ephemeral
      ? instance.lastUsedAt + ephemeralSandboxMaxMs(instance.provider)
      : lambda
        ? instance.lastUsedAt + MICROVM_MAX_LIFETIME_MS
        : now,
  );
  const idleUntil = ephemeral
    ? aliveUntil
    : instance.lastUsedAt + sandboxIdleMs(instance);
  const runningUntil = BILLED_STATUSES.has(instance.status)
    ? Math.max(start, Math.min(aliveUntil, idleUntil))
    : start;
  const runSeconds = (runningUntil - start) / 1000;
  const storedUntil = Math.max(runningUntil, aliveUntil);
  const storedSeconds =
    lambda && !ephemeral ? (storedUntil - runningUntil) / 1000 : 0;
  const usage: Partial<UsageQuantities> = {};
  if (runSeconds > 0) {
    usage.sandboxVcpuSeconds = runSeconds * size.vcpu;
    usage.sandboxGbSeconds = runSeconds * size.memoryGb;
  }
  if (storedSeconds > 0) {
    usage.sandboxSnapshotGbMonths =
      (storedSeconds * size.memoryGb) / MONTH_SECONDS;
  }

  return {
    usage: usage,
    meteredUntil: storedSeconds > 0 ? storedUntil : runningUntil,
  };
}

// Reports are running totals: a repeat or late one bills nothing, and `upsert` clears `billed`
// when a machine is replaced, so the new one starts from zero.
export function burstUsage(
  billed: BurstTotals | undefined,
  reported: BurstTotals,
): { usage: Partial<UsageQuantities>; billed: BurstTotals } {
  const since = billed ?? { vcpuSeconds: 0, gbSeconds: 0 };

  return {
    usage: {
      sandboxVcpuSeconds: Math.max(0, reported.vcpuSeconds - since.vcpuSeconds),
      sandboxGbSeconds: Math.max(0, reported.gbSeconds - since.gbSeconds),
    },
    billed: {
      vcpuSeconds: Math.max(reported.vcpuSeconds, since.vcpuSeconds),
      gbSeconds: Math.max(reported.gbSeconds, since.gbSeconds),
    },
  };
}

export function sandboxIdleMs(
  instance: Pick<Doc<"sandboxInstances">, "idleTimeoutSeconds">,
): number {
  return instance.idleTimeoutSeconds === undefined
    ? DEFAULT_SANDBOX_IDLE_MS
    : instance.idleTimeoutSeconds * 1000;
}

export function sandboxLaunchUsage(
  instance: Pick<Doc<"sandboxInstances">, "provider" | "specs">,
): Partial<UsageQuantities> {
  return instance.provider === "lambda"
    ? { sandboxSnapshotGb: billedSize(instance).memoryGb }
    : {};
}

// A MicroVM's size is fixed by its image, whatever its specs say.
function billedSize(
  instance: Pick<Doc<"sandboxInstances">, "provider" | "specs">,
): { vcpu: number; memoryGb: number } {
  if (instance.provider === "lambda") return MICROVM_BASELINE;

  return {
    vcpu: instance.specs.vcpu,
    memoryGb: instance.specs.memoryMb / 1024,
  };
}

function capShares(
  amounts: UsageAmounts,
  caps: ResourceCaps,
): Record<keyof ResourceCaps, number> {
  return {
    sandboxHours: toPercent(amounts.sandboxHours, caps.sandboxHours),
    hostedMcpHours: toPercent(amounts.hostedMcpHours, caps.hostedMcpHours),
    storageGb: toPercent(amounts.storageGb ?? 0, caps.storageGb),
    egressGb: toPercent(amounts.egressGb, caps.egressGb),
  };
}

function closestShare(shares: Record<keyof ResourceCaps, number>): number {
  return Math.max(...Object.values(shares));
}

function costShares(
  usage: UsageQuantities,
): Record<keyof ResourceCaps, number> {
  const costs = meterCostByCategoryEur(usage);
  const total =
    costs.sandboxes + costs.hostedMcp + costs.storage + costs.egress;

  return {
    sandboxHours: toPercent(costs.sandboxes, total),
    hostedMcpHours: toPercent(costs.hostedMcp, total),
    storageGb: toPercent(costs.storage, total),
    egressGb: toPercent(costs.egress, total),
  };
}

type MeterRow =
  | Doc<"usageMeters">
  | Doc<"usagePools">
  | Doc<"usageDays">
  | Doc<"usageProjectDays">;

interface PoolRead {
  row: Doc<"usagePools"> | Doc<"usageMeters"> | null;
  usage: UsageQuantities;
  storageGb: number | null;
}

// The month's first write seeds the pool from the owner's meters. Callers patch the account's
// meter first, so `usage` is already in that sum and is not added again.
async function addPoolUsage(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  usage: Partial<UsageQuantities>,
  month: string,
  now: number,
): Promise<Id<"usagePools"> | null> {
  const org = await accountOrg(ctx, accountId);
  if (!org) return null;
  const pool = await readPoolRow(ctx, org.ownerAuthId, month);
  if (pool) {
    const storage =
      usage.storageGbMonths === undefined
        ? {}
        : {
            storageGb:
              (await sumOwnedMeters(ctx, org.ownerAuthId, month)).storageGb ??
              0,
          };
    await ctx.db.patch(pool._id, {
      ...withUsage(pool, usage),
      ...storage,
      updatedAt: now,
    });

    return pool._id;
  }
  const owned = await sumOwnedMeters(ctx, org.ownerAuthId, month);

  return await ctx.db.insert("usagePools", {
    ownerAuthId: org.ownerAuthId,
    month: month,
    ...owned.usage,
    ...(owned.storageGb === null ? {} : { storageGb: owned.storageGb }),
    updatedAt: now,
  });
}

async function readBudget(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<{ status: BudgetStatus; pool: PoolRead }> {
  const org = await accountOrg(ctx, accountId);
  const plan = org?.plan ?? "free";
  const month = meterMonth(now);
  const pool = await readPool(ctx, accountId, org, month, true);
  const shares = capShares(
    toAmounts(pool.usage, pool.storageGb),
    PLAN_LIMITS[plan].caps,
  );

  return {
    status: {
      enforced: isManagedService(),
      plan: plan,
      month: month,
      usedPercent: closestShare(shares),
      shares: shares,
      runsPerMinute: PLAN_LIMITS[plan].runsPerMinute,
      warned: pool.row?.warnedAt !== undefined,
    },
    pool: pool,
  };
}

async function readPool(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  org: Doc<"orgs"> | null,
  month: string,
  current: boolean,
): Promise<PoolRead> {
  if (!org) {
    const meter = await readMeter(ctx, accountId, month);

    return {
      row: meter,
      usage: pickUsage(meter),
      storageGb: current
        ? await latestStorageGb(ctx, accountId, month, meter)
        : (meter?.storageGb ?? null),
    };
  }
  const pool = await readPoolRow(ctx, org.ownerAuthId, month);
  if (!pool) {
    return {
      row: null,
      ...(await sumOwnedMeters(ctx, org.ownerAuthId, month)),
    };
  }
  if (!current || pool.storageGb !== undefined) {
    return {
      row: pool,
      usage: pickUsage(pool),
      storageGb: pool.storageGb ?? null,
    };
  }
  const earlier = await ctx.db
    .query("usagePools")
    .withIndex("by_ownerAuthId_and_month", (q) =>
      q.eq("ownerAuthId", org.ownerAuthId).lt("month", month),
    )
    .order("desc")
    .first();

  return {
    row: pool,
    usage: pickUsage(pool),
    storageGb: earlier?.storageGb ?? null,
  };
}

async function sumOwnedMeters(
  ctx: QueryCtx,
  ownerAuthId: string,
  month: string,
): Promise<Omit<PoolRead, "row">> {
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", ownerAuthId))
    .collect();
  let usage = pickUsage(null);
  let storageGb: number | null = null;
  for (const org of owned) {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
      .unique();
    if (!account) continue;
    const meter = await readMeter(ctx, account._id, month);
    usage = withUsage(meter, usage);
    const held = await latestStorageGb(ctx, account._id, month, meter);
    if (held !== null) storageGb = (storageGb ?? 0) + held;
  }

  return { usage: usage, storageGb: storageGb };
}

async function readPoolRow(
  ctx: QueryCtx,
  ownerAuthId: string,
  month: string,
): Promise<Doc<"usagePools"> | null> {
  return await ctx.db
    .query("usagePools")
    .withIndex("by_ownerAuthId_and_month", (q) =>
      q.eq("ownerAuthId", ownerAuthId).eq("month", month),
    )
    .unique();
}

function pickUsage(row: MeterRow | null): UsageQuantities {
  if (!row) return { ...EMPTY_USAGE };

  return {
    sandboxVcpuSeconds: row.sandboxVcpuSeconds,
    sandboxGbSeconds: row.sandboxGbSeconds,
    sandboxSnapshotGb: row.sandboxSnapshotGb,
    sandboxSnapshotGbMonths: row.sandboxSnapshotGbMonths ?? 0,
    hostedMcpGbSeconds: row.hostedMcpGbSeconds,
    hostedMcpRequests: row.hostedMcpRequests,
    workerMs: row.workerMs ?? 0,
    workerRequests: row.workerRequests ?? 0,
    storageGbMonths: row.storageGbMonths,
    egressGb: row.egressGb,
    ingressGb: row.ingressGb ?? 0,
  };
}

function toAmounts(
  usage: UsageQuantities,
  storageGb: number | null,
): UsageAmounts {
  const costs = meterCostByCategoryEur(usage);

  return {
    sandboxHours: costs.sandboxes / SANDBOX_HOUR_EUR,
    hostedMcpHours: costs.hostedMcp / HOSTED_MCP_HOUR_EUR,
    storageGb: storageGb,
    egressGb: usage.egressGb,
    ingressGb: usage.ingressGb,
  };
}

function hasUsage(usage: Partial<UsageQuantities>): boolean {
  return (
    usage.storageGbMonths !== undefined ||
    Object.values(usage).some((value) => value > 0)
  );
}

// Zero-byte snapshots count, so an empty account reads 0 GB for the day rather than unknown.
function snapshotFields(usage: Partial<UsageQuantities>): {
  storageGb?: number;
} {
  return usage.storageGbMonths === undefined
    ? {}
    : { storageGb: usage.storageGbMonths * DAYS_PER_MONTH };
}

function toPercent(part: number, base: number): number {
  return base > 0 ? Math.round((part / base) * 1000) / 10 : 0;
}

function withUsage(
  row: MeterRow | null,
  usage: Partial<UsageQuantities>,
): UsageQuantities {
  const totals = pickUsage(row);
  for (const key of Object.keys(usage) as (keyof UsageQuantities)[]) {
    totals[key] += usage[key] ?? 0;
  }

  return totals;
}

// Storage is a size: last month's snapshot holds until this month's first, freeing no cap.
async function latestStorageGb(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  month: string,
  meter: Doc<"usageMeters"> | null,
): Promise<number | null> {
  if (meter?.storageGb !== undefined) return meter.storageGb;
  const earlier = await ctx.db
    .query("usageMeters")
    .withIndex("by_accountId_and_month", (q) =>
      q.eq("accountId", accountId).lt("month", month),
    )
    .order("desc")
    .first();

  return earlier?.storageGb ?? null;
}

async function readMeter(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  month: string,
): Promise<Doc<"usageMeters"> | null> {
  return await ctx.db
    .query("usageMeters")
    .withIndex("by_accountId_and_month", (q) =>
      q.eq("accountId", accountId).eq("month", month),
    )
    .unique();
}

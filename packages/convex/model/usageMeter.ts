/**
 * The per-account usage meter, by month and by day, and the pool it also
 * lands in: every account whose org one user owns shares that user's pool
 * (`usagePools`), and the plan's per-resource caps are measured against the
 * pool, so a Pro owner's orgs draw on one allowance. Also turns a sandbox's
 * running and suspended time into usage. The callers are the sandbox mirror
 * (`sandbox/instances.ts`), core's usage writes and the storage snapshot
 * (`account/budget.ts`).
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accountOrg,
  BUDGET_WARNING_RATIO,
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

/**
 * How long a sandbox runs idle before its provider suspends or stops it, for
 * a row that does not carry its own `lifecycle.idleTimeoutSeconds`: core's
 * `DEFAULT_IDLE_TIMEOUT_SECONDS`. The provider bills it until then, so the
 * meter does too.
 */
export const DEFAULT_SANDBOX_IDLE_MS = 15 * 60 * 1000;

// EUR of one hour at each hour-capped resource's default size. A group's cost
// divided by it is the hours the dashboard shows and the cap counts, so a
// bigger sandbox, a resume or a stored snapshot all use hours up.
const SANDBOX_HOUR_EUR =
  3600 *
  (MICROVM_BASELINE.vcpu * UNIT_RATES_EUR.sandboxVcpuSeconds +
    MICROVM_BASELINE.memoryGb * UNIT_RATES_EUR.sandboxGbSeconds);
const HOSTED_MCP_HOUR_EUR =
  3600 * HOSTED_MCP_MEMORY_GB * UNIT_RATES_EUR.hostedMcpGbSeconds;

const MONTH_SECONDS = DAYS_PER_MONTH * 24 * 60 * 60;
// A MicroVM lives at most 8 hours (core `MAX_MICROVM_DURATION_SECONDS`), so one
// used at `lastUsedAt` is gone 8 hours later even if its row still says
// running or suspended.
const MICROVM_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;
// Past the longest exec an ephemeral call may run: a MicroVM's own
// `maximumDuration` is its timeout plus 60 s, and a workdir call also mounts.
const EPHEMERAL_SANDBOX_GRACE_MS = 2 * 60 * 1000;

// How many months back the billing tab's month picker reaches.
const MONTHS_SHOWN = 12;

// Statuses where the provider is still running (and billing) the machine.
const BILLED_STATUSES: ReadonlySet<Doc<"sandboxInstances">["status"]> = new Set(
  ["running", "suspending", "terminating"],
);

/**
 * One account's budget for the current month, as core reads it: the plan's
 * caps against the pool of the user who owns the account's org.
 */
export interface BudgetStatus {
  /** False on a self-hosted install: nothing is limited. */
  enforced: boolean;
  plan: Plan;
  month: string;
  /** The closest cap's share of the pool used, in percent. Runs stop at 100. */
  usedPercent: number;
  /** Each capped resource's share of its cap, in percent, over the pool. */
  shares: Record<keyof ResourceCaps, number>;
  /** Per account, not pooled. */
  runsPerMinute: number;
  /** The 80% warning already went out to the pool's owner this month. */
  warned: boolean;
}

/** Who else draws on the pool an org's caps are measured against. */
export interface PoolUsage {
  /** Orgs drawing on the pool. Absent for a member, who sees only `shared`. */
  orgs?: number;
  /** The owner's other organizations draw on this pool too. */
  shared: boolean;
}

/**
 * What the dashboard shows of an account's month: amounts, caps and
 * percentages, never euros, so the budget behind each plan stays private.
 * `usedPercent`, `shares` and `level` are the pool's, the numbers core
 * enforces (`budgetStatus`): what the dashboard calls used is what stops
 * runs. `totals`, `days`, `projects` and `orgShares` are this org's own.
 */
export interface BudgetUsage {
  /** False on a self-hosted install: nothing is limited. */
  enforced: boolean;
  plan: Plan;
  month: string;
  /** Months with a meter, newest first, always led by the current one. */
  months: string[];
  /** The closest cap's share of the pool used. Null when nothing is enforced. */
  usedPercent: number | null;
  /** The plan's caps. Null when nothing is enforced. */
  caps: ResourceCaps | null;
  /** Each capped resource's share of its cap over the pool, or of all usage cost when nothing is enforced. */
  shares: Record<keyof ResourceCaps, number>;
  /** This org's own part of `shares`: its amounts over the same caps or cost. */
  orgShares: Record<keyof ResourceCaps, number>;
  /** "warning" from 80% of the closest cap, "exhausted" once runs stop at 100%. */
  level: "ok" | "warning" | "exhausted";
  totals: UsageAmounts;
  /** Days of the month with usage or a storage snapshot, oldest first. */
  days: Array<UsageAmounts & { day: string }>;
  /** Each of the org's projects' part of the month, when asked for. */
  projects?: ProjectUsage[];
  /** The owner's pool the caps are measured against. Absent when nothing is enforced. */
  pool?: PoolUsage;
}

/** One project's share of an account's month, in the allowance's units. */
export interface ProjectUsage {
  projectId: Id<"projects">;
  name: string;
  totals: UsageAmounts;
  /** Days the project used something or the account's snapshot ran, oldest first. */
  days: Array<UsageAmounts & { day: string }>;
}

/** Usage in the units the billing tab shows. */
export interface UsageAmounts {
  /** Hours at the default 1 vCPU / 2 GB size, resumes and suspended snapshots included. */
  sandboxHours: number;
  /** Invoke hours at the runner's memory size, requests included. */
  hostedMcpHours: number;
  /** GB stored at the latest snapshot. Null when no snapshot measured this month or day. */
  storageGb: number | null;
  egressGb: number;
  ingressGb: number;
}

/** vCPU-seconds and GB-seconds a machine used above its baseline since it booted. */
export type BurstTotals = NonNullable<Doc<"sandboxInstances">["burstBilled"]>;

/** A sandbox instance's unbilled usage up to `now`, and where billing now stands. */
export interface SandboxAccrual {
  usage: Partial<UsageQuantities>;
  meteredUntil: number;
}

/**
 * Add usage to the account's meter for the month and the day `now` falls in,
 * to the pool of the user who owns the account's org, and to `projectId`'s
 * day when the usage came from one project.
 */
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

/**
 * Add usage to one project's day only, for the storage snapshot's split of a
 * size the account's meter already took whole.
 */
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

/**
 * Each of the org's projects' part of `usage`'s month, as amounts and days.
 * Storage is what each project's workspaces held at the account's latest
 * snapshot in the month, so the projects add up to the snapshot the allowance
 * shows; before the month's first snapshot it is unknown (null) while the
 * allowance still shows last month's size. What no project used (account-wide resources, deleted projects,
 * usage metered before projects were) is the allowance's total less these.
 */
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
  // Days the account's snapshot ran: a project with no row on one held 0 GB.
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

/** The account's plan and limits, and its owner's pool against them, for the month `now` falls in. */
export async function budgetStatus(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<BudgetStatus> {
  return (await readBudget(ctx, accountId, now)).status;
}

/**
 * One month of the account's usage for the dashboard's allowance: amounts
 * and a daily series of its own, the plan's caps, and on the managed service
 * each resource's share of its cap over the owner's pool, next to this org's
 * own part of it. A requested month outside the picker's list falls back to
 * the current one.
 */
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
  // Every month in the list is one of `meters` or has no row yet.
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
  // An account no org owns is its own pool; its shares are already the pool's.
  const pool =
    enforced && org
      ? await readPool(ctx, accountId, org, month, month === currentMonth)
      : null;
  const shares = pool
    ? capShares(toAmounts(pool.usage, pool.storageGb), caps)
    : orgShares;
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
    ...(pool ? { pool: { orgs: owned.length, shared: owned.length > 1 } } : {}),
  };
}

/**
 * Mark this month's 80% warning as sent to the pool's owner.
 * @returns true for the one caller that should send it
 */
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

/** "YYYY-MM-DD" of the UTC day `now` falls in. */
export function meterDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** "YYYY-MM" of the UTC calendar month `now` falls in. */
export function meterMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * How long after its upsert an ephemeral (per-call) sandbox can still be
 * running: the provider's longest exec plus a grace. Its row is billed no
 * further, and the hourly accrual deletes one older than this.
 */
export function ephemeralSandboxMaxMs(
  provider: Doc<"sandboxInstances">["provider"],
): number {
  return (
    workspaceSandboxLimits(provider).maxTimeoutSeconds * 1000 +
    EPHEMERAL_SANDBOX_GRACE_MS
  );
}

/**
 * Sandbox time not billed yet, up to `now`. A sandbox is billed running from
 * where billing last stopped (or its last use) until its provider suspends it,
 * its own idle timeout past the last use. From then on a suspended MicroVM is
 * billed for storing its memory snapshot until it resumes or is released, and
 * never past the 8 hours a MicroVM can live after its last use.
 * An ephemeral sandbox never idles or stores a snapshot: it runs until its
 * call ends, and never past `ephemeralSandboxMaxMs`, so a row whose removal
 * was lost stops billing there.
 * Nothing is billed when the platform does not pay: a sandbox on the account's
 * own provider credentials, or a machine (the user's own computer).
 */
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
    instance.status === "error"
  ) {
    return { usage: {}, meteredUntil: start };
  }
  const size = billedSize(instance);
  const ephemeral = instance.ephemeral === true;
  const lambda = instance.provider === "lambda";
  // Past this the machine is gone, running or stored.
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

/**
 * The burst a machine used since it was last billed, from the running totals
 * its guest reports, and the totals billed after it. Burst is billed at the
 * same rates as the baseline. A report at or below the billed totals is a
 * repeat or arrived late, so it bills nothing; a replaced machine starts from
 * zero because `upsert` clears its billed totals.
 */
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

/** How long the sandbox idles before its provider suspends or stops it. */
export function sandboxIdleMs(
  instance: Pick<Doc<"sandboxInstances">, "idleTimeoutSeconds">,
): number {
  return instance.idleTimeoutSeconds === undefined
    ? DEFAULT_SANDBOX_IDLE_MS
    : instance.idleTimeoutSeconds * 1000;
}

/** Snapshot GB a MicroVM moves on one launch or resume; nothing for other providers. */
export function sandboxLaunchUsage(
  instance: Pick<Doc<"sandboxInstances">, "provider" | "specs">,
): Partial<UsageQuantities> {
  return instance.provider === "lambda"
    ? { sandboxSnapshotGb: billedSize(instance).memoryGb }
    : {};
}

// The size a provider bills: a MicroVM's is fixed by its image.
function billedSize(
  instance: Pick<Doc<"sandboxInstances">, "provider" | "specs">,
): { vcpu: number; memoryGb: number } {
  if (instance.provider === "lambda") return MICROVM_BASELINE;

  return {
    vcpu: instance.specs.vcpu,
    memoryGb: instance.specs.memoryMb / 1024,
  };
}

// "warning" from 80% of the closest cap, "exhausted" once runs stop at 100%.
function budgetLevel(usedPercent: number): BudgetUsage["level"] {
  return usedPercent >= 100
    ? "exhausted"
    : usedPercent >= BUDGET_WARNING_RATIO * 100
      ? "warning"
      : "ok";
}

// Each capped resource's share of its cap.
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

// The share of the resource closest to its cap, which is what stops runs.
function closestShare(shares: Record<keyof ResourceCaps, number>): number {
  return Math.max(...Object.values(shares));
}

// Each resource's share of all usage cost, for an install with no caps.
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

/**
 * What a cap is measured against for one month: the owner's pool, or the
 * account's own meter for an account no org owns. Until the pool has a row
 * for the month, the usage is the sum of the owner's accounts' meters, so
 * usage metered before the pool existed counts from the first read.
 */
interface PoolRead {
  row: Doc<"usagePools"> | Doc<"usageMeters"> | null;
  usage: UsageQuantities;
  /** Null when no snapshot has measured any of the accounts yet. */
  storageGb: number | null;
}

/**
 * Add usage to the pool of the user who owns the account's org, and give its
 * row's id. The month's first write creates the row from the sum of the
 * owner's accounts' meters: this account's meter was patched earlier in the
 * same mutation, so `usage` is in that sum and is not added again. A storage
 * snapshot sets the pool's stored size to the same sum's. An account no org
 * owns has no pool (null): its meter is read in its place.
 */
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

// The status and the pool it was measured on, so a warning claim patches the row it judged.
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

// `current` carries storage over from earlier months, as `latestStorageGb` does.
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

/**
 * The owner's accounts' meters for `month` summed, with the GB they hold at
 * their latest snapshots: what the pool's row starts from, and what is read
 * until it exists. One account per owned org, at most `maxOwnedOrgs` of them.
 */
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

// Whether there is anything to write: some usage, or a storage snapshot,
// which counts even at zero bytes.
function hasUsage(usage: Partial<UsageQuantities>): boolean {
  return (
    usage.storageGbMonths !== undefined ||
    Object.values(usage).some((value) => value > 0)
  );
}

// A storage snapshot also sets the stored size, zero-byte ones included, so
// an empty account reads 0 GB for the month and the day. Days with no
// snapshot and no usage keep no row and read as unknown.
function snapshotFields(usage: Partial<UsageQuantities>): {
  storageGb?: number;
} {
  return usage.storageGbMonths === undefined
    ? {}
    : { storageGb: usage.storageGbMonths * DAYS_PER_MONTH };
}

// A share of `base` as a percentage with one decimal; 0 when there is no base.
function toPercent(part: number, base: number): number {
  return base > 0 ? Math.round((part / base) * 1000) / 10 : 0;
}

// The row's quantities with `usage` added.
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

/**
 * Storage is a size: until this month's first daily snapshot, the latest
 * earlier one still holds, so a new month does not free a full storage cap.
 */
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

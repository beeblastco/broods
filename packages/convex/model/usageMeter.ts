/**
 * The per-account usage meter, by month and by day: adding usage to it,
 * measuring it against the plan's per-resource caps, and turning a sandbox's
 * running and suspended time into usage. The
 * callers are the sandbox mirror (`sandbox/instances.ts`), core's usage writes
 * and the storage snapshot (`account/budget.ts`).
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accountPlan,
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

/** One account's budget for the current month, as core and the dashboard read it. */
export interface BudgetStatus {
  /** False on a self-hosted install: nothing is limited. */
  enforced: boolean;
  plan: Plan;
  month: string;
  /** The closest cap's share used, in percent. Runs stop at 100. */
  usedPercent: number;
  runsPerMinute: number;
  /** The 80% warning already went out this month. */
  warned: boolean;
}

/**
 * What the dashboard shows of an account's month: amounts, caps and
 * percentages, never euros, so the budget behind each plan stays private.
 */
export interface BudgetUsage {
  /** False on a self-hosted install: nothing is limited. */
  enforced: boolean;
  plan: Plan;
  month: string;
  /** Months with a meter, newest first, always led by the current one. */
  months: string[];
  /** The closest cap's share used. Null when nothing is enforced. */
  usedPercent: number | null;
  /** The plan's caps. Null when nothing is enforced. */
  caps: ResourceCaps | null;
  /** Each capped resource's share of its cap, or of all usage cost when nothing is enforced. */
  shares: Record<keyof ResourceCaps, number>;
  /** "warning" from 80% of the closest cap, "exhausted" once runs stop at 100%. */
  level: "ok" | "warning" | "exhausted";
  totals: UsageAmounts;
  /** Days of the month with usage or a storage snapshot, oldest first. */
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

/** Add usage to the account's meter for the month and the day `now` falls in. */
export async function addUsage(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  usage: Partial<UsageQuantities>,
  now: number,
): Promise<void> {
  const hasUsage = Object.values(usage).some((value) => value > 0);
  if (!hasUsage && usage.storageGbMonths === undefined) return;
  // A storage snapshot also sets the stored size, zero-byte ones included, so
  // an empty account reads 0 GB for the month and the day. Days with no
  // snapshot and no usage keep no row and read as unknown.
  const snapshot =
    usage.storageGbMonths === undefined
      ? {}
      : { storageGb: usage.storageGbMonths * DAYS_PER_MONTH };
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
}

/** The account's plan, meter cost and limits for the month `now` falls in. */
export async function budgetStatus(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<BudgetStatus> {
  const plan = await accountPlan(ctx, accountId);
  const month = meterMonth(now);
  const meter = await readMeter(ctx, accountId, month);
  const amounts = toAmounts(pickUsage(meter), meter?.storageGb ?? null);

  return {
    enforced: isManagedService(),
    plan: plan,
    month: month,
    usedPercent: closestShare(capShares(amounts, PLAN_LIMITS[plan].caps)),
    runsPerMinute: PLAN_LIMITS[plan].runsPerMinute,
    warned: meter?.warnedAt !== undefined,
  };
}

/**
 * One month of the account's usage for the dashboard's allowance: amounts,
 * a daily series, the plan's caps and each resource's share of its cap. A requested month outside
 * the picker's list falls back to the current one.
 */
export async function budgetUsage(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
  requestedMonth?: string,
): Promise<BudgetUsage> {
  const plan = await accountPlan(ctx, accountId);
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
  const totals = toAmounts(usage, meter?.storageGb ?? null);
  const enforced = isManagedService();
  const caps = PLAN_LIMITS[plan].caps;
  const shares = enforced ? capShares(totals, caps) : costShares(usage);
  const usedPercent = closestShare(shares);
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
    level: !enforced
      ? "ok"
      : usedPercent >= 100
        ? "exhausted"
        : usedPercent >= BUDGET_WARNING_RATIO * 100
          ? "warning"
          : "ok",
    totals: totals,
    days: days,
  };
}

/**
 * Mark this month's 80% warning as sent.
 * @returns true for the one caller that should send it
 */
export async function claimBudgetWarning(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<boolean> {
  const status = await budgetStatus(ctx, accountId, now);
  if (status.warned || status.usedPercent < BUDGET_WARNING_RATIO * 100)
    return false;
  const meter = await readMeter(ctx, accountId, status.month);
  if (!meter) return false;
  await ctx.db.patch(meter._id, { warnedAt: now });

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

function pickUsage(
  row: Doc<"usageMeters"> | Doc<"usageDays"> | null,
): UsageQuantities {
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

// A share of `base` as a percentage with one decimal; 0 when there is no base.
function toPercent(part: number, base: number): number {
  return base > 0 ? Math.round((part / base) * 1000) / 10 : 0;
}

// The row's quantities with `usage` added.
function withUsage(
  row: Doc<"usageMeters"> | Doc<"usageDays"> | null,
  usage: Partial<UsageQuantities>,
): UsageQuantities {
  const totals = pickUsage(row);
  for (const key of Object.keys(usage) as (keyof UsageQuantities)[]) {
    totals[key] += usage[key] ?? 0;
  }

  return totals;
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

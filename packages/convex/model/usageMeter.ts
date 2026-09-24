/**
 * The monthly per-account usage meter: adding usage to it, pricing it against
 * the plan's budget, and turning a sandbox's running time into usage. The
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
} from "./planLimits";
import {
  EMPTY_USAGE,
  meterCostByCategoryEur,
  meterCostEur,
  MICROVM_BASELINE,
  type UsageCategory,
  type UsageQuantities,
} from "./pricing";

/**
 * How long a sandbox is billed past its last use. Every provider suspends or
 * stops an idle sandbox after `lifecycle.idleTimeoutSeconds`, 15 minutes by
 * default (core `DEFAULT_IDLE_TIMEOUT_SECONDS`).
 */
export const SANDBOX_IDLE_BILL_MS = 15 * 60 * 1000;

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
  usedEur: number;
  limitEur: number;
  runsPerMinute: number;
  /** The 80% warning already went out this month. */
  warned: boolean;
}

/**
 * What the dashboard shows of an account's month: percentages, never euros,
 * so the budget behind each plan stays private.
 */
export interface BudgetUsage {
  /** False on a self-hosted install: nothing is limited. */
  enforced: boolean;
  plan: Plan;
  month: string;
  /** Share of the plan's budget used. Null when nothing is enforced. */
  usedPercent: number | null;
  /** Each group's share of the budget, or of all usage when nothing is enforced. */
  categories: Record<UsageCategory, number>;
  /** "warning" from 80% of the budget, "exhausted" once runs stop at 100%. */
  level: "ok" | "warning" | "exhausted";
  runsPerMinute: number;
}

/** A sandbox instance's unbilled usage up to `now`, and where billing now stands. */
export interface SandboxAccrual {
  usage: Partial<UsageQuantities>;
  meteredUntil: number;
}

/** Add usage to the account's meter for the month `now` falls in. */
export async function addUsage(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  usage: Partial<UsageQuantities>,
  now: number,
): Promise<void> {
  if (!Object.values(usage).some((value) => value > 0)) return;
  const month = meterMonth(now);
  const meter = await readMeter(ctx, accountId, month);
  const totals = { ...EMPTY_USAGE, ...pickUsage(meter) };
  for (const key of Object.keys(usage) as (keyof UsageQuantities)[]) {
    totals[key] += usage[key] ?? 0;
  }
  if (meter) {
    await ctx.db.patch(meter._id, { ...totals, updatedAt: now });

    return;
  }
  await ctx.db.insert("usageMeters", {
    accountId: accountId,
    month: month,
    ...totals,
    updatedAt: now,
  });
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

  return {
    enforced: isManagedService(),
    plan: plan,
    month: month,
    usedEur: meterCostEur({ ...EMPTY_USAGE, ...pickUsage(meter) }),
    limitEur: PLAN_LIMITS[plan].monthlyBudgetEur,
    runsPerMinute: PLAN_LIMITS[plan].runsPerMinute,
    warned: meter?.warnedAt !== undefined,
  };
}

/** The account's month as percentages, for the dashboard billing panel. */
export async function budgetUsage(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<BudgetUsage> {
  const plan = await accountPlan(ctx, accountId);
  const month = meterMonth(now);
  const meter = await readMeter(ctx, accountId, month);
  const costs = meterCostByCategoryEur({ ...EMPTY_USAGE, ...pickUsage(meter) });
  const usedEur =
    costs.sandboxes + costs.hostedMcp + costs.storage + costs.egress;
  const enforced = isManagedService();
  const limitEur = PLAN_LIMITS[plan].monthlyBudgetEur;
  const base = enforced ? limitEur : usedEur;

  return {
    enforced: enforced,
    plan: plan,
    month: month,
    usedPercent: enforced ? toPercent(usedEur, limitEur) : null,
    categories: {
      sandboxes: toPercent(costs.sandboxes, base),
      hostedMcp: toPercent(costs.hostedMcp, base),
      storage: toPercent(costs.storage, base),
      egress: toPercent(costs.egress, base),
    },
    level: !enforced
      ? "ok"
      : usedEur >= limitEur
        ? "exhausted"
        : usedEur >= limitEur * BUDGET_WARNING_RATIO
          ? "warning"
          : "ok",
    runsPerMinute: PLAN_LIMITS[plan].runsPerMinute,
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
  if (status.warned || status.usedEur < status.limitEur * BUDGET_WARNING_RATIO)
    return false;
  const meter = await readMeter(ctx, accountId, status.month);
  if (!meter) return false;
  await ctx.db.patch(meter._id, { warnedAt: now });

  return true;
}

/** "YYYY-MM" of the UTC calendar month `now` falls in. */
export function meterMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Running time a sandbox has not been billed for yet. Billing runs from where
 * it last stopped (or the last use) to now, but never past the last use plus
 * the idle timeout, since the provider stops an idle machine by then. Nothing
 * is billed when the platform does not pay: a sandbox on the account's own
 * provider credentials, or a machine (the user's own computer).
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
  >,
  now: number,
): SandboxAccrual {
  const start = instance.meteredUntil ?? instance.lastUsedAt;
  const end = Math.min(now, instance.lastUsedAt + SANDBOX_IDLE_BILL_MS);
  if (
    instance.ownCredentials === true ||
    instance.provider === "machine" ||
    !BILLED_STATUSES.has(instance.status) ||
    end <= start
  ) {
    return { usage: {}, meteredUntil: Math.max(start, end) };
  }
  const seconds = (end - start) / 1000;
  const size = billedSize(instance);

  return {
    usage: {
      sandboxVcpuSeconds: seconds * size.vcpu,
      sandboxGbSeconds: seconds * size.memoryGb,
    },
    meteredUntil: end,
  };
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

// A share of `base` as a percentage with one decimal; 0 when there is no base.
function toPercent(part: number, base: number): number {
  return base > 0 ? Math.round((part / base) * 1000) / 10 : 0;
}

function pickUsage(meter: Doc<"usageMeters"> | null): Partial<UsageQuantities> {
  if (!meter) return {};

  return {
    sandboxVcpuSeconds: meter.sandboxVcpuSeconds,
    sandboxGbSeconds: meter.sandboxGbSeconds,
    sandboxSnapshotGb: meter.sandboxSnapshotGb,
    hostedMcpGbSeconds: meter.hostedMcpGbSeconds,
    hostedMcpRequests: meter.hostedMcpRequests,
    storageGbMonths: meter.storageGbMonths,
    egressGb: meter.egressGb,
  };
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

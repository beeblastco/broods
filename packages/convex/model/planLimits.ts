import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { planValidator } from "../schema";

export const BUDGET_EXHAUSTED = "budget_exhausted";

export const PLAN_LIMIT_EXCEEDED = "plan_limit_exceeded";

export const BUDGET_WARNING_RATIO = 0.8;

export type BudgetLevel = "ok" | "warning" | "exhausted";

export function budgetLevel(usedPercent: number): BudgetLevel {
  return usedPercent >= 100
    ? "exhausted"
    : usedPercent >= BUDGET_WARNING_RATIO * 100
      ? "warning"
      : "ok";
}

// EUR budgets stay in the backend; the dashboard gets caps and percentages (account/budget.ts).
export const FREE_MONTHLY_BUDGET_EUR = 5;

// Half of one €20 unit: the rest covers VAT, Stripe's fee, the fixed hosts and margin.
export const PRO_MONTHLY_BUDGET_EUR = 10;

export type Plan = Infer<typeof planValidator>;

// Hours are at the default size, so a bigger sandbox uses them faster; free ingress is uncapped.
export interface ResourceCaps {
  sandboxHours: number;
  hostedMcpHours: number;
  storageGb: number;
  egressGb: number;
}

export function capsReached(
  shares: ResourceCaps,
  percent = 100,
): { storage: boolean; monthly: boolean } {
  return {
    storage: shares.storageGb >= percent,
    monthly:
      shares.sandboxHours >= percent ||
      shares.hostedMcpHours >= percent ||
      shares.egressGb >= percent,
  };
}

export interface PlanLimits {
  caps: ResourceCaps;
  maxOwnedOrgs: number;
  runsPerMinute: number;
}

// Maxing every cap must cost at most the plan's budget (`tests/usageMeter.test.ts`).
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    caps: { sandboxHours: 9, hostedMcpHours: 16, storageGb: 10, egressGb: 15 },
    maxOwnedOrgs: 1,
    runsPerMinute: 600,
  },
  pro: {
    caps: {
      sandboxHours: 18,
      hostedMcpHours: 32,
      storageGb: 50,
      egressGb: 30,
    },
    maxOwnedOrgs: 10,
    runsPerMinute: 5_000,
  },
};

export async function accountOrg(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"orgs"> | null> {
  const account = await ctx.db.get(accountId);
  const orgId = account ? ctx.db.normalizeId("orgs", account.orgId) : null;

  return orgId ? await ctx.db.get(orgId) : null;
}

export function isManagedService(): boolean {
  return process.env.BROODS_MANAGED_SERVICE === "true";
}

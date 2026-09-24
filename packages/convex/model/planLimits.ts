/**
 * What each billing plan allows, and the account -> org -> plan lookup the
 * limits hang off. The real limit is the monthly compute budget, priced by
 * `model/pricing.ts`; runs per minute is only burst protection. Core enforces
 * these numbers. The budgets are private: the dashboard only gets percentages
 * from `account/budget.ts`, so it must never import this file.
 *
 * Nothing is enforced unless the Convex deployment sets
 * `BROODS_MANAGED_SERVICE=true`. Self-hosted installs leave it unset and get
 * every feature with no limits.
 */

import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { planValidator } from "../schema";

/** Error code for a monthly compute budget that is used up (HTTP 402). */
export const BUDGET_EXHAUSTED = "budget_exhausted";

/** Error code for a burst of runs past the plan's per-minute limit (HTTP 429). */
export const PLAN_LIMIT_EXCEEDED = "plan_limit_exceeded";

/** Share of the budget that triggers the one warning a month. */
export const BUDGET_WARNING_RATIO = 0.8;

/** EUR of real platform cost a free account may use per month. */
export const FREE_MONTHLY_BUDGET_EUR = 5;

/**
 * EUR of real platform cost a Pro account may use per month. Pro sells at
 * €20/month (Stripe price `STRIPE_PRO_PRICE_ID`, not in code). Half of it:
 * the rest covers VAT if the price includes it (€20 is €16.53 net at 21%),
 * Stripe's fee (about €0.55), the fixed Hetzner core and gateway, and margin.
 */
export const PRO_MONTHLY_BUDGET_EUR = 10;

export type Plan = Infer<typeof planValidator>;

export interface PlanLimits {
  /** EUR of metered platform cost per UTC calendar month. */
  monthlyBudgetEur: number;
  /** Burst protection: runs admitted per account per minute. */
  runsPerMinute: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { monthlyBudgetEur: FREE_MONTHLY_BUDGET_EUR, runsPerMinute: 600 },
  pro: { monthlyBudgetEur: PRO_MONTHLY_BUDGET_EUR, runsPerMinute: 5_000 },
};

/**
 * The plan an account runs on: its org's copy of the owner's plan. An account
 * with no org behind it (admin-created standalone accounts) is free.
 */
export async function accountPlan(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
): Promise<Plan> {
  const account = await ctx.db.get(accountId);
  const orgId = account ? ctx.db.normalizeId("orgs", account.orgId) : null;
  const org = orgId ? await ctx.db.get(orgId) : null;

  return org?.plan ?? "free";
}

/** True when this deployment is the managed BeeBlast service, which enforces plans. */
export function isManagedService(): boolean {
  return process.env.BROODS_MANAGED_SERVICE === "true";
}

/**
 * What each billing plan allows, and the account -> org -> plan lookup the
 * limits hang off. Each billed resource has a fixed monthly cap in its own
 * unit, and reaching any one of them stops runs until the month resets, the
 * way Convex's free tier does. The caps split the plan's euro budget evenly,
 * so an account that maxes every one of them costs at most that budget
 * (`tests/usageMeter.test.ts` checks it). Runs per minute is only burst
 * protection. Core enforces these numbers. The euro budgets never leave the
 * backend: the dashboard gets caps and percentages from `account/budget.ts`.
 *
 * Nothing is enforced unless the Convex deployment sets
 * `BROODS_MANAGED_SERVICE=true`. Self-hosted installs leave it unset and get
 * every feature with no limits.
 */

import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { planValidator } from "../schema";

/** Error code for a monthly resource cap that is used up (HTTP 402). */
export const BUDGET_EXHAUSTED = "budget_exhausted";

/** Error code for a burst of runs past the plan's per-minute limit (HTTP 429). */
export const PLAN_LIMIT_EXCEEDED = "plan_limit_exceeded";

/** Share of the closest cap that triggers the one warning a month. */
export const BUDGET_WARNING_RATIO = 0.8;

/** Most EUR of real platform cost a free account can reach per month. */
export const FREE_MONTHLY_BUDGET_EUR = 5;

/**
 * Most EUR of real platform cost a Pro account can reach per month. Pro sells at
 * €20/month (Stripe price `STRIPE_PRO_PRICE_ID`, not in code). Half of it:
 * the rest covers VAT if the price includes it (€20 is €16.53 net at 21%),
 * Stripe's fee (about €0.55), the fixed Hetzner core and gateway, and margin.
 */
export const PRO_MONTHLY_BUDGET_EUR = 10;

export type Plan = Infer<typeof planValidator>;

/**
 * A plan's monthly cap per billed resource, in the unit the dashboard shows.
 * Sandbox and hosted-MCP hours are at the default size, so a bigger sandbox
 * uses its hours faster. Ingress is free, so it has no cap.
 */
export interface ResourceCaps {
  sandboxHours: number;
  hostedMcpHours: number;
  storageGb: number;
  egressGb: number;
}

export interface PlanLimits {
  caps: ResourceCaps;
  /** Burst protection: runs admitted per account per minute. */
  runsPerMinute: number;
}

// About EUR 1.25 of each resource, a quarter of the free budget: two or three
// large projects' worth of building. Pro doubles every cap.
const FREE_CAPS: ResourceCaps = {
  sandboxHours: 9,
  hostedMcpHours: 16,
  storageGb: 50,
  egressGb: 15,
};

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { caps: FREE_CAPS, runsPerMinute: 600 },
  pro: {
    caps: {
      sandboxHours: FREE_CAPS.sandboxHours * 2,
      hostedMcpHours: FREE_CAPS.hostedMcpHours * 2,
      storageGb: FREE_CAPS.storageGb * 2,
      egressGb: FREE_CAPS.egressGb * 2,
    },
    runsPerMinute: 5_000,
  },
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

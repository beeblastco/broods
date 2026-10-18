/**
 * What each billing plan allows, and the account -> org -> plan lookup the
 * limits hang off. Each billed resource has a fixed monthly cap in its own
 * unit, and reaching any one of them stops runs until the month resets, the
 * way Convex's free tier does. The caps together stay within the plan's euro
 * budget, so an account that maxes every one of them costs at most that
 * budget (`tests/usageMeter.test.ts` checks it). Runs per minute is only burst
 * protection. Core enforces these numbers. The euro budgets never leave the
 * backend: the dashboard gets caps and percentages from `account/budget.ts`.
 *
 * Nothing is enforced unless the Convex deployment sets
 * `BROODS_MANAGED_SERVICE=true`. Self-hosted installs leave it unset and get
 * every feature with no limits.
 */

import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
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
 * €20 a month per owner, one unit of Stripe price `STRIPE_SEAT_PRICE_ID` (not
 * in code) with two developer seats included, and each extra seat is one more
 * unit. It covers every org the owner owns, and those orgs share these caps as
 * one pool (`usagePools`), however many orgs or seats the owner pays for. Half
 * of one unit: the rest covers VAT if the price includes it (€20 is €16.53 net
 * at 21%), Stripe's fee (about €0.55), the fixed Hetzner core and gateway, and
 * margin (internals/architecture.md).
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

/**
 * Which kinds of cap `shares` (percent of each cap) have reached `percent`:
 * storage, a size a new month does not free, and the monthly ones.
 */
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
  /** Orgs one owner may own, all drawing on the owner's one pool of caps. */
  maxOwnedOrgs: number;
  /** Burst protection: runs admitted per account per minute. */
  runsPerMinute: number;
}

// Free: about EUR 1.25 of compute and egress each, two or three large
// projects' worth of building, and a small storage allowance.
// Pro: about EUR 2.50 of compute and egress each, and 50 GB of storage.
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

/**
 * The org an account runs under: its plan follows the subscription of the
 * org's owner (model/orgBilling.ts), and the owner's pool is what the caps
 * measure. Null for an account with no org behind it (admin-created standalone
 * accounts), which is free and metered on its own.
 */
export async function accountOrg(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"orgs"> | null> {
  const account = await ctx.db.get(accountId);
  const orgId = account ? ctx.db.normalizeId("orgs", account.orgId) : null;

  return orgId ? await ctx.db.get(orgId) : null;
}

/** True when this deployment is the managed BeeBlast service, which enforces plans. */
export function isManagedService(): boolean {
  return process.env.BROODS_MANAGED_SERVICE === "true";
}

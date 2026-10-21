import type { Doc } from "@broods/convex/_generated/dataModel";
import {
  PRO_INCLUDED_DEVELOPER_SEATS,
  UNIT_PRICE_EUR,
} from "@broods/convex/model/orgBilling";
import { PLAN_LIMITS } from "@broods/convex/model/planLimits";
/** Plan tier as stored on the user; the Convex schema validator owns the union. */
export type PlanTier = Doc<"users">["plan"];

export interface PlanConfig {
  key: PlanTier;
  label: string;
  price: string;
}

/** Tier shown while the user row is still loading. */
export const DEFAULT_PLAN: PlanTier = "free";

/** Every plan, cheapest first. */
export const PLANS: PlanTier[] = ["free", "pro"];

export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  free: {
    key: "free",
    label: "Hobby",
    price: "Free",
  },
  pro: {
    key: "pro",
    label: "Pro",
    price: perMonth(1),
  },
};

/**
 * Check whether a user is on the highest tier, which hides the upgrade button.
 * @param plan current user plan
 * @returns true if on Pro
 */
export function isMaxPlan(plan: PlanTier): boolean {
  return plan === "pro";
}

/** `count` seats, like "1 seat" or "3 seats". */
export function seatCount(count: number): string {
  return `${count} ${count === 1 ? "seat" : "seats"}`;
}

/** What `units` cost a month, like "€40/month". */
export function perMonth(units: number): string {
  return `€${units * UNIT_PRICE_EUR}/month`;
}

/** What Pro offers its owner, wherever an upgrade is offered. */
export const PRO_OFFER = `Pro is ${perMonth(1)}: higher usage limits, up to ${PLAN_LIMITS.pro.maxOwnedOrgs} orgs, and ${PRO_INCLUDED_DEVELOPER_SEATS} developer seats to use across all of them. Extra seats are ${perMonth(1)} each.`;

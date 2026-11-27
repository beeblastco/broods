import type { Doc } from "@broods/convex/_generated/dataModel";
import {
  PRO_INCLUDED_DEVELOPER_SEATS,
  UNIT_PRICE_EUR,
} from "@broods/convex/model/orgBilling";
import { PLAN_LIMITS } from "@broods/convex/model/planLimits";
export type PlanTier = Doc<"users">["plan"];

export interface PlanConfig {
  key: PlanTier;
  label: string;
  price: string;
}

export const DEFAULT_PLAN: PlanTier = "free";

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

export function isMaxPlan(plan: PlanTier): boolean {
  return plan === "pro";
}

export function seatCount(count: number): string {
  return `${count} ${count === 1 ? "seat" : "seats"}`;
}

export function perMonth(units: number): string {
  return `€${units * UNIT_PRICE_EUR}/month`;
}

export const PRO_OFFER = `Pro is ${perMonth(1)}: higher usage limits, up to ${PLAN_LIMITS.pro.maxOwnedOrgs} orgs, and ${PRO_INCLUDED_DEVELOPER_SEATS} developer seats to use across all of them. Extra seats are ${perMonth(1)} each.`;

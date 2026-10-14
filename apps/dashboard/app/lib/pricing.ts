import type { Doc } from "@broods/convex/_generated/dataModel";
import {
  PRO_INCLUDED_DEVELOPER_SEATS,
  UNIT_PRICE_EUR,
} from "@broods/convex/model/orgBilling";
import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "@/app/components/ui/badge";

/** Plan tier as stored on the user; the Convex schema validator owns the union. */
export type PlanTier = Doc<"users">["plan"];

export interface PlanConfig {
  key: PlanTier;
  label: string;
  description: string;
  order: number;
  badgeVariant: NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
}

/** Tier shown while the user row is still loading. */
export const DEFAULT_PLAN: PlanTier = "free";

export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  free: {
    key: "free",
    label: "Hobby",
    description: "Free tier for personal projects",
    order: 0,
    badgeVariant: "secondary",
  },
  pro: {
    key: "pro",
    label: "Pro",
    description: "For teams and advanced workloads",
    order: 1,
    badgeVariant: "warning",
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

/** An amount in euros, like "€20". */
export function euros(amount: number): string {
  return `€${amount}`;
}

/** What `units` cost a month, like "€40/month". */
export function perMonth(units: number): string {
  return `${euros(units * UNIT_PRICE_EUR)}/month`;
}

/** What Pro offers an org, wherever an upgrade is offered. */
export const PRO_OFFER = `Pro is ${perMonth(1)}: it lets you create an org and includes ${PRO_INCLUDED_DEVELOPER_SEATS} developer seats. Extra seats are ${perMonth(1)} each.`;

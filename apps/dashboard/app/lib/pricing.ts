import type { Doc } from "@broods/convex/_generated/dataModel";
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

export const UPGRADE_URL =
  process.env.NEXT_PUBLIC_UPGRADE_URL ?? "https://github.com/beeblastco/broods";

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

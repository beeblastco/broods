import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "@/app/components/ui/badge";

/** Valid plan tier identifiers stored in the database. */
export type PlanTier = "hobby" | "developer" | "pro" | "free";

/** Plan tiers that have display configs (excludes "free" which maps to "hobby"). */
export type ConfiguredPlanTier = "hobby" | "developer" | "pro";

export interface PlanConfig {
  key: ConfiguredPlanTier;
  label: string;
  description: string;
  order: number;
  badgeVariant: NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
}

export const DEFAULT_PLAN: PlanTier = "hobby";

/** Highest tier. Users on this plan see no upgrade button. */
export const MAX_PLAN: PlanTier = "pro";

export const UPGRADE_URL =
  process.env.NEXT_PUBLIC_UPGRADE_URL ?? "https://github.com/beeblastco/broods";

export const PLAN_CONFIGS: Record<ConfiguredPlanTier, PlanConfig> = {
  hobby: {
    key: "hobby",
    label: "Hobby",
    description: "Free tier for personal projects",
    order: 0,
    badgeVariant: "secondary",
  },
  developer: {
    key: "developer",
    label: "Developer",
    description: "For individual developers shipping to production",
    order: 1,
    badgeVariant: "info",
  },
  pro: {
    key: "pro",
    label: "Pro",
    description: "For teams and advanced workloads",
    order: 2,
    badgeVariant: "warning",
  },
};

/**
 * Resolve the effective plan, defaulting undefined to "hobby".
 * @param plan raw plan value from database
 * @returns resolved plan tier
 */
export function resolvePlan(plan: PlanTier | undefined): ConfiguredPlanTier {
  if (plan === "free" || plan === undefined) return "hobby";

  return plan;
}

/**
 * Check whether a user is on the highest available tier.
 * @param plan current user plan
 * @returns true if on max tier
 */
export function isMaxPlan(plan: PlanTier): boolean {
  return plan === MAX_PLAN;
}

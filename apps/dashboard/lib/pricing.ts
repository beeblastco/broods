/**
 * Pricing tier definitions and metadata.
 * Single source of truth for plan display, defaults, and upgrade links.
 */

/** Valid plan tier identifiers. */
export type PlanTier = "hobby" | "developer" | "pro";

/** Metadata for a single pricing tier. */
export interface PlanConfig {
  key: PlanTier;
  label: string;
  description: string;
  order: number;
  /** Tailwind classes for the plan badge background and text color. */
  badgeClass: string;
}

/** Default plan assigned to new users. */
export const DEFAULT_PLAN: PlanTier = "hobby";

/** Highest tier — users on this plan see no upgrade button. */
export const MAX_PLAN: PlanTier = "pro";

/** External URL for plan upgrades. */
export const UPGRADE_URL = "https://clonee.dev/pricing";

/** Tier metadata keyed by plan identifier. */
export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  hobby: {
    key: "hobby",
    label: "Hobby",
    description: "Free tier for personal projects",
    order: 0,
    badgeClass: "bg-secondary text-secondary-foreground",
  },
  developer: {
    key: "developer",
    label: "Developer",
    description: "For individual developers shipping to production",
    order: 1,
    badgeClass: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  pro: {
    key: "pro",
    label: "Pro",
    description: "For teams and advanced workloads",
    order: 2,
    badgeClass: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
};

/**
 * Resolve the effective plan, defaulting undefined to "hobby".
 * @param plan raw plan value from database
 * @returns resolved plan tier
 */
export function resolvePlan(plan: PlanTier | undefined): PlanTier {
  return plan ?? DEFAULT_PLAN;
}

/**
 * Check whether a user is on the highest available tier.
 * @param plan current user plan
 * @returns true if on max tier
 */
export function isMaxPlan(plan: PlanTier): boolean {
  return plan === MAX_PLAN;
}

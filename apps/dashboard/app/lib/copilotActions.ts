/**
 * What the copilot is allowed to do, and which of those it may do on its own.
 *
 * The line is reversibility, not importance. Moving around the app is `safe`
 * and happens immediately. Anything that writes shows its before and after and
 * waits for a press. Deploys, deletes and key rotations are `blocked` outright:
 * the copilot describes them and hands over the button.
 */
import type { ShortcutId } from "@/app/lib/shortcuts";

export type CopilotTier = "safe" | "approval" | "blocked";

/** The before and after an approval-tier action prints before it runs. */
export interface CopilotChange {
  after: string;
  before: string;
  field: string;
}

export type CopilotAction =
  | { href: string; label: string; type: "navigate" }
  | { label: string; nodeId: string; type: "openNode" }
  | { commandId: ShortcutId; label: string; type: "command" }
  | {
      change: CopilotChange;
      cronId: string;
      label: string;
      status: "active" | "paused";
      type: "setCronStatus";
    }
  | {
      change: CopilotChange;
      label: string;
      name: string;
      type: "setEnvVar";
      value: string;
    }
  | { label: string; reason: string; type: "blocked" };

export interface CopilotPlan {
  actions: readonly CopilotAction[];
  summary: string;
}

const TIERS: Record<CopilotAction["type"], CopilotTier> = {
  blocked: "blocked",
  command: "safe",
  navigate: "safe",
  openNode: "safe",
  setCronStatus: "approval",
  setEnvVar: "approval",
};

/** The before/after card an action shows, or undefined when it only moves you around. */
export function actionChange(action: CopilotAction): CopilotChange | undefined {
  return "change" in action ? action.change : undefined;
}

export function actionTier(action: CopilotAction): CopilotTier {
  return TIERS[action.type];
}

/** True when every step runs without a press, so the dock can skip the approval row. */
export function planRunsUnattended(plan: CopilotPlan): boolean {
  return plan.actions.every((action) => actionTier(action) === "safe");
}

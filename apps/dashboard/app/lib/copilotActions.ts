// Tiers follow reversibility: navigation runs at once, a write waits, a deploy is handed over.
import type { ShortcutId } from "@/app/lib/shortcuts";

export type CopilotTier = "safe" | "approval" | "blocked";

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

export function actionChange(action: CopilotAction): CopilotChange | undefined {
  return "change" in action ? action.change : undefined;
}

export function actionTier(action: CopilotAction): CopilotTier {
  return TIERS[action.type];
}

export function planRunsUnattended(plan: CopilotPlan): boolean {
  return plan.actions.every((action) => actionTier(action) === "safe");
}

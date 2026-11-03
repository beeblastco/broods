// Tiers follow reversibility: navigation runs at once, a write waits, a deploy is handed over.
import { NODE_TYPE_SHORTCUTS } from "@/app/components/canvas/nodeTemplates";
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
  | { label: string; reason: string; type: "blocked" }
  | { label: string; source: string; target: string; type: "connectNodes" }
  | {
      agent?: string;
      change: CopilotChange;
      label: string;
      name: string;
      type: "addMcp";
      url: string;
    }
  | {
      change: CopilotChange;
      files: readonly { content: string; path: string }[];
      label: string;
      message: string;
      type: "commitFiles";
    };

export interface CopilotPlan {
  actions: readonly CopilotAction[];
  summary: string;
}

const TIERS: Record<CopilotAction["type"], CopilotTier> = {
  addMcp: "approval",
  blocked: "blocked",
  command: "safe",
  commitFiles: "approval",
  connectNodes: "approval",
  navigate: "safe",
  openNode: "safe",
  setCronStatus: "approval",
  setEnvVar: "approval",
};

export function actionChange(action: CopilotAction): CopilotChange | undefined {
  return "change" in action ? action.change : undefined;
}

// Adding a node writes to the stage, so it waits for its press like any other write.
const CREATING_COMMANDS: ReadonlySet<ShortcutId> = new Set(
  Object.values(NODE_TYPE_SHORTCUTS),
);

export function actionTier(action: CopilotAction): CopilotTier {
  if (action.type === "command" && CREATING_COMMANDS.has(action.commandId)) {
    return "approval";
  }

  return TIERS[action.type];
}

export function planRunsUnattended(plan: CopilotPlan): boolean {
  return plan.actions.every((action) => actionTier(action) === "safe");
}

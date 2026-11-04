// Tiers follow reversibility: navigation runs at once, a write waits, a deploy is handed over.
import {
  NODE_TYPE_SHORTCUTS,
  type NodeType,
} from "@/app/components/canvas/nodeTemplates";
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
      agent: string;
      label: string;
      nodeType: "sandbox" | "workspace";
      type: "addNode";
    }
  | {
      agent?: string;
      change: CopilotChange;
      label: string;
      name: string;
      type: "addMcp";
      url: string;
    }
  | {
      /** The branch head the agent read; Apply refuses once the branch has moved. */
      baseSha: string;
      branch: string;
      files: readonly CommitFile[];
      fullName: string;
      label: string;
      message: string;
      type: "commitFiles";
    };

export interface CommitFile {
  /** Null deletes the file. */
  content: string | null;
  /** Changed lines against the branch, unified-diff style, hunks led by `@@`. */
  patch: readonly string[];
  path: string;
}

/** A commit the user applied, followed until its GitHub deploy finishes. */
export interface TrackedDeploy {
  branch: string;
  committedAt: number;
  conclusion?: string;
  finishedAt?: number;
  messageId: string;
  runUrl?: string;
  sha: string;
  state: "deployed" | "deploying" | "failed" | "waiting";
  url: string;
}

export interface CopilotPlan {
  actions: readonly CopilotAction[];
  /** What the change adds to or removes from the canvas, drawn until it deploys. */
  nodes?: readonly ProposedNode[];
  summary: string;
}

export interface PendingChange {
  action: CopilotAction;
  index: number;
  messageId: string;
}

export interface ProposedNode {
  change: "add" | "remove";
  /** The node the edge goes to, by name. */
  connectTo?: string;
  kind: NodeType;
  name: string;
}

/** Where a proposal is; the bar, the chat line and the canvas all read this. */
export interface DockApply {
  error?: string;
  finishedAt?: number;
  phase: "applying" | "deployed" | "discarded" | "failed" | "proposed";
  runUrl?: string;
  sha?: string;
  startedAt?: number;
}

/** The writes of one answer, applied together with one press. */
export interface DockProposal {
  apply: DockApply;
  branch?: string;
  /** Each write still in, with dropped files left out of a commit. */
  changes: readonly PendingChange[];
  messageId: string;
  nodes: readonly ProposedNode[];
  stage?: string;
  title: string;
}

const OPEN_PHASES: ReadonlySet<DockApply["phase"]> = new Set([
  "applying",
  "failed",
  "proposed",
]);

const RUN_FAILURES: Record<string, string> = {
  cancelled: "the run was cancelled.",
  timed_out: "the run timed out.",
};

const TIERS: Record<CopilotAction["type"], CopilotTier> = {
  addMcp: "approval",
  addNode: "approval",
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

/** The proposal of each answer that has a write; a press applies all its changes at once. */
export function dockProposals(
  messages: readonly { id: string; plan?: CopilotPlan }[],
  dropped: ReadonlySet<string>,
  applies: Readonly<Record<string, DockApply>>,
  deploys: readonly TrackedDeploy[],
  stage?: string,
): Map<string, DockProposal> {
  const proposals = new Map<string, DockProposal>();
  for (const { id, plan } of messages) {
    const writes = (plan?.actions ?? []).flatMap((action, index) =>
      actionTier(action) === "approval"
        ? [{ action: action, index: index }]
        : [],
    );
    if (!plan || writes.length === 0) continue;
    const changes = writes.flatMap(({ action, index }): PendingChange[] => {
      if (dropped.has(changeKey(id, index))) return [];
      if (action.type !== "commitFiles") {
        return [{ action: action, index: index, messageId: id }];
      }
      const files = action.files.filter(
        (file) => !dropped.has(changeKey(id, index, file.path)),
      );

      return files.length === 0
        ? []
        : [
            {
              action: { ...action, files: files },
              index: index,
              messageId: id,
            },
          ];
    });
    const commit = plan.actions.find((action) => action.type === "commitFiles");
    const applied = applies[id];
    const apply: DockApply = applied
      ? withDeploy(
          applied,
          deploys.find(
            (deploy) => deploy.messageId === id && deploy.sha === applied.sha,
          ),
        )
      : { phase: changes.length > 0 ? "proposed" : "discarded" };
    proposals.set(id, {
      apply: apply,
      branch: commit?.branch,
      changes: changes,
      messageId: id,
      nodes: plan.nodes ?? [],
      stage: stage,
      title:
        commit?.message ||
        (writes.length === 1 ? writes[0].action.label : plan.summary),
    });
  }

  return proposals;
}

/** Keys a dropped change: a whole step, or one file of its commit. */
export function changeKey(
  messageId: string,
  index: number,
  path?: string,
): string {
  return path === undefined
    ? `${messageId}:${index}`
    : `${messageId}:${index}:${path}`;
}

/** The newest proposal still waiting or deploying, from answers asked on this scope. */
export function openProposal(
  messages: readonly { id: string; scope?: string }[],
  proposals: ReadonlyMap<string, DockProposal>,
  scope?: string,
): DockProposal | null {
  return (
    messages
      .filter(
        (message) => message.scope === undefined || message.scope === scope,
      )
      .map((message) => proposals.get(message.id))
      .findLast(
        (proposal) =>
          proposal !== undefined && OPEN_PHASES.has(proposal.apply.phase),
      ) ?? null
  );
}

/** The chat's record of a proposal, in the words the bar would use. */
export function applyStatus(proposal: DockProposal): {
  failed: boolean;
  text: string;
} {
  const { apply, branch } = proposal;
  const sha = apply.sha?.slice(0, 7);
  switch (apply.phase) {
    case "proposed":
      return {
        failed: false,
        text: "Proposed. Review it at the top of the canvas.",
      };
    case "applying":
      return {
        failed: false,
        text: sha ? `Committed ${sha} to ${branch}. Deploying.` : "Applying.",
      };
    case "deployed":
      if (apply.finishedAt !== undefined && apply.startedAt !== undefined) {
        const seconds = Math.max(
          1,
          Math.round((apply.finishedAt - apply.startedAt) / 1000),
        );

        return { failed: false, text: `Deployed in ${seconds} s.` };
      }

      return {
        failed: false,
        text: apply.runUrl ? "Opened a pull request." : "Applied.",
      };
    case "failed":
      return {
        failed: true,
        text: `Deploy failed: ${apply.error ?? "unknown error."}`,
      };
    case "discarded":
      return {
        failed: false,
        text: sha
          ? `Discarded. ${sha} stays on ${branch}.`
          : "Discarded. Nothing was changed.",
      };
  }
}

export function planRunsUnattended(plan: CopilotPlan): boolean {
  return plan.actions.every((action) => actionTier(action) === "safe");
}

// A commit's state comes from its GitHub run once one reports.
function withDeploy(apply: DockApply, deploy?: TrackedDeploy): DockApply {
  if (apply.phase !== "applying" || !deploy?.runUrl) return apply;
  if (deploy.state === "deployed") {
    return {
      ...apply,
      finishedAt: deploy.finishedAt,
      phase: "deployed",
      runUrl: deploy.runUrl,
    };
  }
  if (deploy.state === "failed") {
    return {
      ...apply,
      error: RUN_FAILURES[deploy.conclusion ?? ""] ?? "the run failed.",
      phase: "failed",
      runUrl: deploy.runUrl,
    };
  }

  return { ...apply, runUrl: deploy.runUrl };
}

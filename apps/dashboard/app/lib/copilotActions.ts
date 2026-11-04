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
  /** A failed run's last logged error line. */
  error?: string;
  finishedAt?: number;
  messageId: string;
  runUrl?: string;
  sha: string;
  state: "deployed" | "deploying" | "failed" | "waiting";
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
  /** Some of its steps already ran, so a discard cannot say nothing changed. */
  applied: boolean;
  branch?: string;
  /** Each write still in, with dropped files left out of a commit. */
  changes: readonly PendingChange[];
  messageId: string;
  nodes: readonly ProposedNode[];
  stage?: string;
  title: string;
}

const NO_NODES: readonly ProposedNode[] = [];

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
  messages: readonly { id: string; pending?: boolean; plan?: CopilotPlan }[],
  dropped: ReadonlySet<string>,
  completed: ReadonlySet<string>,
  applies: Readonly<Record<string, DockApply>>,
  deploys: readonly TrackedDeploy[],
  stage?: string,
): Map<string, DockProposal> {
  const proposals = new Map<string, DockProposal>();
  // An answer still streaming may propose again, so it offers nothing to apply yet.
  for (const { id, pending, plan } of messages) {
    if (pending) continue;
    const writes = (plan?.actions ?? []).flatMap((action, index) =>
      actionTier(action) === "approval"
        ? [{ action: action, index: index }]
        : [],
    );
    if (!plan || writes.length === 0) continue;
    const changes = writes.flatMap(({ action, index }): PendingChange[] => {
      if (dropped.has(changeKey(id, index))) return [];
      if (action.type !== "commitFiles") {
        return [{ action: action, index: index }];
      }
      const files = action.files.filter(
        (file) => !dropped.has(changeKey(id, index, file.path)),
      );

      return files.length === 0
        ? []
        : [{ action: { ...action, files: files }, index: index }];
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
    // Drawn nodes cannot follow a dropped file yet, so an edited proposal draws none.
    const edited = [...dropped].some((key) => key.startsWith(`${id}:`));
    proposals.set(id, {
      apply: apply,
      applied: writes.some(({ index }) => completed.has(changeKey(id, index))),
      branch: commit?.branch,
      changes: changes,
      messageId: id,
      nodes: edited ? NO_NODES : (plan.nodes ?? NO_NODES),
      stage: stage,
      title:
        commit?.message ||
        (writes.length === 1 ? writes[0].action.label : plan.summary),
    });
  }

  return proposals;
}

/** The architecture change a proposal makes: the one source the canvas draws it from. */
export function proposedNodes(
  proposal: DockProposal | null,
): readonly ProposedNode[] {
  return proposal && OPEN_PHASES.has(proposal.apply.phase)
    ? proposal.nodes
    : NO_NODES;
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
export function applyStatus({ apply, applied, branch }: DockProposal): string {
  const sha = apply.sha?.slice(0, 7);
  switch (apply.phase) {
    case "proposed":
      return "Proposed. Review it at the top of the canvas.";
    case "applying":
      return sha ? `Committed ${sha} to ${branch}. Deploying.` : "Applying.";
    case "deployed":
      if (apply.finishedAt !== undefined && apply.startedAt !== undefined) {
        return `Deployed in ${Math.max(1, Math.round((apply.finishedAt - apply.startedAt) / 1000))} s.`;
      }

      return apply.runUrl ? "Opened a pull request." : "Applied.";
    case "failed":
      return `Deploy failed: ${apply.error ?? "unknown error."}`;
    case "discarded":
      if (sha) return `Discarded. ${sha} stays on ${branch}.`;

      return applied
        ? "Discarded. Steps already applied stay."
        : "Discarded. Nothing was changed.";
  }
}

/** Applies whose run finished, kept so a later push cannot reopen them; null if none. */
export function settleApplies(
  applies: Readonly<Record<string, DockApply>>,
  deploys: readonly TrackedDeploy[],
): Readonly<Record<string, DockApply>> | null {
  let settled: Record<string, DockApply> | null = null;
  for (const deploy of deploys) {
    const apply = applies[deploy.messageId];
    if (apply?.phase !== "applying" || apply.sha !== deploy.sha) continue;
    const next = withDeploy(apply, deploy);
    if (next.phase !== "applying") {
      settled = { ...(settled ?? applies), [deploy.messageId]: next };
    }
  }

  return settled;
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
      error:
        deploy.error ??
        RUN_FAILURES[deploy.conclusion ?? ""] ??
        "the run failed.",
      phase: "failed",
      runUrl: deploy.runUrl,
    };
  }

  return { ...apply, runUrl: deploy.runUrl };
}

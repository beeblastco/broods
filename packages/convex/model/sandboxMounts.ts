// Out of agentRules: the canvas checks mounts on first load and must not bundle the schemas.
import type { AgentWorkspaceRef } from "./agentRules";

export type LaterSandboxMount = {
  index: number;
  sandboxId: string;
  workspace: AgentWorkspaceRef;
};

export function findLaterSandboxMount(
  sandboxes: readonly string[],
  workspaces: readonly AgentWorkspaceRef[] | null | undefined,
): LaterSandboxMount | undefined {
  for (const [index, sandboxId] of sandboxes.entries()) {
    const workspace = workspaceOnLaterSandbox(sandboxes, index, workspaces);
    if (workspace) {
      return { index: index, sandboxId: sandboxId, workspace: workspace };
    }
  }

  return undefined;
}

// Only the first sandbox mounts workspaces; a later one runs with none.
export function workspaceOnLaterSandbox(
  sandboxes: readonly string[],
  index: number,
  workspaces: readonly AgentWorkspaceRef[] | null | undefined,
): AgentWorkspaceRef | undefined {
  return index === 0
    ? undefined
    : (workspaces ?? undefined)?.find(
        (ref): boolean => ref.sandbox === sandboxes[index],
      );
}

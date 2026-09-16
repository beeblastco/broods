"use client";

/**
 * Workspace node for a standalone broods workspaceConfig record, referenced by
 * agent config `workspaces[].workspaceId`. Inside a frame it draws as a chip
 * whose status line is the workspace's effective-sandbox state.
 */
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import {
  ResourceChip,
  type ChipStatus,
} from "@/app/components/node/ResourceChip";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";

/** One word per effective-sandbox state, shared with the collapsed frame summary. */
export const WORKSPACE_STATE_LABEL: Record<
  WorkspaceSandboxState["kind"],
  string
> = {
  inherited: "inherited",
  override: "mounted",
  readonly: "read-only",
};

export function WorkspaceNode({
  id,
  data,
  parentId,
}: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const state = useInfraAnalysis().workspaceStates[id];

  if (parentId !== undefined) {
    return (
      <ResourceChip
        icon={<FolderOpen className="size-3.5" />}
        label={nodeData.label}
        mountable={true}
        nodeType="workspace"
        status={workspaceChipStatus(state)}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="workspace"
      data={nodeData}
      icon={<FolderOpen className="size-3.5" />}
      showSideHandles={true}
    />
  );
}

function workspaceChipStatus(
  state: WorkspaceSandboxState | undefined,
): ChipStatus {
  if (!state) return { color: "bg-muted-foreground", text: "Idle" };
  if (state.kind === "readonly") {
    return { color: "bg-warning", text: WORKSPACE_STATE_LABEL.readonly };
  }
  const sandbox =
    state.kind === "override"
      ? state.sandboxLabels.join(", ")
      : state.sandboxLabel;

  return {
    color:
      state.kind === "override" ? "bg-canvas-mount" : "bg-muted-foreground",
    text: `↳ ${sandbox} · ${WORKSPACE_STATE_LABEL[state.kind]}`,
  };
}

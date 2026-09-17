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
import { workspaceMemberStatus } from "@/app/lib/memberStatus";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";

export function WorkspaceNode({
  id,
  data,
  parentId,
}: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const infraAnalysis = useInfraAnalysis();
  const state = infraAnalysis.workspaceStates[id];
  const sharedCount = infraAnalysis.agentRefCounts[id] ?? 0;

  if (parentId !== undefined) {
    return (
      <ResourceChip
        icon={<FolderOpen className="size-3.5" />}
        label={nodeData.label}
        mountable={true}
        nodeType="workspace"
        note={sharedCount > 1 ? `shared ×${sharedCount}` : undefined}
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

/** The member status, with the sandbox it runs on in front of mounted or inherited. */
function workspaceChipStatus(
  state: WorkspaceSandboxState | undefined,
): ChipStatus {
  const status = workspaceMemberStatus(state);
  if (!state || state.kind === "readonly") {
    return { color: status.color, text: status.label };
  }
  const sandbox =
    state.kind === "override"
      ? state.sandboxLabels.join(", ")
      : state.sandboxLabel;

  return { color: status.color, text: `↳ ${sandbox} · ${status.label}` };
}

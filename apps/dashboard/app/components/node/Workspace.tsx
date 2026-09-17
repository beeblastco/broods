"use client";

/**
 * Workspace node for a standalone broods workspaceConfig record, referenced by
 * agent config `workspaces[].workspaceId`. Inside a frame it draws as a chip
 * whose status line is the workspace's effective-sandbox state; as a card its
 * status row says the same.
 */
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import {
  BaseNode,
  statusConfig,
  type BaseNodeData,
} from "@/app/components/node/BaseNode";
import {
  ResourceChip,
  type ChipStatus,
} from "@/app/components/node/ResourceChip";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import { workspaceMemberStatus } from "@/app/lib/memberStatus";
import { workspaceStateText } from "@broods/convex/model/canvasLayout";
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
  const status = workspaceChipStatus(state);

  if (parentId !== undefined) {
    return (
      <ResourceChip
        icon={<FolderOpen className="size-3.5" />}
        label={nodeData.label}
        mountable={true}
        nodeType="workspace"
        note={sharedCount > 1 ? `shared ×${sharedCount}` : undefined}
        status={status}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="workspace"
      data={nodeData}
      icon={<FolderOpen className="size-3.5" />}
      // The state line already says mounted, inherited or read-only; the status
      // row says only the run state, in the state's color.
      liveStatus={{
        color: status.color,
        label: statusConfig[nodeData.status ?? "idle"].text,
      }}
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

  return {
    color: status.color,
    text: `↳ ${workspaceStateText(state.kind, state.sandboxLabels)}`,
    title: state.sandboxLabels.join(", "),
  };
}

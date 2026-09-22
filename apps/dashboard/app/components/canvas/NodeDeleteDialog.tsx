"use client";

import type { NodeType } from "@/app/components/canvas/nodeTemplates";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { useNodeOwnership } from "@/app/hooks/useNodeOwnership";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useAction, useMutation } from "convex/react";
import { useParams } from "next/navigation";
import { useState } from "react";

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  agent: "agent",
  mcp: "MCP server",
  sandbox: "sandbox",
  skill: "skill",
  workspace: "workspace",
};

/**
 * Confirm and delete one canvas card, wherever the delete was asked for: the
 * card's right-click menu or the side panel's Danger Zone. It owns the delete,
 * so the menu no longer has to open the panel to reach it. Stays shut while code
 * owns the card, and refuses the delete itself while ownership is still loading.
 */
export function NodeDeleteDialog({
  node,
  open,
  onOpenChange,
  onRemoved,
}: {
  node: Node;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: (nodeId: string) => void;
}): React.JSX.Element {
  const { stageId } = useStage();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const { agentConfig, isCodeManaged, isOwnershipLoading } =
    useNodeOwnership(node);
  const removeConfig = useMutation(api.agent.config.remove);
  const removeMcpForNode = useAction(api.mcp.removeForNode);
  const [isDeleting, setIsDeleting] = useState(false);

  const nodeData = node.data as BaseNodeData | undefined;
  const nodeType = (node.type ?? "agent") as NodeType;
  const isAgent = nodeType === "agent";
  const agentConfigId = nodeData?.agentConfigId as
    | Id<"agentConfigs">
    | undefined;

  /** Deletes the card and the row behind it; no-op while code owns it. */
  async function handleDelete(): Promise<void> {
    if (isCodeManaged || isOwnershipLoading) return;
    setIsDeleting(true);
    try {
      if (isAgent && agentConfigId) {
        await removeConfig({ configId: agentConfigId });
      }
      if (nodeType === "mcp" && projectId && stageId) {
        await removeMcpForNode({
          nodeId: node.id,
          projectId: projectId,
          stageId: stageId,
        });
      }
      onRemoved(node.id);
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <DeleteConfirmDialog
      open={open && !isCodeManaged}
      onOpenChange={onOpenChange}
      resourceName={(isAgent ? agentConfig?.name : nodeData?.label) ?? ""}
      resourceType={NODE_TYPE_LABELS[nodeType] ?? "node"}
      critical={false}
      onConfirm={handleDelete}
      isDeleting={isDeleting}
    />
  );
}

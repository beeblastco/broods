"use client";

/**
 * Workspace node — represents a standalone filthy-panty workspaceConfig record
 * referenced by agent config `workspaces[].workspaceId`.
 */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";

export function WorkspaceNode({ id, data }: NodeProps) {
    const nodeData = data as BaseNodeData;

    return (
        <BaseNode
            id={id}
            nodeType="workspace"
            data={nodeData}
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            showSideHandles={true}
        />
    );
}

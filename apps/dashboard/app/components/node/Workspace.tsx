"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";

/** Workspace node representing a shared workspace on the canvas. */
export function WorkspaceNode({ id, data }: NodeProps) {
    return <BaseNode id={id} nodeType="workspace" data={data as BaseNodeData} icon={<FolderOpen className="h-3.5 w-3.5" />} />;
}

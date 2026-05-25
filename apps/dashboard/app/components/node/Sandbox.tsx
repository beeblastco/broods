"use client";

/** Sandbox node — attached to a workspace, surfaces `workspace.sandbox` config. */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Box } from "lucide-react";

export function SandboxNode({ id, data }: NodeProps) {
    return (
        <BaseNode
            id={id}
            nodeType="sandbox"
            data={data as BaseNodeData}
            icon={<Box className="h-3.5 w-3.5" />}
        />
    );
}

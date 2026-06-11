"use client";

/**
 * Sandbox node representing a standalone filthy-panty sandboxConfig record.
 */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Box } from "lucide-react";
import { useMemo } from "react";

/** Sandbox node displayed on the architecture canvas. */
export function SandboxNode({ id, data }: NodeProps) {
    const nodeData = data as BaseNodeData;
    const featureRows = useMemo(() => {
        if (nodeData.config?.persistent !== true) {
            return undefined;
        }

        return [{ key: "persistent", label: "persistent" }];
    }, [nodeData.config?.persistent]);

    return (
        <BaseNode
            id={id}
            nodeType="sandbox"
            data={nodeData}
            icon={<Box className="h-3.5 w-3.5" />}
            featureRows={featureRows}
            showSideHandles={true}
        />
    );
}

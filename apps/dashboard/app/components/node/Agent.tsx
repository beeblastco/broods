"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";

/** Default color for agent nodes that were created before the color property existed. */
const DEFAULT_AGENT_COLOR = "rgb(168, 85, 247)";

/** Agent node representing an AI agent on the canvas. */
export function AgentNode({ data }: NodeProps) {
    const nodeData = data as BaseNodeData;
    const withColor: BaseNodeData = {
        ...nodeData,
        properties: nodeData.properties ?? { color: DEFAULT_AGENT_COLOR },
    };

    return <BaseNode data={withColor} icon={null} />;
}

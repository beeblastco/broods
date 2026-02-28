"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useAgentHealth } from "@/app/hooks/useAgentHealth";
import type { Id } from "@/convex/_generated/dataModel";
import type { NodeProps } from "@xyflow/react";

/** Default color for agent nodes that were created before the color property existed. */
const DEFAULT_AGENT_COLOR = "rgb(168, 85, 247)";

/** Agent node representing an AI agent on the canvas with live health status. */
export function AgentNode({ id, data }: NodeProps) {
    const nodeData = data as BaseNodeData;
    const agentConfigId = nodeData.agentConfigId as Id<"agentConfigs"> | undefined;
    const healthStatus = useAgentHealth(agentConfigId);
    const withColor: BaseNodeData = {
        ...nodeData,
        properties: nodeData.properties ?? { color: DEFAULT_AGENT_COLOR },
    };

    return <BaseNode id={id} nodeType="agent" data={withColor} icon={null} agentStatus={healthStatus} />;
}

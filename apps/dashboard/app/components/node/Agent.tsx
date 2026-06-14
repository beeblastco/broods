"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useAgentHealth } from "@/app/hooks/useAgentHealth";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import type { NodeProps } from "@xyflow/react";
import { useMemo } from "react";

/** Default color for agent nodes that were created before the color property existed. */
const DEFAULT_AGENT_COLOR = "rgb(168, 85, 247)";

type OutputFormatConfig = {
    type?: string;
    schema?: unknown;
};

/** Returns whether the agent config is using a non-text model output format. */
function isStructuredOutputEnabled(outputFormat: unknown): boolean {
    if (!outputFormat || typeof outputFormat !== "object" || Array.isArray(outputFormat)) {
        return false;
    }

    const { type } = outputFormat as OutputFormatConfig;

    return type === undefined || type === "json_schema" || type === "object" || type === "array" || type === "choice" || type === "json";
}

/** Agent node representing an AI agent on the canvas. */
export function AgentNode({ id, data }: NodeProps) {
    const nodeData = data as BaseNodeData;
    const agentConfigId = nodeData.agentConfigId as Id<"agentConfigs"> | undefined;
    const healthStatus = useAgentHealth(agentConfigId);
    const agentConfig = useQuery(
        api.agentConfig.getById,
        agentConfigId ? { configId: agentConfigId } : "skip",
    );
    const featureRows = useMemo(() => {
        if (!isStructuredOutputEnabled(agentConfig?.outputFormat)) {
            return undefined;
        }

        return [{ key: "structured-output", label: "structured output" }];
    }, [agentConfig?.outputFormat]);
    const withColor: BaseNodeData = {
        ...nodeData,
        properties: nodeData.properties ?? { color: DEFAULT_AGENT_COLOR },
    };

    return (
        <BaseNode
            id={id}
            nodeType="agent"
            data={withColor}
            icon={null}
            agentStatus={healthStatus}
            featureRows={featureRows}
            showSideHandles={true}
        />
    );
}

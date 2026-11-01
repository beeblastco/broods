"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useAgentHealth } from "@/app/hooks/useAgentHealth";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { NodeProps } from "@xyflow/react";
import { useMemo } from "react";

/** Default color for agent nodes that were created before the color property existed. */
const DEFAULT_AGENT_COLOR = "rgb(168, 85, 247)";

export function AgentNode({ id, data }: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const agentConfigId = nodeData.agentConfigId as
    | Id<"agentConfigs">
    | undefined;
  const healthStatus = useAgentHealth(agentConfigId);
  // The canvas reads every card's badges in one query; the full config is
  // only read by the side panel.
  const { agentBadges } = useCanvasFrames();
  const badge = agentConfigId ? agentBadges?.[agentConfigId] : undefined;
  const structuredOutput = badge?.structuredOutput === true;
  const featureRows = useMemo(
    () =>
      structuredOutput
        ? [{ key: "structured-output", label: "structured output" }]
        : undefined,
    [structuredOutput],
  );
  // Surface the secure-by-default public-access opt-in so the node's globe can
  // reflect it (green only when the agent is actually reachable publicly).
  const withColor: BaseNodeData = {
    ...nodeData,
    config: { ...nodeData.config, publicAccess: badge?.publicAccess === true },
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

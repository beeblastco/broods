"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useAgentHealth } from "@/app/hooks/useAgentHealth";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  agentProviderLabel,
  type AgentVoice,
} from "@broods/convex/model/modelProviders";
import type { NodeProps } from "@xyflow/react";
import { Mic } from "lucide-react";
import { useMemo } from "react";

const DEFAULT_AGENT_COLOR = "rgb(168, 85, 247)";

export function AgentNode({ id, data }: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const agentConfigId = nodeData.agentConfigId as
    | Id<"agentConfigs">
    | undefined;
  const healthStatus = useAgentHealth(agentConfigId);
  // Badges come from the canvas's one query; only the side panel reads the full config.
  const { agentBadges } = useCanvasFrames();
  const badge = agentConfigId ? agentBadges?.[agentConfigId] : undefined;
  const structuredOutput = badge?.structuredOutput === true;
  const voice = (badge?.voice ?? null) as AgentVoice | null;
  const voiceLabel = voice
    ? voice.native
      ? "native"
      : agentProviderLabel(voice.provider)
    : null;
  const featureRows = useMemo(
    () => [
      ...(voiceLabel
        ? [
            {
              key: "voice",
              icon: <Mic className="inline size-3 align-[-2px]" />,
              label: voiceLabel,
            },
          ]
        : []),
      ...(structuredOutput
        ? [{ key: "structured-output", label: "structured output" }]
        : []),
    ],
    [structuredOutput, voiceLabel],
  );
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

"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useReachableAgentConfigId } from "@/app/hooks/useConnectedAgentConfig";
import { enabledMemberStatus } from "@/app/lib/memberStatus";
import { includesSkillRef } from "@/app/lib/skillRefs";
import type { NodeProps } from "@xyflow/react";
import { Sparkles } from "lucide-react";

export function SkillNode({ id, data }: NodeProps): React.JSX.Element {
  const baseData = data as BaseNodeData;
  const agentConfigId = useReachableAgentConfigId(id);
  const { agentBadges } = useCanvasFrames();
  const badge = agentConfigId ? agentBadges?.[agentConfigId] : undefined;
  const path = (baseData.label ?? "").trim();
  const enabled =
    badge !== undefined && path !== "" && includesSkillRef(badge.skills, path);

  return (
    <BaseNode
      id={id}
      nodeType="skill"
      data={baseData}
      icon={<Sparkles className="size-3.5" />}
      liveStatus={badge ? enabledMemberStatus(enabled) : undefined}
    />
  );
}

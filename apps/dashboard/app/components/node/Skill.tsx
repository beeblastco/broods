"use client";

/** Skill node — Enabled when its label is in the connected agent's `skills.allowed[]`. */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import {
  readAgentBranch,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { includesSkillRef } from "@/app/lib/skillRefs";
import type { NodeProps } from "@xyflow/react";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";

type SkillsSlice = { enabled?: boolean; allowed?: string[] };

export function SkillNode({ id, data }: NodeProps) {
  const baseData = data as BaseNodeData;
  const { agentConfig } = useConnectedAgentConfig(id);
  const path = (baseData.label ?? "").trim();

  const enabled = useMemo(() => {
    if (!path) return false;
    const skills = readAgentBranch<SkillsSlice>(
      agentConfig as FlatAgentConfig | undefined,
      "skills",
    );
    if (skills.enabled !== true) return false;

    return includesSkillRef(skills.allowed, path);
  }, [agentConfig, path]);

  return (
    <BaseNode
      id={id}
      nodeType="skill"
      data={baseData}
      icon={<Sparkles className="h-3.5 w-3.5" />}
      cardStatus={agentConfig ? { enabled: enabled } : undefined}
    />
  );
}

"use client";

/** Skill node — configuration-based card wired into an agent's `skills.<name>`. */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Sparkles } from "lucide-react";

export function SkillNode({ id, data }: NodeProps) {
    return (
        <BaseNode
            id={id}
            nodeType="skill"
            data={data as BaseNodeData}
            icon={<Sparkles className="h-3.5 w-3.5" />}
        />
    );
}

"use client";

/**
 * Skill card Config tab: edits the entry under `skills.<nodeLabel>` of the
 * connected agent. Skill name comes from the card label so renaming the card
 * renames the key.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { toNestedAgentConfig, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

const PLACEHOLDER = JSON.stringify(
    {
        enabled: true,
        description: "",
    },
    null,
    2,
);

export function SkillConfigTab({
    nodeId,
    nodeLabel,
}: {
    nodeId: string;
    nodeLabel: string;
}) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const skillKey = nodeLabel.trim() || nodeId;

    const skill = useMemo(() => {
        if (!agentConfig) return undefined;
        const nested = toNestedAgentConfig(agentConfig as FlatAgentConfig) as Record<string, unknown>;
        const skills = nested.skills as Record<string, unknown> | undefined;

        return skills?.[skillKey] ?? {};
    }, [agentConfig, skillKey]);

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Wire this skill to an agent to edit its config.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            <p className="text-[11px] text-muted-foreground/70">
                Stored under <code className="rounded bg-muted px-1">skills.{skillKey}</code>
            </p>
            <BranchEditor
                title="Skill"
                description="enabled · description · options"
                value={skill}
                placeholder={PLACEHOLDER}
                onSave={async (value) => {
                    const nested = toNestedAgentConfig(agentConfig as FlatAgentConfig) as Record<string, unknown>;
                    const skills: Record<string, unknown> = {
                        ...((nested.skills as Record<string, unknown> | undefined) ?? {}),
                    };
                    if (value === undefined) {
                        delete skills[skillKey];
                    } else {
                        skills[skillKey] = value;
                    }
                    await updateBranch(["skills"], Object.keys(skills).length > 0 ? skills : undefined);
                }}
            />
        </div>
    );
}

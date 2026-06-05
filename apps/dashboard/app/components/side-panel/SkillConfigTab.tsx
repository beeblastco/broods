"use client";

/**
 * Skill Config tab — raw JSON editor for the connected agent's `skills` branch,
 * matching the Agent and Workspace cards' Config tabs so power users can edit
 * the whole slice (enabled · allowed · publish) directly.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

export function SkillConfigTab({ nodeId }: { nodeId: string }) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const skills = useMemo(
        () => readAgentBranch(agentConfig as FlatAgentConfig | undefined, "skills"),
        [agentConfig],
    );

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Wire this skill to an agent to edit its configuration.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <BranchEditor
                title="Skills"
                description="enabled · allowed · publish"
                value={skills}
                onSave={(v) => updateBranch(["skills"], v)}
            />
        </div>
    );
}

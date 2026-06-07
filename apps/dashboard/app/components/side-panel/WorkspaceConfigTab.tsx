"use client";

/**
 * Workspace Config tab — raw JSON editor for the connected agent's `workspace`
 * branch, matching the Agent card's Config tab so power users can edit the
 * whole slice (namespace / harness / workspaces / storage / sandbox) directly.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

export function WorkspaceConfigTab({ nodeId }: { nodeId: string }) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const workspace = useMemo(
        () => readAgentBranch(agentConfig as FlatAgentConfig | undefined, "workspace"),
        [agentConfig],
    );

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Wire this workspace to an agent to edit its configuration.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <BranchEditor
                title="Workspace"
                value={workspace}
                onSave={(v) => updateBranch(["workspace"], v)}
            />
        </div>
    );
}

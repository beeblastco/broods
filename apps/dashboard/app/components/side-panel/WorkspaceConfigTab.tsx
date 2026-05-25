"use client";

/**
 * Workspace card Config tab: edits the `workspace` slice of the connected
 * agent's nested config (enabled/needsApproval/memory/filesystem/tasks).
 * Sandbox lives in its own card and edits `workspace.sandbox` directly.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { toNestedAgentConfig, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

const PLACEHOLDER = JSON.stringify(
    {
        enabled: true,
        needsApproval: false,
        memory: { enabled: false },
        filesystem: { enabled: false },
        tasks: { enabled: false },
    },
    null,
    2,
);

export function WorkspaceConfigTab({ nodeId }: { nodeId: string }) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);

    const workspace = useMemo(() => {
        if (!agentConfig) return undefined;
        const nested = toNestedAgentConfig(agentConfig as FlatAgentConfig) as Record<string, unknown>;
        const ws = nested.workspace;
        if (ws && typeof ws === "object" && !Array.isArray(ws)) {
            const { sandbox: _unused, ...rest } = ws as Record<string, unknown>;
            void _unused;

            return rest;
        }

        return {};
    }, [agentConfig]);

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Wire this workspace to an agent to edit its workspace config.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            <BranchEditor
                title="Workspace"
                description="memory · filesystem · tasks · approval"
                value={workspace}
                placeholder={PLACEHOLDER}
                onSave={async (value) => {
                    const current = (toNestedAgentConfig(agentConfig as FlatAgentConfig) as Record<string, unknown>)
                        .workspace as Record<string, unknown> | undefined;
                    const sandbox = current && typeof current === "object" ? current.sandbox : undefined;
                    const next: Record<string, unknown> =
                        value && typeof value === "object" && !Array.isArray(value)
                            ? { ...(value as Record<string, unknown>) }
                            : {};
                    if (sandbox !== undefined) next.sandbox = sandbox;
                    await updateBranch(["workspace"], Object.keys(next).length > 0 ? next : undefined);
                }}
            />
        </div>
    );
}

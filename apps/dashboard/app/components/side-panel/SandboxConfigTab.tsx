"use client";

/**
 * Sandbox card Config tab: edits `workspace.sandbox` on the agent reachable
 * through a connected workspace card (sandbox -> workspace -> agent).
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { toNestedAgentConfig, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

const PLACEHOLDER = JSON.stringify(
    {
        enabled: true,
        provider: "e2b",
        timeout: 60000,
        memoryLimit: 512,
        options: {},
    },
    null,
    2,
);

const TRAVERSE = ["workspace"] as const;

export function SandboxConfigTab({ nodeId }: { nodeId: string }) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId, TRAVERSE);

    const sandbox = useMemo(() => {
        if (!agentConfig) return undefined;
        const nested = toNestedAgentConfig(agentConfig as FlatAgentConfig) as Record<string, unknown>;
        const ws = nested.workspace as Record<string, unknown> | undefined;

        return ws && typeof ws === "object" ? (ws.sandbox ?? {}) : {};
    }, [agentConfig]);

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Attach this sandbox to a workspace wired to an agent.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            <BranchEditor
                title="Sandbox"
                description="provider · timeout · memoryLimit · options"
                value={sandbox}
                placeholder={PLACEHOLDER}
                onSave={(value) => updateBranch(["workspace", "sandbox"], value)}
            />
        </div>
    );
}

"use client";

/**
 * Workspace node — Enabled/Disabled pill mirrors `workspace.enabled` on the
 * connected agent; the card body lists `+ memory / + tasks / + storage /
 * + sandbox` rows for each subsection that is currently configured.
 */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";
import { useMemo } from "react";

type WorkspaceSlice = {
    enabled?: boolean;
    memory?: { enabled?: boolean };
    tasks?: { enabled?: boolean };
    storage?: { provider?: string };
    sandbox?: { provider?: string };
};

export function WorkspaceNode({ id, data }: NodeProps) {
    const { agentConfig } = useConnectedAgentConfig(id);

    const workspace = useMemo(
        () => readAgentBranch<WorkspaceSlice>(agentConfig as FlatAgentConfig | undefined, "workspace"),
        [agentConfig],
    );

    const featureRows = useMemo(() => {
        const rows: { key: string; label: string }[] = [];

        if (workspace.memory?.enabled) {
            rows.push({ key: "memory", label: "memory" });
        }
        if (workspace.tasks?.enabled) {
            rows.push({ key: "tasks", label: "tasks" });
        }
        if (workspace.storage?.provider) {
            rows.push({ key: "storage", label: `storage (${workspace.storage.provider})` });
        }
        if (workspace.sandbox) {
            const provider = workspace.sandbox.provider;
            const label = provider ? `sandbox (${provider})` : "sandbox";
            rows.push({ key: "sandbox", label: label });
        }

        return rows;
    }, [workspace]);

    return (
        <BaseNode
            id={id}
            nodeType="workspace"
            data={data as BaseNodeData}
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            cardStatus={agentConfig ? { enabled: workspace.enabled !== false } : undefined}
            featureRows={featureRows.length > 0 ? featureRows : undefined}
        />
    );
}

"use client";

/**
 * Workspace node — Enabled/Disabled pill mirrors `workspace.enabled` on the
 * connected agent; the card body lists `+ namespace / + harness / + workspaces /
 * + storage / + sandbox` rows for each subsection that is currently configured.
 */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import type { NodeProps } from "@xyflow/react";
import { FolderOpen } from "lucide-react";
import { useMemo } from "react";

type WorkspaceSlice = {
    enabled?: boolean;
    namespace?: string;
    harness?: { enabled?: boolean };
    workspaces?: Record<string, unknown>;
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

        if (workspace.namespace) {
            rows.push({ key: "namespace", label: `namespace (${workspace.namespace})` });
        }
        if (workspace.harness?.enabled) {
            rows.push({ key: "harness", label: "harness" });
        }
        const workspaceCount = workspace.workspaces ? Object.keys(workspace.workspaces).length : 0;
        if (workspaceCount > 0) {
            rows.push({ key: "workspaces", label: `workspaces (${workspaceCount})` });
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

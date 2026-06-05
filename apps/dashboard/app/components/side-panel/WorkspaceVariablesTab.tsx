"use client";

/**
 * Workspace Variables tab — edits the connected agent's runtime environment
 * variables, reusing the Agent card's Variables editor. Workspace and sandbox
 * code run with the same agent runtime, so they share one variable set.
 */
import { VariablesTab } from "@/app/components/side-panel/VariablesTab";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import { isRuntimeVariable, type RuntimeVariable } from "@/app/lib/runtimeVariables";
import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useMemo, useState } from "react";

export function WorkspaceVariablesTab({ nodeId }: { nodeId: string }) {
    const { agentConfigId, agentConfig } = useConnectedAgentConfig(nodeId);
    const updateConfig = useMutation(api.agentConfig.update).withOptimisticUpdate(applyAgentConfigUpdate);
    const [isSaving, setIsSaving] = useState(false);

    const runtimeVariables = useMemo<RuntimeVariable[]>(
        () =>
            Array.isArray(agentConfig?.runtimeVariables)
                ? agentConfig.runtimeVariables.filter(isRuntimeVariable)
                : [],
        [agentConfig],
    );

    if (!agentConfig || !agentConfigId) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Wire this workspace to an agent to edit its variables.
                </p>
            </div>
        );
    }

    async function handleSave(next: RuntimeVariable[]) {
        if (!agentConfigId) return;

        setIsSaving(true);
        try {
            await updateConfig({ configId: agentConfigId, runtimeVariables: next });
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <VariablesTab
            key={`${agentConfigId}-${JSON.stringify(runtimeVariables)}`}
            runtimeVariables={runtimeVariables}
            isSaving={isSaving}
            onSave={handleSave}
        />
    );
}

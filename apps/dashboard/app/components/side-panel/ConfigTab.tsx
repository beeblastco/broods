"use client";

/**
 * Agent Config tab split across the three filthy-panty AgentConfig branches
 * that belong to an agent card: `agent` (behavior), `model`, and `provider`.
 * Each section is a self-contained branch editor that saves independently.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import {
    fromNestedAgentConfig,
    toNestedAgentConfig,
    type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import type { Id } from "@/convex/_generated/dataModel";
import { useMemo } from "react";

export function ConfigTab({
    agentConfig,
    onSaveBranch,
}: {
    agentConfig: (FlatAgentConfig & { _id?: Id<"agentConfigs"> }) | null | undefined;
    onSaveBranch: (branch: "agent" | "model" | "provider", value: unknown) => Promise<void>;
}) {
    const nested = useMemo(
        () => (agentConfig ? toNestedAgentConfig(agentConfig) : {}),
        [agentConfig],
    );

    if (!agentConfig) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Loading agent configuration…
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <BranchEditor
                title="Agent"
                description="behavior · system · maxTurn"
                value={(nested as Record<string, unknown>).agent ?? {}}
                onSave={(v) => onSaveBranch("agent", v)}
            />
            <BranchEditor
                title="Model"
                description="provider · modelId · options · output"
                value={(nested as Record<string, unknown>).model ?? {}}
                onSave={(v) => onSaveBranch("model", v)}
            />
            <BranchEditor
                title="Provider"
                description="per-provider credentials & endpoints"
                value={(nested as Record<string, unknown>).provider ?? {}}
                onSave={(v) => onSaveBranch("provider", v)}
            />
        </div>
    );
}

/**
 * Builds the patch passed to `api.agentConfig.update` after writing a single
 * branch back into the nested view of an agent config.
 */
export function buildBranchPatch(
    agentConfig: FlatAgentConfig,
    branch: string,
    value: unknown,
) {
    const nested = toNestedAgentConfig(agentConfig) as Record<string, unknown>;
    if (value === undefined) {
        delete nested[branch];
    } else {
        nested[branch] = value;
    }

    return fromNestedAgentConfig(nested);
}

"use client";

/**
 * Session (database) node Details tab — the agent's conversation persists automatically;
 * this surfaces the only tunable knobs: context pruning and compaction.
 */
import { ExpandBlock, ToggleRow } from "@/app/components/side-panel/ConfigControls";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { Database } from "lucide-react";
import { useMemo } from "react";

/** filthy-panty default + ceiling for compaction's serialized-character budget. */
const DEFAULT_MAX_CONTEXT_LENGTH = 100_000;
const MAX_CONTEXT_LENGTH_LIMIT = 500_000;

type SessionSlice = {
    pruning?: { enabled?: boolean };
    compaction?: { enabled?: boolean; maxContextLength?: number };
};

/** Session node Details tab — persistent-memory explainer plus pruning/compaction controls. */
export function SessionDetailsTab({
    nodeId,
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSaving,
}: {
    nodeId: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSaving: boolean;
}) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const session = useMemo(
        () => readAgentBranch<SessionSlice>(agentConfig as FlatAgentConfig | undefined, "session"),
        [agentConfig],
    );

    const disabled = !agentConfig;
    // Pruning is on unless explicitly false; compaction is off unless explicitly true.
    const pruningEnabled = session.pruning?.enabled !== false;
    const compactionEnabled = session.compaction?.enabled === true;
    const maxContextLength = session.compaction?.maxContextLength ?? DEFAULT_MAX_CONTEXT_LENGTH;

    /** Clamp + persist the compaction character budget, ignoring non-numeric input. */
    function setMaxContextLength(raw: string) {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.min(Math.max(Math.round(parsed), 1), MAX_CONTEXT_LENGTH_LIMIT);

        void updateBranch(["session", "compaction", "maxContextLength"], clamped);
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</span>
                <div className="flex items-center gap-2">
                    <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 text-sm"
                        onKeyDown={(e) => {
                            if (e.key === "Enter") onSaveName();
                        }}
                    />
                    {nameChanged && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 shrink-0 cursor-pointer text-xs disabled:cursor-not-allowed"
                            disabled={!editName.trim() || isSaving}
                            onClick={onSaveName}
                        >
                            Save
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <Database className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                    The connected agent&rsquo;s conversation is saved automatically and kept across turns, so
                    follow-ups continue the same thread. Persistence is always on &mdash; tune how the history is
                    trimmed below.
                </p>
            </div>

            {disabled ? (
                <p className="text-xs text-muted-foreground">Wire this session store to an agent to tune retention.</p>
            ) : (
                <div className="flex flex-col gap-3">
                    <SectionHeader>Retention</SectionHeader>
                    <ToggleRow
                        label="Pruning"
                        description="Strip stale reasoning and tool clutter from the model's view each turn."
                        checked={pruningEnabled}
                        disabled={disabled}
                        onCheckedChange={(next) => updateBranch(["session", "pruning", "enabled"], next)}
                    />
                    <ToggleRow
                        label="Compaction"
                        description="Summarize older history once it grows past a size budget."
                        checked={compactionEnabled}
                        disabled={disabled}
                        onCheckedChange={(next) => updateBranch(["session", "compaction", "enabled"], next)}
                    />
                    {compactionEnabled && (
                        <ExpandBlock>
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] font-medium text-foreground">Max context length</span>
                                <span className="text-[11px] text-muted-foreground">
                                    Serialized characters before compaction triggers (1&ndash;{MAX_CONTEXT_LENGTH_LIMIT.toLocaleString()}).
                                </span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={MAX_CONTEXT_LENGTH_LIMIT}
                                    defaultValue={maxContextLength}
                                    key={maxContextLength}
                                    className="h-8 font-mono text-xs"
                                    onBlur={(e) => setMaxContextLength(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") setMaxContextLength((e.target as HTMLInputElement).value);
                                    }}
                                />
                            </div>
                        </ExpandBlock>
                    )}
                </div>
            )}
        </div>
    );
}

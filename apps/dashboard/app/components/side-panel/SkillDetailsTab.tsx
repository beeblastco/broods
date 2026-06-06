"use client";

/**
 * Skill card Details tab — the card label is one entry in the connected agent's
 * `skills.allowed[]`. Exposes the agent-wide skills master switch alongside this
 * skill's allowed-list membership; every control auto-saves through the connected
 * agent's `skills` branch.
 */
import { ToggleRow } from "@/app/components/side-panel/ConfigControls";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo } from "react";

/** Slice of the nested agent config edited by this tab. */
type SkillsSlice = {
    enabled?: boolean;
    allowed?: string[];
};

/** Skill card Details tab — auto-saving editor for the connected agent's skills config. */
export function SkillDetailsTab({
    nodeId,
    editName,
    setEditName,
    onSaveName,
}: {
    nodeId: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
}) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const skills = useMemo(
        () => readAgentBranch<SkillsSlice>(agentConfig as FlatAgentConfig | undefined, "skills"),
        [agentConfig],
    );
    const disabled = !agentConfig;
    const skillsEnabled = skills.enabled === true;
    const path = editName.trim();
    const inAllowed = path.length > 0 && (skills.allowed ?? []).includes(path);

    /** Adds or removes this card's path from the agent's `skills.allowed` list. */
    function setIncluded(next: boolean) {
        const current = new Set(skills.allowed ?? []);
        if (next && path) {
            current.add(path);
        } else {
            current.delete(path);
        }
        const allowed = Array.from(current);

        void updateBranch(["skills", "allowed"], allowed.length > 0 ? allowed : undefined);
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            {/* Editable skill path — the value used as the allowed-list entry */}
            <div className="flex flex-col gap-1.5">
                <SectionHeader>Skill path</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Format: <code className="rounded bg-muted px-1">accountId/skill-name</code>
                </p>
                <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 font-mono text-xs"
                    placeholder="acct_abc/support-flow"
                    onBlur={onSaveName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveName();
                    }}
                />
            </div>

            <Separator />

            {disabled && (
                <p className="text-xs text-muted-foreground">Wire this skill to an agent to configure it.</p>
            )}

            {/* Agent-wide skills controls */}
            <div className="flex flex-col gap-3">
                <SectionHeader>Skills</SectionHeader>
                <ToggleRow
                    label="Enabled"
                    description="Master switch for the agent's skills."
                    checked={skillsEnabled}
                    disabled={disabled}
                    onCheckedChange={(next) => updateBranch(["skills", "enabled"], next)}
                />
                <ToggleRow
                    label="This skill allowed"
                    description="Include this skill in the agent's allowed list."
                    checked={inAllowed}
                    disabled={disabled || !skillsEnabled || !path}
                    onCheckedChange={setIncluded}
                />
            </div>

        </div>
    );
}

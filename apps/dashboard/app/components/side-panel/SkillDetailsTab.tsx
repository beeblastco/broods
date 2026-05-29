"use client";

/**
 * Skill card Details tab — each card is one entry in the connected agent's
 * `skills.allowed[]`. The status toggle adds/removes the card's label from
 * that array; the `skills.enabled` master switch lives on the agent card.
 */
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { useMemo, useState } from "react";

type SkillsSlice = { enabled?: boolean; allowed?: string[] };

export function SkillDetailsTab({
    nodeId,
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSavingName,
}: {
    nodeId: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSavingName: boolean;
}) {
    const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
    const skills = useMemo(
        () => readAgentBranch<SkillsSlice>(agentConfig as FlatAgentConfig | undefined, "skills"),
        [agentConfig],
    );
    const skillsEnabled = skills.enabled === true;
    const path = editName.trim();
    const inAllowed = path.length > 0 && (skills.allowed ?? []).includes(path);
    const [isToggling, setIsToggling] = useState(false);

    async function setIncluded(next: boolean) {
        setIsToggling(true);
        try {
            const current = new Set(skills.allowed ?? []);
            if (next) {
                if (path) current.add(path);
            } else {
                current.delete(path);
            }
            const allowed = Array.from(current);
            const skillsNext: SkillsSlice = {
                enabled: skills.enabled,
                ...(allowed.length > 0 ? { allowed: allowed } : {}),
            };
            await updateBranch(["skills"], Object.keys(skillsNext).length > 0 ? skillsNext : undefined);
        } finally {
            setIsToggling(false);
        }
    }

    return (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
                <SectionHeader>Skill path</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Format: <code className="rounded bg-muted px-1">accountId/skill-name</code>
                </p>
                <div className="flex items-center gap-2">
                    <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 font-mono text-xs"
                        placeholder="acct_abc/support-flow"
                        onKeyDown={(e) => {
                            if (e.key === "Enter") onSaveName();
                        }}
                    />
                    {nameChanged && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 shrink-0 cursor-pointer text-xs"
                            disabled={!editName.trim() || isSavingName}
                            onClick={onSaveName}
                        >
                            Save
                        </Button>
                    )}
                </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
                <SectionHeader>Status</SectionHeader>
                {!agentConfig && (
                    <p className="text-xs text-muted-foreground">Wire this skill to an agent to enable it.</p>
                )}
                {agentConfig && !skillsEnabled && (
                    <p className="text-xs text-amber-500">
                        Skills are disabled on the connected agent. Enable <code className="rounded bg-muted px-1">skills.enabled</code> on the Agent card first.
                    </p>
                )}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                    <div className="flex flex-col">
                        <span className="text-xs font-medium text-foreground">Included in allowed list</span>
                        <span className="text-[11px] text-muted-foreground">
                            Adds <code className="rounded bg-muted px-1">{path || "—"}</code> to{" "}
                            <code className="rounded bg-muted px-1">skills.allowed</code>.
                        </span>
                    </div>
                    <Switch
                        checked={inAllowed}
                        onCheckedChange={setIncluded}
                        disabled={!agentConfig || !path || isToggling}
                        className="cursor-pointer"
                    />
                </div>
            </div>
        </div>
    );
}

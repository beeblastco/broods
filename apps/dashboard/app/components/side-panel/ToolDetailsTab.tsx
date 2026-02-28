"use client";

/** Details tab for tool nodes: name, function name, language, and enabled switch. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Switch } from "@/app/components/ui/switch";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toErrorMessage } from "@/lib/errors";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

export function ToolDetailsTab({
    projectId,
    environmentId,
    nodeId,
    nodeLabel,
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSavingName,
}: {
    projectId: Id<"projects"> | undefined;
    environmentId: Id<"environments"> | null;
    nodeId: string;
    nodeLabel: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSavingName: boolean;
}) {
    const canQueryTool = !!projectId && !!environmentId;
    const toolService = useQuery(
        api.toolService.getByNode,
        canQueryTool
            ? {
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
            }
            : "skip",
    );
    const upsertToolService = useMutation(api.toolService.upsertForNode);

    const [isSavingStatus, setIsSavingStatus] = useState(false);
    const [statusError, setStatusError] = useState<string | null>(null);

    const isEnabled = toolService?.status !== "disabled";
    const functionName = toolService?.name ?? "generated_on_save";
    const language = toolService?.language ?? "javascript";
    const switchDisabled = isSavingStatus || !projectId || !environmentId || toolService === undefined;

    async function handleEnabledChange(nextEnabled: boolean) {
        if (!projectId || !environmentId) {
            setStatusError("Select an environment before toggling this tool.");

            return;
        }

        setIsSavingStatus(true);
        setStatusError(null);
        try {
            await upsertToolService({
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
                nodeLabel: nodeLabel,
                status: nextEnabled ? "enabled" : "disabled",
            });
        } catch (error) {
            setStatusError(toErrorMessage(error));
        } finally {
            setIsSavingStatus(false);
        }
    }

    return (
        <div className="flex flex-1 flex-col gap-5 p-4">
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
                            className="h-8 shrink-0 text-xs"
                            disabled={!editName.trim() || isSavingName}
                            onClick={onSaveName}
                        >
                            {isSavingName ? "…" : "Save"}
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Tool Function Name
                </span>
                <code className="text-xs text-foreground">{functionName}</code>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Language
                </span>
                <code className="text-xs text-foreground">{language}</code>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
                <div className="flex flex-col">
                    <span className="text-xs font-medium text-foreground">Enabled</span>
                    <span className="text-[11px] text-muted-foreground">
                        {isEnabled ? "Tool can be used by agent runs." : "Tool is disabled."}
                    </span>
                </div>
                <Switch
                    checked={isEnabled}
                    onCheckedChange={handleEnabledChange}
                    disabled={switchDisabled}
                    aria-label="Toggle tool enabled state"
                />
            </div>

            {statusError && (
                <p className="text-xs text-destructive">{statusError}</p>
            )}
        </div>
    );
}

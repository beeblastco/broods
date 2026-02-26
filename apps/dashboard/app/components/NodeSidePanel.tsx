"use client";

/** Side panel displaying agent details and deployment credentials for a selected node. */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Separator } from "@/app/components/ui/separator";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import type { Node } from "@xyflow/react";
import { Check, Copy, Eye, EyeOff, X } from "lucide-react";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";

export function NodeSidePanel({
    node,
    onClose,
}: {
    node: Node | null;
    onClose: () => void;
}) {
    const nodeData = node?.data as BaseNodeData | undefined;
    const agentConfigId = nodeData?.agentConfigId as Id<"agentConfigs"> | undefined;

    // Agent config for editable name
    const agentConfig = useQuery(
        api.agentConfig.getById,
        agentConfigId ? { configId: agentConfigId } : "skip",
    );
    const updateConfig = useMutation(api.agentConfig.update);
    const removeConfig = useMutation(api.agentConfig.remove);

    // Deployment credentials
    const deployments = useQuery(
        api.agentDeployments.list,
        agentConfigId ? { agentConfigId: agentConfigId } : "skip",
    );
    const activeDeployment = deployments?.find((d) => d.status === "active");

    // Editable name
    const [editName, setEditName] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // API key visibility
    const [showApiKey, setShowApiKey] = useState(false);

    // Copy feedback
    const [copiedField, setCopiedField] = useState<string | null>(null);

    // Delete confirmation
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmPhrase, setConfirmPhrase] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);

    const deletePhrase = `delete ${agentConfig?.name ?? ""}`;

    // Sync name when config loads or node changes
    useEffect(() => {
        if (agentConfig) {
            setEditName(agentConfig.name);
        }
        setShowApiKey(false);
        setCopiedField(null);
        setDeleteOpen(false);
        setConfirmPhrase("");
    }, [agentConfig, node?.id]);

    const nameChanged = agentConfig && editName.trim() !== agentConfig.name;

    async function handleSaveName() {
        if (!agentConfigId || !nameChanged || !editName.trim()) return;
        setIsSaving(true);
        try {
            await updateConfig({ configId: agentConfigId, name: editName.trim() });
        } finally {
            setIsSaving(false);
        }
    }

    async function handleDelete() {
        if (!agentConfigId || confirmPhrase !== deletePhrase) return;
        setIsDeleting(true);
        try {
            await removeConfig({ configId: agentConfigId });
            setDeleteOpen(false);
            onClose();
        } finally {
            setIsDeleting(false);
        }
    }

    function handleCopy(value: string, field: string) {
        navigator.clipboard.writeText(value);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    }

    return (
        <>
            <div
                className={`absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-border bg-card transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"}`}
            >
                <div className="flex items-center justify-between px-4 py-3">
                    <h2 className="text-sm font-medium text-foreground">Agent</h2>
                    <button
                        onClick={onClose}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <Separator />

                {nodeData && (
                    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
                        {/* Editable name */}
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</span>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    className="h-8 text-sm"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSaveName();
                                    }}
                                />
                                {nameChanged && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 shrink-0 text-xs"
                                        disabled={!editName.trim() || isSaving}
                                        onClick={handleSaveName}
                                    >
                                        {isSaving ? "…" : "Save"}
                                    </Button>
                                )}
                            </div>
                        </div>

                        {/* Deployment credentials */}
                        {activeDeployment && (
                            <>
                                <Separator />

                                {/* Endpoint ID */}
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Endpoint ID</span>
                                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                        <code className="flex-1 text-xs text-foreground break-all">{activeDeployment.endpointId}</code>
                                        <button
                                            onClick={() => handleCopy(activeDeployment.endpointId, "endpoint")}
                                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {copiedField === "endpoint" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                        </button>
                                    </div>
                                </div>

                                {/* API Key with show/hide */}
                                {activeDeployment.apiKey && (
                                    <div className="flex flex-col gap-1.5">
                                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">API Key</span>
                                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                            <code className="flex-1 text-xs text-foreground break-all">
                                                {showApiKey ? activeDeployment.apiKey : "\u2022".repeat(20)}
                                            </code>
                                            <button
                                                onClick={() => setShowApiKey(!showApiKey)}
                                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                                                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                                            >
                                                {showApiKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                            </button>
                                            <button
                                                onClick={() => handleCopy(activeDeployment.apiKey!, "apikey")}
                                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                                            >
                                                {copiedField === "apikey" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Danger zone */}
                        {agentConfigId && (
                            <>
                                <div className="flex-1" />
                                <div className="rounded-lg border border-destructive/40 p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <p className="text-xs font-semibold text-destructive">Danger Zone</p>
                                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                                                Permanently delete this agent and all its data.
                                            </p>
                                        </div>
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            className="shrink-0 text-xs"
                                            onClick={() => {
                                                setConfirmPhrase("");
                                                setDeleteOpen(true);
                                            }}
                                        >
                                            Delete
                                        </Button>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Delete confirmation dialog */}
            <Dialog
                open={deleteOpen}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteOpen(false);
                        setConfirmPhrase("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete agent</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>
                                    This will permanently delete{" "}
                                    <span className="font-semibold text-foreground">
                                        {agentConfig?.name}
                                    </span>{" "}
                                    and cannot be undone.
                                </p>
                                <p>
                                    All sessions, messages, tasks, deployments, and connections
                                    for this agent will be deleted forever.
                                </p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="confirm-delete-agent" className="grid gap-1">
                            <span>Type the following to confirm</span>
                            <span className="font-mono font-medium text-foreground break-all">
                                {deletePhrase}
                            </span>
                        </Label>
                        <Input
                            id="confirm-delete-agent"
                            value={confirmPhrase}
                            onChange={(e) => setConfirmPhrase(e.target.value)}
                            placeholder={deletePhrase}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setDeleteOpen(false);
                                setConfirmPhrase("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={confirmPhrase !== deletePhrase || isDeleting}
                            onClick={handleDelete}
                        >
                            {isDeleting ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

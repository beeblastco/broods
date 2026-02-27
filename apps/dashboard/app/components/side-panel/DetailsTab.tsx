"use client";

/** Details tab showing editable agent name and deployment credentials. */
import { useState } from "react";
import { Separator } from "@/app/components/ui/separator";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

export function DetailsTab({
    agentConfig,
    activeDeployment,
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSaving,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    activeDeployment: Doc<"agentDeployments"> | undefined;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSaving: boolean;
}) {
    const [showApiKey, setShowApiKey] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);

    function handleCopy(value: string, field: string) {
        navigator.clipboard.writeText(value);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    }

    return (
        <div className="flex flex-1 flex-col gap-5 p-4">
            {/* Editable name */}
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
                            disabled={!editName.trim() || isSaving}
                            onClick={onSaveName}
                        >
                            {isSaving ? "…" : "Save"}
                        </Button>
                    )}
                </div>
            </div>

            {/* Agent info */}
            {agentConfig && (
                <>
                    {agentConfig.description && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Description</span>
                            <p className="text-xs text-foreground">{agentConfig.description}</p>
                        </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Model</span>
                        <code className="text-xs text-foreground">{agentConfig.modelId}</code>
                    </div>
                </>
            )}

            {/* Deployment status & credentials */}
            {activeDeployment && (
                <>
                    <Separator />

                    {/* Status */}
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Status</span>
                        <span
                            className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                activeDeployment.status === "active"
                                    ? "bg-emerald-500/10 text-emerald-500"
                                    : "bg-destructive/10 text-destructive"
                            }`}
                        >
                            <span
                                className={`size-1.5 rounded-full ${
                                    activeDeployment.status === "active"
                                        ? "bg-emerald-500"
                                        : "bg-destructive"
                                }`}
                            />
                            {activeDeployment.status === "active" ? "Active" : "Revoked"}
                        </span>
                    </div>

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
        </div>
    );
}

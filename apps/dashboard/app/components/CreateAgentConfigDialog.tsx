"use client";

/** Dialog form for creating a new agent configuration, deploying it, and showing credentials. */
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Dialog form for creating a new agent config, auto-deploying, and showing credentials. */
export function CreateAgentConfigDialog({
    projectId,
    environmentId,
    open,
    onOpenChange,
}: {
    projectId: Id<"projects">;
    environmentId: Id<"environments"> | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const createAgentConfig = useMutation(api.agentConfig.create);
    const createDeployment = useMutation(api.agentDeployments.create);

    const [name, setName] = useState("");
    const [modelId, setModelId] = useState("");
    const [description, setDescription] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    // Credentials shown after successful creation
    const [credentials, setCredentials] = useState<{
        endpointId: string;
        rawApiKey: string;
        projectSlug?: string;
        environmentSlug?: string;
    } | null>(null);
    const [copiedField, setCopiedField] = useState<string | null>(null);

    function resetForm() {
        setName("");
        setModelId("");
        setDescription("");
        setSystemPrompt("");
        setCredentials(null);
        setCopiedField(null);
    }

    function handleCopy(text: string, field: string) {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    }

    function handleClose() {
        resetForm();
        onOpenChange(false);
    }

    async function handleCreate() {
        if (!name.trim() || !modelId.trim() || !environmentId) return;
        setIsCreating(true);
        try {
            const { agentConfigId } = await createAgentConfig({
                projectId: projectId,
                environmentId: environmentId,
                name: name.trim(),
                modelId: modelId.trim(),
                description: description.trim() || undefined,
                systemPrompt: systemPrompt.trim() || undefined,
            });

            // Auto-deploy the newly created agent
            const deployment = await createDeployment({
                agentConfigId: agentConfigId,
            });

            setCredentials(deployment);
        } finally {
            setIsCreating(false);
        }
    }

    // Show credentials view after successful creation
    if (credentials) {
        const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL ?? "http://localhost:8080";
        const envPrefix = credentials.environmentSlug ? `/${credentials.environmentSlug}` : "";
        const projectPrefix = credentials.projectSlug ? `/${credentials.projectSlug}` : "";
        const curlCommand = `curl -X POST ${gatewayUrl}/v1${projectPrefix}/agents${envPrefix}/${credentials.endpointId} \\\n  -H "Authorization: Bearer ${credentials.rawApiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"message":"hello","stream":false}'`;

        return (
            <Dialog open={open} onOpenChange={() => handleClose()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Agent deployed</DialogTitle>
                        <DialogDescription>
                            Your agent is ready. These credentials are also available in the node detail panel.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-2">
                        <CredentialField
                            label="Endpoint ID"
                            value={credentials.endpointId}
                            field="endpoint"
                            copiedField={copiedField}
                            onCopy={handleCopy}
                        />
                        <CredentialField
                            label="API Key"
                            value={credentials.rawApiKey}
                            field="apikey"
                            copiedField={copiedField}
                            onCopy={handleCopy}
                        />
                        <CredentialField
                            label="Example curl"
                            value={curlCommand}
                            field="curl"
                            copiedField={copiedField}
                            onCopy={handleCopy}
                            small
                        />
                    </div>
                    <DialogFooter>
                        <Button onClick={handleClose}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Create Agent Config</DialogTitle>
                    <DialogDescription>
                        Configure a new AI agent for your project.
                    </DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleCreate();
                    }}
                >
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="agent-name">Name</Label>
                            <Input
                                id="agent-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="My Agent"
                                autoFocus
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-model">Model ID</Label>
                            <Input
                                id="agent-model"
                                value={modelId}
                                onChange={(e) => setModelId(e.target.value)}
                                placeholder="anthropic/claude-sonnet-4-6"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-description">
                                Description (optional)
                            </Label>
                            <Input
                                id="agent-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What does this agent do?"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-prompt">
                                System Prompt (optional)
                            </Label>
                            <Input
                                id="agent-prompt"
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                placeholder="You are a helpful assistant..."
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!name.trim() || !modelId.trim() || !environmentId || isCreating}
                        >
                            {isCreating ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Copyable credential row used in the credentials view. */
function CredentialField({
    label,
    value,
    field,
    copiedField,
    onCopy,
    small,
}: {
    label: string;
    value: string;
    field: string;
    copiedField: string | null;
    onCopy: (text: string, field: string) => void;
    small?: boolean;
}) {
    return (
        <div className="grid gap-1.5">
            <Label>{label}</Label>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
                <code className={`flex-1 break-all ${small ? "text-xs" : "text-sm"}`}>
                    {value}
                </code>
                <button
                    onClick={() => onCopy(value, field)}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                    {copiedField === field ? <Check className="size-4" /> : <Copy className="size-4" />}
                </button>
            </div>
        </div>
    );
}

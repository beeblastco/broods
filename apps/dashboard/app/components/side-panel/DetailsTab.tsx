"use client";

/** Details tab showing editable agent name, deployment credentials, and built-in tool config. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import { isRecord } from "@/app/lib/utils";
import type { Doc } from "@/convex/_generated/dataModel";
import { Check, Copy, Eye, EyeOff, Globe, Slash, Wifi } from "lucide-react";
import { useRef, useState } from "react";

type OutputFormatConfig = {
    type?: string;
    schema?: unknown;
    name?: string;
    description?: string;
};

export type AgentProvider = "openai" | "google" | "bedrock" | "anthropic" | "minimax" | "gateway";
type RuntimeVariable = { key: string; value: string };

const providerOptions: Array<{ value: AgentProvider; label: string }> = [
    { value: "openai", label: "OpenAI" },
    { value: "google", label: "Google" },
    { value: "bedrock", label: "Bedrock" },
    { value: "anthropic", label: "Anthropic" },
    { value: "minimax", label: "MiniMax" },
    { value: "gateway", label: "Gateway" },
];

const DEFAULT_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    additionalProperties: true,
    properties: {
        answer: { type: "string" },
    },
    required: ["answer"],
};

function toWebSocketBaseUrl(gatewayUrl: string): string {
    const url = new URL(gatewayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    return url.toString().replace(/\/$/, "");
}

export function DetailsTab({
    agentConfig,
    activeDeployment,
    deploymentApiKey,
    editName,
    setEditName,
    onSaveName,
    onUpdateOutputFormat,
    publicAccessEnabled,
    webSocketEnabled,
    onTogglePublicAccess,
    onToggleWebSocket,
    isSavingPublicAccess,
    isSavingWebSocket,
    selectedProvider,
    runtimeVariables,
    onSaveModelSettings,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    activeDeployment: Doc<"agentDeployments"> | undefined;
    deploymentApiKey?: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSaving: boolean;
    onUpdateOutputFormat?: (outputFormat: Record<string, unknown> | null) => void;
    publicAccessEnabled: boolean;
    webSocketEnabled: boolean;
    onTogglePublicAccess?: (enabled: boolean) => Promise<void> | void;
    onToggleWebSocket?: (enabled: boolean) => Promise<void> | void;
    isSavingPublicAccess?: boolean;
    isSavingWebSocket?: boolean;
    selectedProvider: AgentProvider;
    runtimeVariables: RuntimeVariable[];
    onSaveModelSettings?: (next: { provider: AgentProvider; modelId: string }) => Promise<void>;
    isSavingModelSettings?: boolean;
}) {
    const [showApiKey, setShowApiKey] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [outputSchemaText, setOutputSchemaText] = useState("");
    const [hasEditedOutputSchema, setHasEditedOutputSchema] = useState(false);
    const [outputSchemaError, setOutputSchemaError] = useState<string | null>(null);
    const [editProvider, setEditProvider] = useState<AgentProvider>(selectedProvider);
    const [editModelId, setEditModelId] = useState(agentConfig?.modelId ?? "");
    const schemaFileInputRef = useRef<HTMLInputElement | null>(null);

    const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL ?? "http://localhost:8080";
    const websocketBaseUrl = toWebSocketBaseUrl(gatewayUrl);
    const envPrefix = activeDeployment?.environmentSlug ? `/${activeDeployment.environmentSlug}` : "";
    const projectPrefix = activeDeployment?.projectSlug ? `/${activeDeployment.projectSlug}` : "";
    const endpointUrl = activeDeployment ? `${gatewayUrl}/v1${projectPrefix}/agents${envPrefix}/${activeDeployment.endpointId}` : "";
    const websocketUrl = activeDeployment ? `${websocketBaseUrl}/v1${projectPrefix}/agents${envPrefix}/${activeDeployment.endpointId}/ws` : "";

    const outputFormat = agentConfig?.outputFormat && isRecord(agentConfig.outputFormat)
        ? agentConfig.outputFormat as OutputFormatConfig
        : undefined;
    const outputFormatEnabled = outputFormat !== undefined;
    const schemaFromConfigText = isRecord(outputFormat?.schema)
        ? JSON.stringify(outputFormat.schema, null, 2)
        : "";
    const displayOutputSchemaText = hasEditedOutputSchema
        ? outputSchemaText
        : schemaFromConfigText;
    const hasOpenAiApiKeyVariable = runtimeVariables.some((entry) => {
        const normalized = entry.key.trim().toUpperCase();

        return normalized === "OPENAI_API_KEY" || normalized === "API_KEY";
    });
    const openAiVariableRequired = editProvider === "openai" && !hasOpenAiApiKeyVariable;

    function buildOutputFormatPayload(schema: Record<string, unknown>): Record<string, unknown> {
        const next: Record<string, unknown> = {
            type: "object",
            schema: schema,
        };

        if (typeof outputFormat?.name === "string" && outputFormat.name.trim().length > 0) {
            next.name = outputFormat.name.trim();
        }
        if (typeof outputFormat?.description === "string" && outputFormat.description.trim().length > 0) {
            next.description = outputFormat.description.trim();
        }

        return next;
    }

    function parseSchemaText(input: string): Record<string, unknown> | null {
        try {
            const parsed = JSON.parse(input);
            if (!isRecord(parsed)) {
                setOutputSchemaError("Schema must be a JSON object.");

                return null;
            }
            setOutputSchemaError(null);

            return parsed;
        } catch {
            setOutputSchemaError("Invalid schema JSON.");

            return null;
        }
    }

    function handleToggleOutputFormat(enabled: boolean) {
        if (!enabled) {
            setOutputSchemaError(null);
            setHasEditedOutputSchema(false);
            setOutputSchemaText("");
            onUpdateOutputFormat?.(null);

            return;
        }

        const existingSchema = isRecord(outputFormat?.schema)
            ? (outputFormat.schema as Record<string, unknown>)
            : undefined;
        setOutputSchemaError(null);

        if (existingSchema) {
            setHasEditedOutputSchema(true);
            setOutputSchemaText(JSON.stringify(existingSchema, null, 2));
            onUpdateOutputFormat?.(buildOutputFormatPayload(existingSchema));
        } else {
            setHasEditedOutputSchema(true);
            setOutputSchemaText(JSON.stringify(DEFAULT_OUTPUT_SCHEMA, null, 2));
            onUpdateOutputFormat?.(buildOutputFormatPayload(DEFAULT_OUTPUT_SCHEMA));
        }
    }

    function handleApplySchema() {
        const parsed = parseSchemaText(displayOutputSchemaText);
        if (!parsed) {
            return;
        }
        setHasEditedOutputSchema(true);
        setOutputSchemaText(JSON.stringify(parsed, null, 2));
        onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
    }

    function handleImportSchemaFile(file: File | undefined) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const content = typeof reader.result === "string" ? reader.result : "";
            const parsed = parseSchemaText(content);
            if (!parsed) {
                return;
            }
            setHasEditedOutputSchema(true);
            setOutputSchemaText(JSON.stringify(parsed, null, 2));
            onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
        };
        reader.onerror = () => {
            setOutputSchemaError("Failed to read schema file.");
        };
        reader.readAsText(file);
    }

    function handleCopy(value: string, field: string) {
        navigator.clipboard.writeText(value);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    }

    /** Auto-saves the provider/model pair; no-ops while the model id is empty. */
    function saveModel(provider: AgentProvider, modelId: string) {
        const trimmed = modelId.trim();
        if (!trimmed) {
            return;
        }

        void onSaveModelSettings?.({ provider: provider, modelId: trimmed });
    }

    return (
        <div className="flex flex-1 flex-col gap-5 p-4">
            {/* Editable name — auto-saves on blur / Enter */}
            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</span>
                <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 text-sm"
                    onBlur={onSaveName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveName();
                    }}
                />
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
                    <div className="flex flex-col gap-2">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Provider & Model</span>
                        <Select
                            value={editProvider}
                            onValueChange={(value) => {
                                const nextProvider = value as AgentProvider;
                                setEditProvider(nextProvider);
                                saveModel(nextProvider, editModelId);
                            }}
                        >
                            <SelectTrigger className="h-8 w-full cursor-pointer text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {providerOptions.map((providerOption) => (
                                    <SelectItem key={providerOption.value} value={providerOption.value}>
                                        {providerOption.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Input
                            value={editModelId}
                            onChange={(event) => setEditModelId(event.target.value)}
                            className="h-8 text-xs"
                            placeholder="Model ID"
                            onBlur={() => saveModel(editProvider, editModelId)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") saveModel(editProvider, editModelId);
                            }}
                        />
                        {openAiVariableRequired && (
                            <p className="text-xs text-destructive">
                                Add <code>OPENAI_API_KEY</code> in the Variables tab before running the agent.
                            </p>
                        )}
                    </div>
                </>
            )}

            <Separator />

            {/* Public access controls */}
            <div className="flex flex-col gap-3">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Access & Deployment</span>
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground">Public Access</span>
                                <span className="text-[11px] text-muted-foreground">Create a cloud endpoint for external users.</span>
                            </div>
                            <Switch
                                checked={publicAccessEnabled}
                                disabled={isSavingPublicAccess}
                                onCheckedChange={(checked) => {
                                    void onTogglePublicAccess?.(checked);
                                }}
                            />
                        </div>

                        <div className="flex items-center justify-between gap-4">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground">WebSocket</span>
                                <span className="text-[11px] text-muted-foreground">Enable real-time `/ws` transport for this agent.</span>
                            </div>
                            <Switch
                                checked={webSocketEnabled}
                                disabled={!publicAccessEnabled || isSavingPublicAccess || isSavingWebSocket}
                                onCheckedChange={(checked) => {
                                    void onToggleWebSocket?.(checked);
                                }}
                            />
                        </div>

                        {!publicAccessEnabled && (
                            <div className="flex items-start gap-2 rounded-md border border-dashed border-border/70 bg-muted/40 p-2">
                                <span className="relative mt-0.5 inline-flex size-4 items-center justify-center text-muted-foreground">
                                    <Globe className="size-3.5" />
                                    <Slash className="absolute size-3.5" />
                                </span>
                                <p className="text-[11px] text-muted-foreground">
                                    This agent is private by default. Enable public access to generate endpoint credentials.
                                </p>
                            </div>
                        )}

                        {publicAccessEnabled && !activeDeployment && (
                            <p className="text-[11px] text-muted-foreground">
                                Creating deployment endpoint…
                            </p>
                        )}
                    </div>
                </div>

                {publicAccessEnabled && activeDeployment && (
                    <div className="flex flex-col gap-2.5">
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/90">
                            Direct API + WebSocket access is not yet live on the cloud service. The URL and API key below are reserved for this agent; they will start working once the public gateway ships.
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Endpoint URL</span>
                            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                <code className="flex-1 text-xs text-foreground break-all">{endpointUrl}</code>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="shrink-0 text-muted-foreground"
                                    onClick={() => handleCopy(endpointUrl, "url")}
                                >
                                    {copiedField === "url" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                </Button>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Endpoint ID</span>
                            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                <code className="flex-1 text-xs text-foreground break-all">{activeDeployment.endpointId}</code>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="shrink-0 text-muted-foreground"
                                    onClick={() => handleCopy(activeDeployment.endpointId, "endpoint")}
                                >
                                    {copiedField === "endpoint" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                </Button>
                            </div>
                        </div>

                        {agentConfig?.agentId && (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Agent ID</span>
                                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                    <code className="flex-1 text-xs text-foreground break-all">{agentConfig.agentId}</code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground"
                                        onClick={() => handleCopy(agentConfig.agentId as string, "agentid")}
                                    >
                                        {copiedField === "agentid" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                    </Button>
                                </div>
                                <span className="text-[11px] text-muted-foreground/60">
                                    Pass this as <code>agentId</code> in the invoke payload.
                                </span>
                            </div>
                        )}

                        {webSocketEnabled && (
                            <div className="flex flex-col gap-1.5">
                                <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                                    <Wifi className="size-3" />
                                    WebSocket URL
                                </span>
                                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                    <code className="flex-1 text-xs text-foreground break-all">{websocketUrl}</code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground"
                                        onClick={() => handleCopy(websocketUrl, "websocket")}
                                    >
                                        {copiedField === "websocket" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {deploymentApiKey ? (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">API Key</span>
                                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                    <code className="flex-1 text-xs text-foreground break-all">
                                        {showApiKey ? deploymentApiKey : "\u2022".repeat(20)}
                                    </code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        aria-label={showApiKey ? "Hide API key" : "Show API key"}
                                    >
                                        {showApiKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground"
                                        onClick={() => handleCopy(deploymentApiKey, "apikey")}
                                    >
                                        {copiedField === "apikey" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">API Key</span>
                                <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                                    This deployment does not expose a stored API key. Save the key when the deployment is created, or reissue one from the backend if needed.
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Output format schema */}
            {agentConfig && (
                <>
                    <Separator />
                    <div className="flex flex-col gap-3">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Output Format</span>
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground">Structured Output</span>
                                <span className="text-[11px] text-muted-foreground">Import a JSON schema or write one manually</span>
                            </div>
                            <Switch
                                checked={outputFormatEnabled}
                                onCheckedChange={(checked) => handleToggleOutputFormat(checked)}
                            />
                        </div>

                        {outputFormatEnabled && (
                            <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">
                                <input
                                    ref={schemaFileInputRef}
                                    type="file"
                                    accept="application/json,.json"
                                    className="hidden"
                                    onChange={(e) => {
                                        handleImportSchemaFile(e.target.files?.[0]);
                                        e.currentTarget.value = "";
                                    }}
                                />
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-[11px]"
                                        onClick={() => schemaFileInputRef.current?.click()}
                                    >
                                        Import Schema
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-[11px]"
                                        onClick={handleApplySchema}
                                    >
                                        Save Schema
                                    </Button>
                                </div>
                                <Textarea
                                    value={displayOutputSchemaText}
                                    onChange={(e) => {
                                        setHasEditedOutputSchema(true);
                                        setOutputSchemaText(e.target.value);
                                        setOutputSchemaError(null);
                                    }}
                                    placeholder={'{\n  "type": "object",\n  "additionalProperties": true,\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}'}
                                    spellCheck={false}
                                    className="min-h-36 resize-y font-mono text-xs"
                                />
                                {outputSchemaError && (
                                    <p className="text-xs text-destructive">{outputSchemaError}</p>
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

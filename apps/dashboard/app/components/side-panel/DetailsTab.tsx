"use client";

/** Details tab showing editable agent name, deployment credentials, and built-in tool config. */
import { ChannelsSection } from "@/app/components/side-panel/ChannelsSection";
import { ExpandBlock, ToggleRow } from "@/app/components/side-panel/ConfigControls";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import { readAgentBranch, readModelReasoning, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { isPlainObject } from "@/app/lib/utils";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { Check, Copy, Eye, EyeOff, KeyRound, RefreshCw, Wifi } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Public (hash-free) view of an environment's runtime deployment, as returned by
 * `agentDeployments.getForEnvironment`. The key is environment-wide; the agent is
 * selected per request by its Agent ID.
 */
export type EnvironmentDeployment = {
    _id: Id<"agentDeployments">;
    endpointId: string;
    projectSlug: string;
    environmentSlug: string;
    keyHint?: string;
    updatedAt: number;
};

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

export function DetailsTab({
    agentConfig,
    activeDeployment,
    deploymentApiKey,
    editName,
    setEditName,
    onSaveName,
    onUpdateOutputFormat,
    onGenerateKey,
    onRotateKey,
    isSavingKey,
    selectedProvider,
    runtimeVariables,
    onSaveModelSettings,
    onUpdateToolConfig,
    onUpdateChannelConfig,
    onUpdateModelReasoning,
    onUpdatePublicAccess,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    activeDeployment: EnvironmentDeployment | undefined;
    deploymentApiKey?: string;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    onUpdateOutputFormat?: (outputFormat: Record<string, unknown> | null) => void;
    onGenerateKey?: () => Promise<void> | void;
    onRotateKey?: () => Promise<void> | void;
    isSavingKey?: boolean;
    selectedProvider: AgentProvider;
    runtimeVariables: RuntimeVariable[];
    onSaveModelSettings?: (next: { provider: AgentProvider; modelId: string }) => Promise<void>;
    onUpdateToolConfig?: (toolName: string, config: Record<string, unknown> | null) => Promise<void>;
    onUpdateChannelConfig?: (kind: string, config: Record<string, unknown> | null) => Promise<void>;
    onUpdateModelReasoning?: (next: { budgetTokens?: number; effort?: string }) => Promise<void>;
    onUpdatePublicAccess?: (enabled: boolean) => Promise<void>;
}) {
    const [showApiKey, setShowApiKey] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    // Reveal a freshly generated/rotated key the moment it arrives (render-time
    // sync, not an effect); hide again once the plaintext is cleared.
    const [syncedApiKey, setSyncedApiKey] = useState(deploymentApiKey);
    if (deploymentApiKey !== syncedApiKey) {
        setSyncedApiKey(deploymentApiKey);
        setShowApiKey(Boolean(deploymentApiKey));
    }
    const [outputSchemaText, setOutputSchemaText] = useState("");
    const [hasEditedOutputSchema, setHasEditedOutputSchema] = useState(false);
    const [outputSchemaError, setOutputSchemaError] = useState<string | null>(null);
    const [editProvider, setEditProvider] = useState<AgentProvider>(selectedProvider);
    const [editModelId, setEditModelId] = useState(agentConfig?.modelId ?? "");
    const schemaFileInputRef = useRef<HTMLInputElement | null>(null);

    // Built-in tool configs derived from agentConfig (reads extraConfig.tools, falls back to flat columns)
    const allTools = agentConfig
        ? (readAgentBranch(agentConfig as unknown as FlatAgentConfig, "tools") as Record<string, unknown>)
        : {};
    const tavilySearchCfg = isPlainObject(allTools.tavilySearch) ? (allTools.tavilySearch as Record<string, unknown>) : {};
    const tavilyExtractCfg = isPlainObject(allTools.tavilyExtract) ? (allTools.tavilyExtract as Record<string, unknown>) : {};
    const googleSearchCfg = isPlainObject(allTools.googleSearch)
        ? (allTools.googleSearch as Record<string, unknown>)
        : { enabled: agentConfig?.searchToolEnabled };
    const tavilySearchEnabled = tavilySearchCfg.enabled === true;
    const tavilyExtractEnabled = tavilyExtractCfg.enabled === true;
    const googleSearchEnabled = googleSearchCfg.enabled === true;

    // Local draft for text inputs that should not save on every keystroke
    const [tavilySearchApiKey, setTavilySearchApiKey] = useState(
        () => typeof tavilySearchCfg.apiKey === "string" ? tavilySearchCfg.apiKey : ""
    );
    const [tavilyExtractApiKey, setTavilyExtractApiKey] = useState(
        () => typeof tavilyExtractCfg.apiKey === "string" ? tavilyExtractCfg.apiKey : ""
    );
    const [tavilySearchMaxResults, setTavilySearchMaxResults] = useState(
        () => typeof tavilySearchCfg.maxResults === "number" ? String(tavilySearchCfg.maxResults) : "5"
    );

    // Reasoning lives under model.providerOptions.<provider>.* (Vercel AI SDK shape).
    const modelBranch = agentConfig
        ? (readAgentBranch(agentConfig as unknown as FlatAgentConfig, "model") as Record<string, unknown>)
        : {};
    const { budgetTokens: reasoningBudget, effort: reasoningEffortValue } = readModelReasoning(modelBranch);
    const reasoningEffort = reasoningEffortValue ?? "";
    const reasoningEnabled = reasoningBudget !== undefined || reasoningEffort !== "";
    const [reasoningBudgetText, setReasoningBudgetText] = useState(
        () => reasoningBudget !== undefined ? String(reasoningBudget) : ""
    );

    const coreEndpoint = resolveCoreEndpoint();
    const envPrefix = activeDeployment?.environmentSlug ? `/${activeDeployment.environmentSlug}` : "";
    const projectPrefix = activeDeployment?.projectSlug ? `/${activeDeployment.projectSlug}` : "";
    const endpointUrl = activeDeployment && coreEndpoint.ok ? `${coreEndpoint.httpBaseUrl}/v1${projectPrefix}/agents${envPrefix}/${activeDeployment.endpointId}` : "";
    const websocketUrl = activeDeployment && coreEndpoint.ok ? `${coreEndpoint.websocketBaseUrl}/v1${projectPrefix}/agents${envPrefix}/${activeDeployment.endpointId}/ws` : "";

    // Per-agent public-endpoint opt-in (issue #65). Stored as a top-level scalar
    // in extraConfig; off by default so the agent is secured until enabled.
    const publicAccess = ((agentConfig?.extraConfig as Record<string, unknown> | undefined)?.publicAccess) === true;

    const outputFormat = agentConfig?.outputFormat && isPlainObject(agentConfig.outputFormat)
        ? agentConfig.outputFormat as OutputFormatConfig
        : undefined;
    const outputFormatEnabled = outputFormat !== undefined;
    const schemaFromConfigText = isPlainObject(outputFormat?.schema)
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
            if (!isPlainObject(parsed)) {
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

        const existingSchema = isPlainObject(outputFormat?.schema)
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

                    {/* Reasoning — budget tokens (Anthropic/MiniMax/Google) + effort (OpenAI/Anthropic),
                        written to model.providerOptions.<provider> for the selected provider. */}
                    {onUpdateModelReasoning && (
                        <div className="flex flex-col gap-2">
                            <ToggleRow
                                label="Reasoning"
                                description="Thinking / extended reasoning"
                                checked={reasoningEnabled}
                                onCheckedChange={(next) => {
                                    if (next) {
                                        // Seed a provider-appropriate default so the toggle has effect:
                                        // OpenAI reasons by effort, the others by a thinking-token budget.
                                        if (selectedProvider === "openai") {
                                            void onUpdateModelReasoning({ effort: "medium" });
                                        } else {
                                            setReasoningBudgetText("4096");
                                            void onUpdateModelReasoning({ budgetTokens: 4096 });
                                        }
                                    } else {
                                        setReasoningBudgetText("");
                                        void onUpdateModelReasoning({});
                                    }
                                }}
                            />
                            {reasoningEnabled && (
                                <ExpandBlock>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-muted-foreground">
                                            Budget tokens <span className="text-muted-foreground/50">(Anthropic / MiniMax / Google)</span>
                                        </span>
                                        <Input
                                            type="number"
                                            min={0}
                                            className="h-7 w-24 text-xs"
                                            placeholder="4096"
                                            value={reasoningBudgetText}
                                            onChange={(e) => setReasoningBudgetText(e.target.value)}
                                            onBlur={() => {
                                                const n = parseInt(reasoningBudgetText, 10);
                                                const budget = Number.isFinite(n) && n > 0 ? n : undefined;
                                                void onUpdateModelReasoning({ budgetTokens: budget, effort: reasoningEffort || undefined });
                                            }}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-muted-foreground">
                                            Effort <span className="text-muted-foreground/50">(OpenAI / Anthropic)</span>
                                        </span>
                                        <Select
                                            value={reasoningEffort || "none"}
                                            onValueChange={(v) => {
                                                const effort = v === "none" ? undefined : v;
                                                const n = parseInt(reasoningBudgetText, 10);
                                                const budget = Number.isFinite(n) && n > 0 ? n : undefined;
                                                void onUpdateModelReasoning({ budgetTokens: budget, effort: effort });
                                            }}
                                        >
                                            <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">None</SelectItem>
                                                <SelectItem value="minimal">Minimal</SelectItem>
                                                <SelectItem value="low">Low</SelectItem>
                                                <SelectItem value="medium">Medium</SelectItem>
                                                <SelectItem value="high">High</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground/60">
                                        Set budget for Anthropic/MiniMax/Google, effort for OpenAI. Anthropic honors either.
                                    </p>
                                </ExpandBlock>
                            )}
                        </div>
                    )}

                </>
            )}

            <Separator />

            {/* Public access controls */}
            <div className="flex flex-col gap-3">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Public API</span>
                {onUpdatePublicAccess && (
                    <ToggleRow
                        label="Public access"
                        description="Reachable over HTTP/SSE and WebSocket with the runtime API key"
                        checked={publicAccess}
                        onCheckedChange={(next) => void onUpdatePublicAccess(next)}
                    />
                )}
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                    <p className="text-[11px] text-muted-foreground">
                        {publicAccess
                            ? "This agent is reachable over HTTP/SSE and WebSocket with the environment's runtime API key. Select the agent per request with its Agent ID below."
                            : "Secured by default — this agent is not publicly accessible. Reach it through an internal endpoint or a channel webhook, or enable public access above."}
                    </p>
                </div>

                {!activeDeployment ? (
                    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border/70 bg-muted/40 p-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                            <KeyRound className="size-3.5" />
                            No runtime API key yet
                        </span>
                        <p className="text-[11px] text-muted-foreground">
                            Generate the environment&apos;s key to reveal the endpoint URLs. <code>broods deploy</code> also mints it automatically.
                        </p>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-fit cursor-pointer text-xs"
                            disabled={isSavingKey}
                            onClick={() => void onGenerateKey?.()}
                        >
                            {isSavingKey ? "Generating…" : "Generate API key"}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2.5">
                        {!publicAccess ? (
                            <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                                Endpoint URLs are hidden while public access is off. Requests to this agent over the
                                public endpoint are refused until you enable public access above.
                            </p>
                        ) : !coreEndpoint.ok ? (
                            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                                {coreEndpoint.message}
                            </p>
                        ) : (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Endpoint URL (HTTP/SSE)</span>
                                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                        <code className="flex-1 text-xs text-foreground break-all">{endpointUrl}</code>
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            className="shrink-0 cursor-pointer text-muted-foreground"
                                            onClick={() => handleCopy(endpointUrl, "url")}
                                        >
                                            {copiedField === "url" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                        </Button>
                                    </div>
                                </div>

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
                                            className="shrink-0 cursor-pointer text-muted-foreground"
                                            onClick={() => handleCopy(websocketUrl, "websocket")}
                                        >
                                            {copiedField === "websocket" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                        </Button>
                                    </div>
                                </div>
                            </>
                        )}

                        {agentConfig?.agentId && (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Agent ID</span>
                                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                    <code className="flex-1 text-xs text-foreground break-all">{agentConfig.agentId}</code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 cursor-pointer text-muted-foreground"
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

                        <div className="flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">API Key (environment-wide)</span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground"
                                    disabled={isSavingKey}
                                    onClick={() => void onRotateKey?.()}
                                >
                                    <RefreshCw className={`size-3 ${isSavingKey ? "animate-spin" : ""}`} />
                                    Rotate
                                </Button>
                            </div>
                            {deploymentApiKey ? (
                                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                    <code className="flex-1 text-xs text-foreground break-all">
                                        {showApiKey ? deploymentApiKey : "\u2022".repeat(20)}
                                    </code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 cursor-pointer text-muted-foreground"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        aria-label={showApiKey ? "Hide API key" : "Show API key"}
                                    >
                                        {showApiKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 cursor-pointer text-muted-foreground"
                                        onClick={() => handleCopy(deploymentApiKey, "apikey")}
                                    >
                                        {copiedField === "apikey" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                    </Button>
                                </div>
                            ) : (
                                <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                                    Loading the encrypted runtime key…
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Built-in Tools */}
            {agentConfig && onUpdateToolConfig && (
                <>
                    <Separator />
                    <div className="flex flex-col gap-3">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Built-in Tools</span>

                        {/* Tavily Search */}
                        <ToggleRow
                            label="Tavily Search"
                            description="Web search via Tavily"
                            checked={tavilySearchEnabled}
                            onCheckedChange={(next) =>
                                void onUpdateToolConfig("tavilySearch", { ...tavilySearchCfg, enabled: next })
                            }
                        />
                        {tavilySearchEnabled && (
                            <ExpandBlock>
                                <ToggleRow
                                    label="Needs approval"
                                    checked={tavilySearchCfg.needsApproval === true}
                                    onCheckedChange={(next) =>
                                        void onUpdateToolConfig("tavilySearch", { ...tavilySearchCfg, needsApproval: next })
                                    }
                                />
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] text-muted-foreground">Search depth</span>
                                    <Select
                                        value={typeof tavilySearchCfg.searchDepth === "string" ? tavilySearchCfg.searchDepth : "basic"}
                                        onValueChange={(v) =>
                                            void onUpdateToolConfig("tavilySearch", { ...tavilySearchCfg, searchDepth: v })
                                        }
                                    >
                                        <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="basic">Basic</SelectItem>
                                            <SelectItem value="advanced">Advanced</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] text-muted-foreground">Max results</span>
                                    <Input
                                        type="number"
                                        min={1}
                                        max={20}
                                        className="h-7 w-20 text-xs"
                                        value={tavilySearchMaxResults}
                                        onChange={(e) => setTavilySearchMaxResults(e.target.value)}
                                        onBlur={() => {
                                            const n = parseInt(tavilySearchMaxResults, 10);
                                            const clamped = Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5;
                                            void onUpdateToolConfig("tavilySearch", { ...tavilySearchCfg, maxResults: clamped });
                                        }}
                                    />
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] text-muted-foreground">Topic</span>
                                    <Select
                                        value={typeof tavilySearchCfg.topic === "string" ? tavilySearchCfg.topic : "general"}
                                        onValueChange={(v) =>
                                            void onUpdateToolConfig("tavilySearch", { ...tavilySearchCfg, topic: v })
                                        }
                                    >
                                        <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="general">General</SelectItem>
                                            <SelectItem value="news">News</SelectItem>
                                            <SelectItem value="finance">Finance</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">
                                        API key <span className="text-muted-foreground/50">(or set TAVILY_API_KEY env)</span>
                                    </span>
                                    <Input
                                        type="password"
                                        className="h-7 font-mono text-xs"
                                        placeholder="tvly-…"
                                        value={tavilySearchApiKey}
                                        onChange={(e) => setTavilySearchApiKey(e.target.value)}
                                        onBlur={() => {
                                            const key = tavilySearchApiKey.trim();
                                            const next = { ...tavilySearchCfg };
                                            if (key) {
                                                next.apiKey = key;
                                            } else {
                                                delete next.apiKey;
                                            }
                                            void onUpdateToolConfig("tavilySearch", next);
                                        }}
                                    />
                                </div>
                            </ExpandBlock>
                        )}

                        {/* Tavily Extract */}
                        <ToggleRow
                            label="Tavily Extract"
                            description="Web page extraction via Tavily"
                            checked={tavilyExtractEnabled}
                            onCheckedChange={(next) =>
                                void onUpdateToolConfig("tavilyExtract", { ...tavilyExtractCfg, enabled: next })
                            }
                        />
                        {tavilyExtractEnabled && (
                            <ExpandBlock>
                                <ToggleRow
                                    label="Needs approval"
                                    checked={tavilyExtractCfg.needsApproval === true}
                                    onCheckedChange={(next) =>
                                        void onUpdateToolConfig("tavilyExtract", { ...tavilyExtractCfg, needsApproval: next })
                                    }
                                />
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] text-muted-foreground">Extract depth</span>
                                    <Select
                                        value={typeof tavilyExtractCfg.extractDepth === "string" ? tavilyExtractCfg.extractDepth : "basic"}
                                        onValueChange={(v) =>
                                            void onUpdateToolConfig("tavilyExtract", { ...tavilyExtractCfg, extractDepth: v })
                                        }
                                    >
                                        <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="basic">Basic</SelectItem>
                                            <SelectItem value="advanced">Advanced</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] text-muted-foreground">Format</span>
                                    <Select
                                        value={typeof tavilyExtractCfg.format === "string" ? tavilyExtractCfg.format : "markdown"}
                                        onValueChange={(v) =>
                                            void onUpdateToolConfig("tavilyExtract", { ...tavilyExtractCfg, format: v })
                                        }
                                    >
                                        <SelectTrigger className="h-7 w-28 cursor-pointer text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="markdown">Markdown</SelectItem>
                                            <SelectItem value="text">Plain text</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">
                                        API key <span className="text-muted-foreground/50">(or set TAVILY_API_KEY env)</span>
                                    </span>
                                    <Input
                                        type="password"
                                        className="h-7 font-mono text-xs"
                                        placeholder="tvly-…"
                                        value={tavilyExtractApiKey}
                                        onChange={(e) => setTavilyExtractApiKey(e.target.value)}
                                        onBlur={() => {
                                            const key = tavilyExtractApiKey.trim();
                                            const next = { ...tavilyExtractCfg };
                                            if (key) {
                                                next.apiKey = key;
                                            } else {
                                                delete next.apiKey;
                                            }
                                            void onUpdateToolConfig("tavilyExtract", next);
                                        }}
                                    />
                                </div>
                            </ExpandBlock>
                        )}

                        {/* Google Search */}
                        <ToggleRow
                            label="Google Search"
                            description={selectedProvider === "google" ? "Grounded search via Google" : "Requires Google provider"}
                            checked={googleSearchEnabled}
                            disabled={selectedProvider !== "google"}
                            onCheckedChange={(next) =>
                                void onUpdateToolConfig("googleSearch", { ...googleSearchCfg, enabled: next })
                            }
                        />
                        {googleSearchEnabled && selectedProvider === "google" && (
                            <ExpandBlock>
                                <ToggleRow
                                    label="Needs approval"
                                    checked={googleSearchCfg.needsApproval === true}
                                    onCheckedChange={(next) =>
                                        void onUpdateToolConfig("googleSearch", { ...googleSearchCfg, needsApproval: next })
                                    }
                                />
                            </ExpandBlock>
                        )}
                    </div>
                </>
            )}

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

            {/* Channels — inbound webhook integrations on the agent's `channels` branch */}
            {agentConfig && onUpdateChannelConfig && (
                <>
                    <Separator />
                    <ChannelsSection agentConfig={agentConfig} onUpdateChannel={onUpdateChannelConfig} />
                </>
            )}
        </div>
    );
}

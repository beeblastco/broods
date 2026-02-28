"use client";

/** Details tab showing editable agent name, deployment credentials, and built-in tool config. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import type { Doc } from "@/convex/_generated/dataModel";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useRef, useState } from "react";

/** Tavily search tool configuration. */
export type SearchToolConfig = {
    searchDepth?: string;
    topic?: string;
    maxResults?: number;
};

type OutputFormatConfig = {
    type?: string;
    schema?: unknown;
    name?: string;
    description?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function DetailsTab({
    agentConfig,
    activeDeployment,
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSaving,
    onToggleMemoryTool,
    onToggleSearchTool,
    onUpdateSearchToolConfig,
    onUpdateOutputFormat,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    activeDeployment: Doc<"agentDeployments"> | undefined;
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSaving: boolean;
    onToggleMemoryTool?: (enabled: boolean) => void;
    onToggleSearchTool?: (enabled: boolean) => void;
    onUpdateSearchToolConfig?: (config: SearchToolConfig) => void;
    onUpdateOutputFormat?: (outputFormat: Record<string, unknown> | null) => void;
}) {
    const [showApiKey, setShowApiKey] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [outputSchemaText, setOutputSchemaText] = useState("");
    const [hasEditedOutputSchema, setHasEditedOutputSchema] = useState(false);
    const [outputSchemaError, setOutputSchemaError] = useState<string | null>(null);
    const schemaFileInputRef = useRef<HTMLInputElement | null>(null);

    const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL ?? "http://localhost:8080";
    const envPrefix = activeDeployment?.environmentSlug ? `/${activeDeployment.environmentSlug}` : "";
    const projectPrefix = activeDeployment?.projectSlug ? `/${activeDeployment.projectSlug}` : "";
    const endpointUrl = activeDeployment ? `${gatewayUrl}/v1${projectPrefix}/agents${envPrefix}/${activeDeployment.endpointId}` : "";

    const searchConfig = agentConfig?.searchToolConfig as SearchToolConfig | undefined;
    const outputFormat = agentConfig?.outputFormat as OutputFormatConfig | undefined;
    const outputFormatEnabled = outputFormat !== undefined;
    const schemaFromConfigText = isRecord(outputFormat?.schema)
        ? JSON.stringify(outputFormat.schema, null, 2)
        : "";
    const displayOutputSchemaText = hasEditedOutputSchema
        ? outputSchemaText
        : schemaFromConfigText;

    function buildOutputFormatPayload(schema: Record<string, unknown>): Record<string, unknown> {
        const next: Record<string, unknown> = {
            type: "json_schema",
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
            setHasEditedOutputSchema(false);
            setOutputSchemaText("");
            onUpdateOutputFormat?.({ type: "json_schema" });
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

            {/* Deployment credentials */}
            {activeDeployment && (
                <>
                    <Separator />

                    {/* Endpoint URL */}
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

                    {/* Endpoint ID */}
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

                    {/* API Key with show/hide */}
                    {activeDeployment.apiKey && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">API Key</span>
                            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                                <code className="flex-1 text-xs text-foreground break-all">
                                    {showApiKey ? activeDeployment.apiKey : "\u2022".repeat(20)}
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
                                    onClick={() => handleCopy(activeDeployment.apiKey!, "apikey")}
                                >
                                    {copiedField === "apikey" ? <Check className="size-3" /> : <Copy className="size-3" />}
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Built-in tool toggles */}
            {agentConfig && (
                <>
                    <Separator />
                    <div className="flex flex-col gap-3">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Built-in Tools</span>

                        {/* Memory toggle */}
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground">Memory</span>
                                <span className="text-[11px] text-muted-foreground">Persistent memory across sessions</span>
                            </div>
                            <Switch
                                checked={agentConfig.memoryToolEnabled !== false}
                                onCheckedChange={(checked) => onToggleMemoryTool?.(checked)}
                            />
                        </div>

                        {/* Web Search toggle */}
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground">Web Search</span>
                                <span className="text-[11px] text-muted-foreground">Search the web via Tavily</span>
                            </div>
                            <Switch
                                checked={agentConfig.searchToolEnabled === true}
                                onCheckedChange={(checked) => onToggleSearchTool?.(checked)}
                            />
                        </div>

                        {/* Web Search config (only when enabled) */}
                        {agentConfig.searchToolEnabled === true && (
                            <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">
                                {/* Search Depth */}
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">Search Depth</span>
                                    <Select
                                        value={searchConfig?.searchDepth ?? "advanced"}
                                        onValueChange={(val) => onUpdateSearchToolConfig?.({ ...searchConfig, searchDepth: val })}
                                    >
                                        <SelectTrigger size="sm" className="h-7 w-full text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="basic">Basic</SelectItem>
                                            <SelectItem value="advanced">Advanced</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* Topic */}
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">Topic</span>
                                    <Select
                                        value={searchConfig?.topic ?? "general"}
                                        onValueChange={(val) => onUpdateSearchToolConfig?.({ ...searchConfig, topic: val })}
                                    >
                                        <SelectTrigger size="sm" className="h-7 w-full text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="general">General</SelectItem>
                                            <SelectItem value="news">News</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* Max Results */}
                                <div className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">Max Results</span>
                                    <Input
                                        type="number"
                                        min={1}
                                        max={20}
                                        value={searchConfig?.maxResults ?? 5}
                                        onChange={(e) => {
                                            const val = parseInt(e.target.value, 10);
                                            if (!isNaN(val) && val >= 1 && val <= 20) {
                                                onUpdateSearchToolConfig?.({ ...searchConfig, maxResults: val });
                                            }
                                        }}
                                        className="h-7 text-xs"
                                    />
                                </div>
                            </div>
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
        </div>
    );
}

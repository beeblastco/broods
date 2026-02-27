"use client";

/** Side panel displaying node details, configuration, and settings for the selected canvas node. */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { ConfigTab } from "@/app/components/side-panel/ConfigTab";
import { DetailsTab } from "@/app/components/side-panel/DetailsTab";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { TestTab } from "@/app/components/side-panel/TestTab";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { memo, useEffect, useState } from "react";

type NodeType = "agent" | "database" | "tool" | "workspace";

/** Panel header labels per node type. */
const PANEL_TITLES: Record<NodeType, string> = {
    agent: "Agent",
    database: "Database",
    tool: "Tool",
    workspace: "Workspace",
};

/** Config fields extracted from the agent config for JSON editing. */
const CONFIG_KEYS = [
    "modelId",
    "description",
    "systemPrompt",
    "maxTurns",
    "allowedTools",
    "disallowedTools",
    "permissionMode",
    "outputFormat",
    "providerOptions",
    "temperature",
    "maxTokens",
] as const;

/** Extracts editable config fields from the full agent config document. */
function extractConfigJson(config: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of CONFIG_KEYS) {
        if (config[key] !== undefined) {
            result[key] = config[key];
        }
    }

    return result;
}

export const NodeSidePanel = memo(function NodeSidePanel({
    node,
    onClose,
    onRemoveNode,
    onUpdateNodeLabel,
}: {
    node: Node | null;
    onClose: () => void;
    onRemoveNode: (nodeId: string) => void;
    onUpdateNodeLabel: (nodeId: string, label: string) => void;
}) {
    const nodeData = node?.data as BaseNodeData | undefined;
    const nodeType = (node?.type ?? "agent") as NodeType;
    const isAgent = nodeType === "agent";
    const agentConfigId = nodeData?.agentConfigId as Id<"agentConfigs"> | undefined;

    // Agent config for editable name (agent nodes only)
    const agentConfig = useQuery(
        api.agentConfig.getById,
        isAgent && agentConfigId ? { configId: agentConfigId } : "skip",
    );
    const updateConfig = useMutation(api.agentConfig.update);
    const removeConfig = useMutation(api.agentConfig.remove);

    // Deployment credentials (agent nodes only)
    const deployments = useQuery(
        api.agentDeployments.list,
        isAgent && agentConfigId ? { agentConfigId: agentConfigId } : "skip",
    );
    const activeDeployment = deployments?.find((d) => d.status === "active");

    // Editable name (agent uses agentConfig, others use canvas label)
    const [editName, setEditName] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // Config JSON editor (agent only)
    const [configJson, setConfigJson] = useState("");
    const [configError, setConfigError] = useState<string | null>(null);
    const [isSavingConfig, setIsSavingConfig] = useState(false);
    const [configSaved, setConfigSaved] = useState(false);

    // Sync name and config when config loads or node changes
    useEffect(() => {
        if (isAgent && agentConfig) {
            setEditName(agentConfig.name);
            setConfigJson(JSON.stringify(extractConfigJson(agentConfig), null, 2));
            setConfigError(null);
            setConfigSaved(false);
        } else if (!isAgent && nodeData) {
            setEditName(nodeData.label);
        }
    }, [agentConfig, node?.id, isAgent, nodeData]);

    const nameChanged = isAgent
        ? agentConfig && editName.trim() !== agentConfig.name
        : nodeData && editName.trim() !== nodeData.label;

    /** Whether the config JSON has been modified from the server value. */
    const configChanged = agentConfig
        && configJson !== JSON.stringify(extractConfigJson(agentConfig), null, 2);

    async function handleSaveName() {
        if (!editName.trim() || !nameChanged) return;

        if (isAgent && agentConfigId) {
            setIsSaving(true);
            try {
                await updateConfig({ configId: agentConfigId, name: editName.trim() });
            } finally {
                setIsSaving(false);
            }
        } else if (node) {
            onUpdateNodeLabel(node.id, editName.trim());
        }
    }

    async function handleSaveConfig() {
        if (!agentConfigId || !configChanged) return;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(configJson);
        } catch {
            setConfigError("Invalid JSON");

            return;
        }

        setConfigError(null);
        setIsSavingConfig(true);
        try {
            await updateConfig({
                configId: agentConfigId,
                modelId: parsed.modelId as string | undefined,
                description: parsed.description as string | undefined,
                systemPrompt: parsed.systemPrompt as string | undefined,
                temperature: parsed.temperature as number | undefined,
                maxTokens: parsed.maxTokens as number | undefined,
                maxTurns: parsed.maxTurns as number | undefined,
                allowedTools: parsed.allowedTools as string[] | undefined,
                disallowedTools: parsed.disallowedTools as string[] | undefined,
                outputFormat: parsed.outputFormat,
                providerOptions: parsed.providerOptions,
            });
            setConfigSaved(true);
            setTimeout(() => setConfigSaved(false), 2000);
        } finally {
            setIsSavingConfig(false);
        }
    }

    async function handleDelete() {
        if (isAgent && agentConfigId) {
            await removeConfig({ configId: agentConfigId });
        }
        if (node) {
            onRemoveNode(node.id);
        }
        onClose();
    }

    /** Resolved name for the SettingsTab delete confirmation. */
    const resolvedName = isAgent ? (agentConfig?.name ?? "") : (nodeData?.label ?? "");

    return (
        <div
            className={`absolute right-0 top-0 z-10 flex h-full w-1/3 flex-col border-l border-border bg-card transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"}`}
        >
            <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium text-foreground">{PANEL_TITLES[nodeType]}</h2>
                <button
                    onClick={onClose}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <Separator />

            {nodeData && (
                <Tabs defaultValue="details" className="flex flex-1 flex-col overflow-hidden">
                    <TabsList variant="line" className="w-full shrink-0 px-4 pt-2">
                        <TabsTrigger value="details">Details</TabsTrigger>
                        {isAgent && <TabsTrigger value="config">Config</TabsTrigger>}
                        {(isAgent || nodeType === "tool") && (
                            <TabsTrigger value="test">Test</TabsTrigger>
                        )}
                        <TabsTrigger value="settings">Settings</TabsTrigger>
                    </TabsList>

                    {/* Details tab — agent gets full details, others get simple name editor */}
                    <TabsContent value="details" className="flex flex-col overflow-y-auto">
                        {isAgent ? (
                            <DetailsTab
                                agentConfig={agentConfig}
                                activeDeployment={activeDeployment}
                                editName={editName}
                                setEditName={setEditName}
                                onSaveName={handleSaveName}
                                nameChanged={!!nameChanged}
                                isSaving={isSaving}
                            />
                        ) : (
                            <ServiceDetailsTab
                                editName={editName}
                                setEditName={setEditName}
                                onSaveName={handleSaveName}
                                nameChanged={!!nameChanged}
                                isSaving={isSaving}
                            />
                        )}
                    </TabsContent>

                    {/* Config tab — agent only */}
                    {isAgent && (
                        <TabsContent value="config" className="flex flex-col overflow-hidden">
                            <ConfigTab
                                configJson={configJson}
                                setConfigJson={setConfigJson}
                                configError={configError}
                                setConfigError={setConfigError}
                                configChanged={!!configChanged}
                                isSavingConfig={isSavingConfig}
                                configSaved={configSaved}
                                setConfigSaved={setConfigSaved}
                                onSaveConfig={handleSaveConfig}
                            />
                        </TabsContent>
                    )}

                    {/* Test tab — agent and tool only */}
                    {(isAgent || nodeType === "tool") && (
                        <TabsContent value="test" className="flex flex-col overflow-hidden">
                            {isAgent ? (
                                <TestTab
                                    activeDeployment={activeDeployment}
                                    nodeColor={nodeData?.properties?.color}
                                />
                            ) : (
                                <ToolTestPlaceholder />
                            )}
                        </TabsContent>
                    )}

                    {/* Settings tab — all node types */}
                    <TabsContent value="settings" className="flex flex-col overflow-y-auto">
                        <SettingsTab
                            nodeType={nodeType}
                            nodeName={resolvedName}
                            onDelete={handleDelete}
                        />
                    </TabsContent>
                </Tabs>
            )}
        </div>
    );
});

/** Simple details tab for non-agent nodes showing only an editable name. */
function ServiceDetailsTab({
    editName,
    setEditName,
    onSaveName,
    nameChanged,
    isSaving,
}: {
    editName: string;
    setEditName: (name: string) => void;
    onSaveName: () => void;
    nameChanged: boolean;
    isSaving: boolean;
}) {
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
                            disabled={!editName.trim() || isSaving}
                            onClick={onSaveName}
                        >
                            Save
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Placeholder test tab for tool nodes. */
function ToolTestPlaceholder() {
    return (
        <div className="flex flex-1 items-center justify-center p-4">
            <p className="text-center text-xs text-muted-foreground">
                Tool testing is not configured yet. Connect the tool to an agent to test input and output.
            </p>
        </div>
    );
}

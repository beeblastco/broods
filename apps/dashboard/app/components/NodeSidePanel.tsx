"use client";

/** Side panel displaying node details, configuration, and settings for the selected canvas node. */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { agentStatusConfig } from "@/app/components/node/BaseNode";
import { ConfigTab } from "@/app/components/side-panel/ConfigTab";
import { DetailsTab } from "@/app/components/side-panel/DetailsTab";
import { ToolConfigTab } from "@/app/components/side-panel/ToolConfigTab";
import { ToolDetailsTab } from "@/app/components/side-panel/ToolDetailsTab";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { useAgentHealth, type AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

/** Maps agent health status to Badge variant. */
const healthBadgeVariant: Record<AgentHealthStatus, "success" | "warning" | "secondary" | "destructive"> = {
    healthy: "success",
    deploying: "warning",
    idle: "secondary",
    unhealthy: "destructive",
};

const TestTab = dynamic(
    () => import("@/app/components/side-panel/TestTab").then((mod) => mod.TestTab),
    {
        loading: () => (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">Loading test tab…</p>
            </div>
        ),
    },
);

const ToolTestTab = dynamic(
    () => import("@/app/components/side-panel/ToolTestTab").then((mod) => mod.ToolTestTab),
    {
        loading: () => (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">Loading test tab…</p>
            </div>
        ),
    },
);

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
    "permissionMode",
    "outputFormat",
    "providerOptions",
    "temperature",
    "maxTokens",
    "memoryToolEnabled",
    "searchToolEnabled",
    "searchToolConfig",
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
    const isTool = nodeType === "tool";
    const { environmentId } = useEnvironment();
    const params = useParams<{ projectId: string }>();
    const projectId = params.projectId as Id<"projects"> | undefined;
    const agentConfigId = nodeData?.agentConfigId as Id<"agentConfigs"> | undefined;

    // Agent health status (agent nodes only)
    const healthStatus = useAgentHealth(isAgent ? agentConfigId : undefined);

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

    /** Memoised server-side config JSON to avoid JSON.stringify on every render. */
    const serverConfigJson = useMemo(
        () => agentConfig ? JSON.stringify(extractConfigJson(agentConfig), null, 2) : "",
        [agentConfig],
    );

    /** Whether the config JSON has been modified from the server value. */
    const configChanged = agentConfig && configJson !== serverConfigJson;

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
                outputFormat: parsed.outputFormat,
                providerOptions: parsed.providerOptions,
                memoryToolEnabled: parsed.memoryToolEnabled as boolean | undefined,
                searchToolEnabled: parsed.searchToolEnabled as boolean | undefined,
                searchToolConfig: parsed.searchToolConfig as { searchDepth?: string; topic?: string; maxResults?: number } | undefined,
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

    const handleToggleMemoryTool = useCallback(
        (enabled: boolean) => {
            if (agentConfigId) {
                updateConfig({ configId: agentConfigId, memoryToolEnabled: enabled });
            }
        },
        [agentConfigId, updateConfig],
    );

    const handleToggleSearchTool = useCallback(
        (enabled: boolean) => {
            if (agentConfigId) {
                updateConfig({ configId: agentConfigId, searchToolEnabled: enabled });
            }
        },
        [agentConfigId, updateConfig],
    );

    const handleUpdateSearchToolConfig = useCallback(
        (config: { searchDepth?: string; topic?: string; maxResults?: number }) => {
            if (agentConfigId) {
                updateConfig({ configId: agentConfigId, searchToolConfig: config });
            }
        },
        [agentConfigId, updateConfig],
    );

    const handleUpdateOutputFormat = useCallback(
        (outputFormat: Record<string, unknown> | null) => {
            if (agentConfigId) {
                updateConfig({ configId: agentConfigId, outputFormat: outputFormat });
            }
        },
        [agentConfigId, updateConfig],
    );

    /** Resolved name for the SettingsTab delete confirmation. */
    const resolvedName = isAgent ? (agentConfig?.name ?? "") : (nodeData?.label ?? "");

    return (
        <div
            className={`absolute right-0 top-0 z-10 flex h-full w-1/3 flex-col border-l border-border bg-card transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"}`}
        >
            <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-medium text-foreground">{PANEL_TITLES[nodeType]}</h2>
                    {isAgent && (
                        <Badge variant={healthBadgeVariant[healthStatus]} className="gap-1.5 text-[10px] py-0">
                            <span className={`size-1.5 rounded-full ${agentStatusConfig[healthStatus].color}`} />
                            {agentStatusConfig[healthStatus].text}
                        </Badge>
                    )}
                </div>
                <Button variant="ghost" size="icon-xs" onClick={onClose}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <Separator />

            {nodeData && (
                <Tabs defaultValue="details" className="flex flex-1 flex-col overflow-hidden">
                    <TabsList variant="line" className="w-full shrink-0 px-4 pt-2">
                        <TabsTrigger value="details">Details</TabsTrigger>
                        {(isAgent || isTool) && <TabsTrigger value="config">Config</TabsTrigger>}
                        {(isAgent || nodeType === "tool") && (
                            <TabsTrigger value="test">Test</TabsTrigger>
                        )}
                        <TabsTrigger value="settings">Settings</TabsTrigger>
                    </TabsList>

                    {/* Details tab */}
                    <TabsContent value="details" className="flex flex-col overflow-y-auto">
                        {isAgent ? (
                            <DetailsTab
                                key={agentConfigId ?? "agent-details"}
                                agentConfig={agentConfig}
                                activeDeployment={activeDeployment}
                                editName={editName}
                                setEditName={setEditName}
                                onSaveName={handleSaveName}
                                nameChanged={!!nameChanged}
                                isSaving={isSaving}
                                onToggleMemoryTool={handleToggleMemoryTool}
                                onToggleSearchTool={handleToggleSearchTool}
                                onUpdateSearchToolConfig={handleUpdateSearchToolConfig}
                                onUpdateOutputFormat={handleUpdateOutputFormat}
                            />
                        ) : isTool && node ? (
                            <ToolDetailsTab
                                projectId={projectId}
                                environmentId={environmentId}
                                nodeId={node.id}
                                nodeLabel={editName || nodeData.label}
                                editName={editName}
                                setEditName={setEditName}
                                onSaveName={handleSaveName}
                                nameChanged={!!nameChanged}
                                isSavingName={isSaving}
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

                    {/* Config tab — agent and tool */}
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
                    {isTool && node && (
                        <TabsContent value="config" className="flex flex-col overflow-hidden">
                            <ToolConfigTab
                                projectId={projectId}
                                environmentId={environmentId}
                                nodeId={node.id}
                                nodeLabel={editName || nodeData.label}
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
                            ) : node ? (
                                <ToolTestTab
                                    projectId={projectId}
                                    environmentId={environmentId}
                                    nodeId={node.id}
                                />
                            ) : null}
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

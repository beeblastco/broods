"use client";

/** Side panel displaying agent details and deployment credentials for a selected node. */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { ConfigTab } from "@/app/components/side-panel/ConfigTab";
import { DetailsTab } from "@/app/components/side-panel/DetailsTab";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { TestTab } from "@/app/components/side-panel/TestTab";
import { Separator } from "@/app/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

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

    // Config JSON editor
    const [configJson, setConfigJson] = useState("");
    const [configError, setConfigError] = useState<string | null>(null);
    const [isSavingConfig, setIsSavingConfig] = useState(false);
    const [configSaved, setConfigSaved] = useState(false);

    // Sync name and config when config loads or node changes
    useEffect(() => {
        if (agentConfig) {
            setEditName(agentConfig.name);
            setConfigJson(JSON.stringify(extractConfigJson(agentConfig), null, 2));
            setConfigError(null);
            setConfigSaved(false);
        }
    }, [agentConfig, node?.id]);

    const nameChanged = agentConfig && editName.trim() !== agentConfig.name;

    /** Whether the config JSON has been modified from the server value. */
    const configChanged = agentConfig
        && configJson !== JSON.stringify(extractConfigJson(agentConfig), null, 2);

    async function handleSaveName() {
        if (!agentConfigId || !nameChanged || !editName.trim()) return;
        setIsSaving(true);
        try {
            await updateConfig({ configId: agentConfigId, name: editName.trim() });
        } finally {
            setIsSaving(false);
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
        if (!agentConfigId) return;
        await removeConfig({ configId: agentConfigId });
        onClose();
    }

    return (
        <div
            className={`absolute right-0 top-0 z-10 flex h-full w-1/3 flex-col border-l border-border bg-card transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"}`}
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
                <Tabs defaultValue="details" className="flex flex-1 flex-col overflow-hidden">
                    <TabsList variant="line" className="w-full shrink-0 px-4 pt-2">
                        <TabsTrigger value="details">Details</TabsTrigger>
                        <TabsTrigger value="config">Config</TabsTrigger>
                        <TabsTrigger value="test">Test</TabsTrigger>
                        <TabsTrigger value="settings">Settings</TabsTrigger>
                    </TabsList>

                    <TabsContent value="details" className="flex flex-col overflow-y-auto">
                        <DetailsTab
                            agentConfig={agentConfig}
                            activeDeployment={activeDeployment}
                            editName={editName}
                            setEditName={setEditName}
                            onSaveName={handleSaveName}
                            nameChanged={!!nameChanged}
                            isSaving={isSaving}
                        />
                    </TabsContent>

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

                    <TabsContent value="test" className="flex flex-col overflow-hidden">
                        <TestTab
                            activeDeployment={activeDeployment}
                            nodeColor={nodeData?.properties?.color}
                        />
                    </TabsContent>

                    <TabsContent value="settings" className="flex flex-col overflow-y-auto">
                        {agentConfigId && (
                            <SettingsTab
                                agentConfig={agentConfig}
                                onDelete={handleDelete}
                            />
                        )}
                    </TabsContent>
                </Tabs>
            )}
        </div>
    );
}

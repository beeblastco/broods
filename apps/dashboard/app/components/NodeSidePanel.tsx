"use client";

import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { IconTooltip } from "@/app/components/IconTooltip";
import { useShortcut } from "@/app/components/ShortcutProvider";
import type { NodeType } from "@/app/components/canvas/nodeTemplates";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import {
  agentStatusConfig,
  statusConfig,
} from "@/app/components/node/BaseNode";
import {
  CONFIG_TAB_BRANCHES,
  ConfigTab,
} from "@/app/components/side-panel/ConfigTab";
import {
  DetailsTab,
  type AgentProvider,
} from "@/app/components/side-panel/DetailsTab";
import {
  ResourceConfigTab,
  SandboxResourceDetailsTab,
  WorkspaceResourceDetailsTab,
} from "@/app/components/side-panel/ResourceNodeTabs";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { SkillConfigTab } from "@/app/components/side-panel/SkillConfigTab";
import { SkillDetailsTab } from "@/app/components/side-panel/SkillDetailsTab";
import { SkillFilesTab } from "@/app/components/side-panel/SkillFilesTab";
import { McpDetailsTab } from "@/app/components/side-panel/McpDetailsTab";
import { PoliciesTab } from "@/app/components/side-panel/PoliciesTab";
import { McpTab } from "@/app/components/side-panel/McpTab";
import { WorkspaceFilesTab } from "@/app/components/side-panel/WorkspaceFilesTab";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Separator } from "@/app/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  useAgentHealth,
  type AgentHealthStatus,
} from "@/app/hooks/useAgentHealth";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import { useNodeOwnership } from "@/app/hooks/useNodeOwnership";
import { useStage } from "@/app/hooks/useStage";
import { useStageSession } from "@/app/hooks/useStageSession";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import {
  applyModelReasoning,
  fromNestedAgentConfig,
  readAgentBranch,
  readAgentPolicies,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import { includesSkillRef } from "@/app/lib/skillRefs";
import { reportPerf } from "@/app/lib/perfReport";
import { isPlainObject } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { providerApiKeyEnvName } from "@broods/convex/model/modelProviders";
import type { Node } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

const nodeStatusBadgeVariant: Record<
  "running" | "idle" | "error",
  "success" | "secondary" | "destructive"
> = {
  running: "success",
  idle: "secondary",
  error: "destructive",
};

const healthBadgeVariant: Record<
  AgentHealthStatus,
  "success" | "warning" | "secondary" | "destructive"
> = {
  healthy: "success",
  deploying: "warning",
  idle: "secondary",
  unhealthy: "destructive",
};

const loadAgentTestTab = () =>
  import("@/app/components/side-panel/TestTab").then((mod) => mod.TestTab);

const loadMcpToolsTab = () =>
  import("@/app/components/side-panel/McpToolsTab").then(
    (mod) => mod.McpToolsTab,
  );

const TestTab = dynamic(loadAgentTestTab, {
  loading: () => (
    <div className="flex flex-1 items-center justify-center p-4">
      <p className="text-center text-xs text-muted-foreground">
        Loading test tab…
      </p>
    </div>
  ),
});

const McpToolsTab = dynamic(loadMcpToolsTab, {
  loading: () => (
    <div className="flex flex-1 items-center justify-center p-4">
      <p className="text-center text-xs text-muted-foreground">
        Loading tools…
      </p>
    </div>
  ),
});

interface PanelTab {
  label: string;
  value: string;
  warms?: boolean;
}

type HeaderStatusBadge = {
  text: string;
  color: string;
  variant: "success" | "warning" | "secondary" | "destructive";
};

const PANEL_TITLES: Record<NodeType, string> = {
  agent: "Agent",
  mcp: "MCP Server",
  workspace: "Workspace",
  sandbox: "Sandbox",
  skill: "Skill",
};

export const NodeSidePanel = memo(function NodeSidePanel({
  node,
  selectedAt,
  onClose,
  onRequestDelete,
  onUpdateNodeLabel,
  onUpdateNodeData,
}: {
  node: Node | null;
  /** `performance.now()` of the selecting click. */
  selectedAt: number;
  onClose: () => void;
  onRequestDelete: (nodeId: string) => void;
  onUpdateNodeLabel: (nodeId: string, label: string) => void;
  onUpdateNodeData: (nodeId: string, patch: Partial<BaseNodeData>) => void;
}): React.JSX.Element {
  const nodeData = node?.data as BaseNodeData | undefined;
  const nodeType = (node?.type ?? "agent") as NodeType;
  const isAgent = nodeType === "agent";
  const isMcp = nodeType === "mcp";
  const isWorkspace = nodeType === "workspace";
  const isSandbox = nodeType === "sandbox";
  const isSkill = nodeType === "skill";
  const { stageId } = useStage();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const agentConfigId = nodeData?.agentConfigId as
    | Id<"agentConfigs">
    | undefined;
  const nodeId = node?.id;
  const resourceId = nodeData?.resourceId;
  const canQueryMcpStatus = isMcp && !!projectId && !!stageId && !!nodeId;

  const measuredSelection = useRef(0);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- perf beacon, click to commit
  useEffect((): void => {
    if (!nodeId || !selectedAt || measuredSelection.current === selectedAt)
      return;

    measuredSelection.current = selectedAt;
    reportPerf("side-panel.open", performance.now() - selectedAt, {
      attributes: { node_type: nodeType },
    });
  }, [nodeId, nodeType, selectedAt]);

  const healthStatus = useAgentHealth(isAgent ? agentConfigId : undefined);

  const { agentConfig: connectedAgentConfig } = useConnectedAgentConfig(
    isSkill ? nodeId : undefined,
  );

  const infraAnalysis = useInfraAnalysis();
  const isConnectedToAgent =
    nodeType === "agent" ||
    !nodeId ||
    (infraAnalysis.connectedToAgent[nodeId] ?? false);

  const { agentConfig, codeOwner, isCodeManaged, isOwnershipLoading } =
    useNodeOwnership(node);
  const updateConfig = useMutation(
    api.agent.config.update,
  ).withOptimisticUpdate(applyAgentConfigUpdate);
  const ensureDeployment = useMutation(api.agent.deployments.ensureForStage);
  const rotateDeployment = useMutation(api.agent.deployments.rotate);

  const activeDeployment =
    useQuery(
      api.agent.deployments.getForStage,
      isAgent && projectId && stageId
        ? { projectId: projectId, stageId: stageId }
        : "skip",
    ) ?? undefined;
  const stageSession = useStageSession(
    projectId,
    isAgent && projectId && stageId ? stageId : null,
  );

  const mcpServer = useQuery(
    api.mcp.getByNode,
    canQueryMcpStatus
      ? {
          projectId: projectId,
          stageId: stageId,
          nodeId: nodeId,
        }
      : "skip",
  );
  const { canWrite } = useOrgRole();

  const [editName, setEditName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [isSavingKey, setIsSavingKey] = useState(false);
  const [deploymentApiKey, setDeploymentApiKey] = useState<string | undefined>(
    undefined,
  );
  const [activeTab, setActiveTab] = useState("details");

  // nameSource is never undefined, so the first render syncs the name too.
  const nameSource = isAgent ? (agentConfig ?? null) : (nodeData ?? null);
  const [syncedNameSource, setSyncedNameSource] = useState<unknown>(undefined);
  if (nameSource !== syncedNameSource) {
    setSyncedNameSource(nameSource);
    if (isAgent && agentConfig) {
      setEditName(agentConfig.name);
    } else if (!isAgent && nodeData) {
      setEditName(nodeData.label);
    }
  }

  const [tabSyncedNodeId, setTabSyncedNodeId] = useState(node?.id);
  if (node?.id !== tabSyncedNodeId) {
    setTabSyncedNodeId(node?.id);
    setActiveTab("details");
  }

  const deploymentKeySync = activeDeployment?.endpointId ?? "";
  const [syncedDeploymentKey, setSyncedDeploymentKey] =
    useState(deploymentKeySync);
  if (deploymentKeySync !== syncedDeploymentKey) {
    setSyncedDeploymentKey(deploymentKeySync);
    setDeploymentApiKey(undefined);
  }
  const resolvedDeploymentApiKey =
    deploymentApiKey ?? stageSession ?? undefined;

  const nameChanged = isAgent
    ? agentConfig && editName.trim() !== agentConfig.name
    : nodeData && editName.trim() !== nodeData.label;

  const selectedProvider = useMemo<AgentProvider>(() => {
    if (!agentConfig) return "openai";

    const provider = agentConfig.provider as AgentProvider | undefined;
    if (provider) {
      return provider;
    }

    return inferProviderFromModelId(agentConfig.modelId ?? "");
  }, [agentConfig]);
  const headerStatus = useMemo<HeaderStatusBadge | null>(() => {
    if (isAgent) {
      const config = agentStatusConfig[healthStatus];

      return {
        text: config.text,
        color: config.color,
        variant: healthBadgeVariant[healthStatus],
      };
    }

    if (isMcp) {
      if (!canQueryMcpStatus || mcpServer === undefined) {
        return {
          text: "Loading",
          color: "bg-muted-foreground",
          variant: "secondary",
        };
      }

      const isServerEnabled = !!mcpServer && mcpServer.disabled !== true;

      return {
        text: isServerEnabled ? "Enabled" : "Disabled",
        color: isServerEnabled ? "bg-success" : "bg-muted-foreground",
        variant: isServerEnabled ? "success" : "secondary",
      };
    }

    if (!isConnectedToAgent) {
      return {
        text: "Unconnected",
        color: "bg-destructive",
        variant: "destructive",
      };
    }

    if (isSkill) {
      const skills = readAgentBranch<{ enabled?: boolean; allowed?: string[] }>(
        connectedAgentConfig as FlatAgentConfig | undefined,
        "skills",
      );
      const path = (nodeData?.label ?? "").trim();
      const enabled =
        skills.enabled === true && includesSkillRef(skills.allowed, path);

      return {
        text: enabled ? "Enabled" : "Disabled",
        color: enabled ? "bg-success" : "bg-destructive",
        variant: enabled ? "success" : "secondary",
      };
    }

    const nodeStatus = nodeData?.status ?? "idle";

    return {
      text: statusConfig[nodeStatus].text,
      color: statusConfig[nodeStatus].color,
      variant: nodeStatusBadgeVariant[nodeStatus],
    };
  }, [
    isAgent,
    healthStatus,
    isMcp,
    canQueryMcpStatus,
    mcpServer,
    isConnectedToAgent,
    isSkill,
    connectedAgentConfig,
    nodeData?.status,
    nodeData?.label,
  ]);

  async function handleSaveName(): Promise<void> {
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

  const handleSaveConfig = useCallback(
    async (value: unknown) => {
      if (!agentConfigId || !agentConfig) return;

      const edited = (value as Record<string, unknown>) ?? {};
      const base = toNestedAgentConfig(agentConfig) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...base };
      for (const branch of CONFIG_TAB_BRANCHES) {
        if (branch in edited) {
          merged[branch] = edited[branch];
        } else {
          delete merged[branch];
        }
      }
      const patch = fromNestedAgentConfig(merged);
      await updateConfig({
        configId: agentConfigId,
        provider: patch.provider as AgentProvider | undefined,
        modelId: patch.modelId,
        systemPrompt: patch.systemPrompt,
        temperature: patch.temperature,
        maxTokens: patch.maxTokens,
        maxTurns: patch.maxTurns,
        outputFormat: patch.outputFormat,
        providerOptions: patch.providerOptions,
        memoryToolEnabled: patch.memoryToolEnabled,
        searchToolEnabled: patch.searchToolEnabled,
        searchToolConfig: patch.searchToolConfig,
        extraConfig: patch.extraConfig,
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );

  async function handleSaveModelSettings(next: {
    provider: AgentProvider;
    modelId: string;
    customBaseUrl?: string;
  }): Promise<void> {
    if (!agentConfigId) return;

    const base = agentConfig
      ? (toNestedAgentConfig(agentConfig) as Record<string, unknown>)
      : {};
    const currentProvider = readAgentBranch<
      Partial<Record<AgentProvider, Record<string, unknown>>>
    >(agentConfig, "provider");
    // No key yet: read the `${NAME}` stage variable, as a newly created agent does.
    const keyVariable = providerApiKeyEnvName(next.provider);
    const nextProviderConfig = {
      ...currentProvider,
      [next.provider]: {
        ...(keyVariable ? { apiKey: `\${${keyVariable}}` } : {}),
        ...currentProvider[next.provider],
        ...(next.provider === "custom"
          ? { base_url: next.customBaseUrl, baseURL: next.customBaseUrl }
          : {}),
      },
    };
    const patch = fromNestedAgentConfig({
      ...base,
      model: {
        ...(isPlainObject(base.model) ? base.model : {}),
        provider: next.provider,
        modelId: next.modelId,
      },
      provider: nextProviderConfig,
    });

    await updateConfig({
      configId: agentConfigId,
      provider: next.provider,
      modelId: next.modelId,
      extraConfig: patch.extraConfig,
    });
  }

  const cliManagedNames = useQuery(
    api.canvas.cliManagedResourceNames,
    (isAgent || isWorkspace || isSandbox) && projectId && stageId
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );
  const currentResourceName = isAgent
    ? agentConfig?.name
    : (nodeData?.mountName ?? nodeData?.label);
  const collidesWithCode =
    !isCodeManaged &&
    !!currentResourceName &&
    !!cliManagedNames &&
    (isAgent || isWorkspace || isSandbox) &&
    cliManagedNames[nodeType as "agent" | "workspace" | "sandbox"].includes(
      currentResourceName,
    );

  const handleUpdateOutputFormat = useCallback(
    (outputFormat: Record<string, unknown> | null) => {
      if (agentConfigId) {
        void updateConfig({
          configId: agentConfigId,
          outputFormat: outputFormat,
        }).catch((error: unknown): void => {
          console.error("Failed to update output format", error);
        });
      }
    },
    [agentConfigId, updateConfig],
  );

  // The plaintext comes back once: keep it so the panel can reveal it until the next rotation.
  const ensureRuntimeKey = useCallback(
    async (rotate: boolean) => {
      // false tells the caller nothing was minted, so a no-op never reads as a rotation.
      if (!isAgent || !projectId || !stageId) return false;

      setIsSavingKey(true);
      try {
        const result = rotate
          ? await rotateDeployment({
              projectId: projectId,
              stageId: stageId,
            })
          : await ensureDeployment({
              projectId: projectId,
              stageId: stageId,
            });
        if (result?.rawApiKey) {
          setDeploymentApiKey(result.rawApiKey);
        }

        return true;
      } finally {
        setIsSavingKey(false);
      }
    },
    [isAgent, projectId, stageId, ensureDeployment, rotateDeployment],
  );
  const handleGenerateKey = useCallback(
    () => ensureRuntimeKey(false),
    [ensureRuntimeKey],
  );
  const handleRotateKey = useCallback(
    () => ensureRuntimeKey(true),
    [ensureRuntimeKey],
  );

  const handleUpdateToolConfig = useCallback(
    async (toolName: string, config: Record<string, unknown> | null) => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentTools =
        (currentExtra.tools as Record<string, unknown>) ?? {};
      const nextTools = { ...currentTools };
      if (config === null) {
        delete nextTools[toolName];
      } else {
        nextTools[toolName] = config;
      }
      await updateConfig({
        configId: agentConfigId,
        extraConfig: {
          ...currentExtra,
          tools: Object.keys(nextTools).length > 0 ? nextTools : undefined,
        },
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );

  const handleUpdateExtraEntry = useCallback(
    async (
      key: "publicAccess" | "browser",
      value: boolean | { enabled: true } | undefined,
    ): Promise<void> => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      await updateConfig({
        configId: agentConfigId,
        extraConfig: { ...currentExtra, [key]: value },
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );

  const handleUpdatePolicyConfig = useCallback(
    async (policies: string[] | null) => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      await updateConfig({
        configId: agentConfigId,
        extraConfig: {
          ...currentExtra,
          policies: policies ?? undefined,
        },
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );

  const handleUpdateModelReasoning = useCallback(
    async (next: { budgetTokens?: number; effort?: string }) => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const nextModel = applyModelReasoning(
        (currentExtra.model as Record<string, unknown>) ?? {},
        selectedProvider,
        next,
      );
      await updateConfig({
        configId: agentConfigId,
        extraConfig: {
          ...currentExtra,
          model: Object.keys(nextModel).length > 0 ? nextModel : undefined,
        },
      });
    },
    [agentConfigId, agentConfig, selectedProvider, updateConfig],
  );

  const handleUpdateChannelConfig = useCallback(
    async (kind: string, config: Record<string, unknown> | null) => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentChannels =
        (currentExtra.channels as Record<string, unknown>) ?? {};
      const nextChannels = { ...currentChannels };
      if (config === null) {
        delete nextChannels[kind];
      } else {
        nextChannels[kind] = config;
      }
      await updateConfig({
        configId: agentConfigId,
        extraConfig: {
          ...currentExtra,
          channels:
            Object.keys(nextChannels).length > 0 ? nextChannels : undefined,
        },
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );

  // Tab intent only: warming on open fetches the heavy chat bundle for every panel view.
  const warmTestTab = useCallback(() => {
    if (isAgent) {
      void loadAgentTestTab();

      return;
    }

    if (isMcp) {
      void loadMcpToolsTab();
    }
  }, [isAgent, isMcp]);

  const visibleTabs = useMemo((): readonly PanelTab[] => {
    const hasSkillFiles =
      isSkill && (nodeData?.config?.skillSource ?? "") === "files";

    return [
      { label: "Details", value: "details" },
      ...(isWorkspace || hasSkillFiles
        ? [{ label: "Files", value: "files" }]
        : []),
      ...(isMcp ? [{ label: "Server", value: "server" }] : []),
      ...(isAgent || isWorkspace || isSandbox || isSkill
        ? [{ label: "Config", value: "config" }]
        : []),
      ...(isMcp ? [{ label: "Tools", value: "tools", warms: true }] : []),
      ...(isAgent ? [{ label: "Policies", value: "policies" }] : []),
      ...(isAgent ? [{ label: "Test", value: "test", warms: true }] : []),
      ...(canWrite ? [{ label: "Settings", value: "settings" }] : []),
    ];
  }, [canWrite, isAgent, isMcp, isSandbox, isSkill, isWorkspace, nodeData]);

  useShortcut("panel.toggle", onClose);
  useShortcut("panel.tab", (event) => {
    const tab = visibleTabs[Number(event.key) - 1];
    if (tab) setActiveTab(tab.value);
  });

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            {PANEL_TITLES[nodeType] ?? "Node"}
          </h2>
          {headerStatus && (
            <Badge variant={headerStatus.variant} className="text-3xs">
              <span className={`size-1.5 rounded-full ${headerStatus.color}`} />
              {headerStatus.text}
            </Badge>
          )}
        </div>
        <IconTooltip label="Close panel">
          <Button
            variant="ghost"
            size="icon-xs"
            className="cursor-pointer"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </IconTooltip>
      </div>

      <Separator />

      {isCodeManaged && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2.5">
          <p className="text-sm text-warning">
            {codeOwner === "api"
              ? "Managed through the account API, edits re-sync on every API write, delete is locked."
              : "Managed by broods packages, edits sync on deploy, delete is locked."}
          </p>
        </div>
      )}

      {collidesWithCode && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2.5">
          <p className="text-sm text-warning">
            Name matches a code-managed {nodeType}, next deploy overwrites this.
            Rename to keep it.
          </p>
        </div>
      )}

      {nodeData && (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <TabsList variant="line" className="w-full shrink-0 px-4 pt-2">
            {visibleTabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                onMouseEnter={tab.warms ? warmTestTab : undefined}
                onFocus={tab.warms ? warmTestTab : undefined}
                onPointerDown={tab.warms ? warmTestTab : undefined}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent
            value="details"
            className="flex flex-col overflow-y-auto"
            render={<fieldset disabled={!canWrite} />}
          >
            {isAgent ? (
              <DetailsTab
                key={`${agentConfigId ?? "agent-details"}-${selectedProvider}-${agentConfig?.modelId ?? ""}`}
                agentConfig={agentConfig}
                projectId={projectId}
                stageId={stageId}
                activeDeployment={activeDeployment}
                deploymentApiKey={resolvedDeploymentApiKey}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateOutputFormat={handleUpdateOutputFormat}
                onGenerateKey={handleGenerateKey}
                onRotateKey={handleRotateKey}
                isSavingKey={isSavingKey}
                selectedProvider={selectedProvider}
                onSaveModelSettings={handleSaveModelSettings}
                onUpdateToolConfig={handleUpdateToolConfig}
                onUpdateChannelConfig={handleUpdateChannelConfig}
                onUpdateModelReasoning={handleUpdateModelReasoning}
                onUpdatePublicAccess={(enabled) =>
                  handleUpdateExtraEntry("publicAccess", enabled)
                }
                onUpdateBrowser={(enabled) =>
                  handleUpdateExtraEntry(
                    "browser",
                    enabled ? { enabled: true } : undefined,
                  )
                }
              />
            ) : isMcp && node ? (
              <McpDetailsTab
                projectId={projectId}
                stageId={stageId}
                nodeId={node.id}
                nodeLabel={editName || nodeData.label}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                nameChanged={!!nameChanged}
                isSavingName={isSaving}
              />
            ) : isWorkspace && node ? (
              <WorkspaceResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeData={(patch): void =>
                  onUpdateNodeData(node.id, patch)
                }
              />
            ) : isSandbox && node ? (
              <SandboxResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                managedByCode={isCodeManaged}
                onUpdateNodeData={(patch): void =>
                  onUpdateNodeData(node.id, patch)
                }
              />
            ) : isSkill && node ? (
              <SkillDetailsTab
                nodeId={node.id}
                nodeConfig={nodeData?.config}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeConfig={(patch): void =>
                  onUpdateNodeData(node.id, {
                    config: { ...nodeData?.config, ...patch },
                  })
                }
                onUpdateSkillPath={(p): void => {
                  setEditName(p);
                  onUpdateNodeLabel(node.id, p);
                }}
              />
            ) : null}
          </TabsContent>

          {isWorkspace && node && (
            <TabsContent
              value="files"
              className="flex flex-col overflow-hidden"
            >
              <WorkspaceFilesTab
                projectId={projectId}
                nodeId={node.id}
                workspaceId={resourceId}
              />
            </TabsContent>
          )}

          {isSkill && node && (
            <TabsContent
              value="files"
              className="flex flex-col overflow-hidden"
            >
              <SkillFilesTab
                projectId={projectId}
                nodeId={node.id}
                skillPath={editName}
                onUpdateSkillPath={(path): void => {
                  setEditName(path);
                  onUpdateNodeLabel(node.id, path);
                }}
              />
            </TabsContent>
          )}

          {isAgent && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <ConfigTab agentConfig={agentConfig} onSave={handleSaveConfig} />
            </TabsContent>
          )}
          {isMcp && node && (
            <TabsContent
              value="server"
              className="flex flex-col overflow-hidden"
            >
              <McpTab
                projectId={projectId}
                stageId={stageId}
                nodeId={node.id}
                nodeLabel={editName || nodeData.label}
              />
            </TabsContent>
          )}
          {(isWorkspace || isSandbox) && node && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <ResourceConfigTab
                nodeType={isWorkspace ? "workspace" : "sandbox"}
                data={nodeData}
                onUpdateNodeData={(patch): void =>
                  onUpdateNodeData(node.id, patch)
                }
              />
            </TabsContent>
          )}
          {isSkill && node && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <SkillConfigTab nodeId={node.id} />
            </TabsContent>
          )}

          {isMcp && node && (
            <TabsContent
              value="tools"
              className="flex flex-col overflow-hidden"
            >
              <McpToolsTab
                projectId={projectId}
                stageId={stageId}
                nodeId={node.id}
              />
            </TabsContent>
          )}
          {isAgent && (
            <TabsContent
              value="policies"
              className="flex flex-col overflow-y-auto"
            >
              <PoliciesTab
                assignedPolicyIds={readAgentPolicies(agentConfig?.extraConfig)}
                onUpdatePolicyConfig={
                  canWrite ? handleUpdatePolicyConfig : undefined
                }
              />
            </TabsContent>
          )}

          {isAgent && (
            <TabsContent value="test" className="flex flex-col overflow-hidden">
              <TestTab
                activeDeployment={activeDeployment}
                // Ticket first: core limits the permanent key's run overrides.
                deploymentApiKey={stageSession ?? deploymentApiKey}
                agentId={agentConfigId ?? ""}
                nodeColor={nodeData?.properties?.color}
              />
            </TabsContent>
          )}

          {canWrite && (
            <TabsContent
              value="settings"
              className="flex flex-col overflow-y-auto"
            >
              <SettingsTab
                nodeType={nodeType}
                onDelete={() => node && onRequestDelete(node.id)}
                managedByCode={isCodeManaged}
                codeOwner={codeOwner}
                deleteLocked={isCodeManaged || isOwnershipLoading}
              />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
});

function inferProviderFromModelId(modelId: string): AgentProvider {
  const normalized = modelId.trim().toLowerCase();

  if (
    normalized.startsWith("bedrock/") ||
    normalized.startsWith("anthropic.") ||
    normalized.startsWith("amazon.") ||
    normalized.startsWith("cohere.") ||
    normalized.startsWith("mistral.") ||
    normalized.startsWith("meta.") ||
    normalized.startsWith("us.")
  ) {
    return "bedrock";
  }
  if (normalized.startsWith("google/") || normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.startsWith("anthropic/") || normalized.includes("claude")) {
    return "anthropic";
  }

  return "openai";
}

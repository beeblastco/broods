"use client";

/** Side panel displaying node details, configuration, and settings for the selected canvas node. */
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { agentStatusConfig } from "@/app/components/node/BaseNode";
import { ConfigTab } from "@/app/components/side-panel/ConfigTab";
import {
  DetailsTab,
  type AgentProvider,
} from "@/app/components/side-panel/DetailsTab";
import {
  ResourceConfigTab,
  SandboxResourceDetailsTab,
  WorkspaceResourceDetailsTab,
} from "@/app/components/side-panel/ResourceNodeTabs";
import { SessionDetailsTab } from "@/app/components/side-panel/SessionDetailsTab";
import {
  SettingsTab,
  type NodeType,
} from "@/app/components/side-panel/SettingsTab";
import { SkillConfigTab } from "@/app/components/side-panel/SkillConfigTab";
import { SkillDetailsTab } from "@/app/components/side-panel/SkillDetailsTab";
import { SkillFilesTab } from "@/app/components/side-panel/SkillFilesTab";
import { McpDetailsTab } from "@/app/components/side-panel/McpDetailsTab";
import { McpTab } from "@/app/components/side-panel/McpTab";
import { WorkspaceFilesTab } from "@/app/components/side-panel/WorkspaceFilesTab";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
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
import { useStage } from "@/app/hooks/useStage";
import {
  applyModelReasoning,
  fromNestedAgentConfig,
  readAgentBranch,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import {
  isRuntimeVariable,
  type RuntimeVariable,
} from "@/app/lib/runtimeVariables";
import { includesSkillRef } from "@/app/lib/skillRefs";
import { reportPerf } from "@/app/lib/perfReport";
import { isPlainObject } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useAction, useMutation, useQuery } from "convex/react";
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

const nodeStatusBadgeColor: Record<"running" | "idle" | "error", string> = {
  running: "bg-emerald-500",
  idle: "bg-zinc-500",
  error: "bg-red-500",
};

const nodeStatusBadgeText: Record<"running" | "idle" | "error", string> = {
  running: "Running",
  idle: "Idle",
  error: "Error",
};

/** Maps agent health status to Badge variant. */
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

type HeaderStatusBadge = {
  text: string;
  color: string;
  variant: "success" | "warning" | "secondary" | "destructive";
};

/** Panel header labels per node type. */
const PANEL_TITLES: Record<NodeType, string> = {
  agent: "Agent",
  database: "Session",
  mcp: "MCP Server",
  workspace: "Workspace",
  sandbox: "Sandbox",
  skill: "Skill",
};

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

export const NodeSidePanel = memo(function NodeSidePanel({
  node,
  selectedAt,
  deleteRequestToken,
  onClose,
  onRemoveNode,
  onUpdateNodeLabel,
  onUpdateNodeData,
}: {
  node: Node | null;
  /** `performance.now()` of the click that selected this node, for the open-latency mark. */
  selectedAt: number;
  deleteRequestToken: number;
  onClose: () => void;
  onRemoveNode: (nodeId: string) => void;
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
  const canQueryMcpStatus = isMcp && !!projectId && !!stageId && !!nodeId;

  // Time from the canvas click to this panel being on screen — mostly its own
  // dynamic import. Keyed on the click stamp so reselecting a node re-measures.
  const measuredSelection = useRef(0);
  useEffect((): void => {
    if (!nodeId || !selectedAt || measuredSelection.current === selectedAt)
      return;

    measuredSelection.current = selectedAt;
    reportPerf("side-panel.open", performance.now() - selectedAt, {
      attributes: { node_type: nodeType },
    });
  }, [nodeId, nodeType, selectedAt]);

  // Agent health status (agent nodes only)
  const healthStatus = useAgentHealth(isAgent ? agentConfigId : undefined);

  // Connected agent config for skill nodes, so the header status badge mirrors
  // the same Enabled/Disabled state shown on the node card.
  const { agentConfig: connectedAgentConfig } = useConnectedAgentConfig(
    isSkill ? nodeId : undefined,
  );

  // Read the canvas's single graph traversal rather than walking the edges
  // again here; BaseNode reads the same map for its unwired badge.
  const infraAnalysis = useInfraAnalysis();
  const isConnectedToAgent =
    nodeType === "agent" ||
    !nodeId ||
    (infraAnalysis.connectedToAgent[nodeId] ?? false);

  // Agent config for editable name (agent nodes only)
  const agentConfig = useQuery(
    api.agent.config.getById,
    isAgent && agentConfigId ? { configId: agentConfigId } : "skip",
  );
  const updateConfig = useMutation(
    api.agent.config.update,
  ).withOptimisticUpdate(applyAgentConfigUpdate);
  const removeConfig = useMutation(api.agent.config.remove);
  const ensureDeployment = useMutation(api.agent.deployments.ensureForStage);
  const rotateDeployment = useMutation(api.agent.deployments.rotate);

  // The stage's runtime API key (shared by every agent in it). The agent
  // itself is selected per request by its Agent ID. Created on demand here or on
  // the first `broods deploy`.
  const activeDeployment =
    useQuery(
      api.agent.deployments.getForStage,
      isAgent && projectId && stageId
        ? { projectId: projectId, stageId: stageId }
        : "skip",
    ) ?? undefined;
  const revealedDeploymentApiKey = useQuery(
    api.agent.deployments.revealKeyForStage,
    isAgent && projectId && stageId
      ? { projectId: projectId, stageId: stageId }
      : "skip",
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
  const removeMcpForNode = useAction(api.mcp.removeForNode);

  // Editable name (agent uses agentConfig, others use canvas label)
  const [editName, setEditName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [isSavingKey, setIsSavingKey] = useState(false);
  const [deploymentApiKey, setDeploymentApiKey] = useState<string | undefined>(
    undefined,
  );
  const [activeTab, setActiveTab] = useState("details");

  // Sync the editable name and reset panel state when the selected node, its
  // config, or its deployment changes. Handled during render (each guarded by
  // the previously-synced value) instead of in effects to avoid cascading
  // re-renders. See https://react.dev/learn/you-might-not-need-an-effect.

  // Editable name follows the agent config (agents) or canvas label (others).
  // `undefined` sentinel forces the initial sync since nameSource is never undefined.
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

  // Reset to the details tab when a different node is selected.
  const [tabSyncedNodeId, setTabSyncedNodeId] = useState(node?.id);
  if (node?.id !== tabSyncedNodeId) {
    setTabSyncedNodeId(node?.id);
    setActiveTab("details");
  }

  // Clear a freshly generated key when the active deployment changes. The
  // authoritative stored key is recovered reactively from Convex below.
  const deploymentKeySync = activeDeployment?.endpointId ?? "";
  const [syncedDeploymentKey, setSyncedDeploymentKey] =
    useState(deploymentKeySync);
  if (deploymentKeySync !== syncedDeploymentKey) {
    setSyncedDeploymentKey(deploymentKeySync);
    setDeploymentApiKey(undefined);
  }
  const resolvedDeploymentApiKey =
    deploymentApiKey ?? revealedDeploymentApiKey ?? undefined;

  // Jump to the settings tab when the parent bumps the delete-request token.
  // `handledDeleteToken` marks the request consumed only after SettingsTab has
  // opened the dialog — the tab panel mounts lazily, so a render-time check
  // inside SettingsTab would miss a token that bumped before it mounted.
  const [prevDeleteToken, setPrevDeleteToken] = useState(deleteRequestToken);
  const [handledDeleteToken, setHandledDeleteToken] =
    useState(deleteRequestToken);
  if (deleteRequestToken !== prevDeleteToken) {
    setPrevDeleteToken(deleteRequestToken);
    if (deleteRequestToken > 0) {
      setActiveTab("settings");
    }
  }

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
  const runtimeVariables = useMemo<RuntimeVariable[]>(
    () =>
      Array.isArray(agentConfig?.runtimeVariables)
        ? agentConfig.runtimeVariables.filter(
            (value: unknown): value is RuntimeVariable =>
              isRuntimeVariable(value),
          )
        : [],
    [agentConfig],
  );
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
          color: "bg-zinc-500",
          variant: "secondary",
        };
      }

      const isServerEnabled = !!mcpServer && mcpServer.disabled !== true;

      return {
        text: isServerEnabled ? "Enabled" : "Disabled",
        color: isServerEnabled ? "bg-emerald-500" : "bg-zinc-500",
        variant: isServerEnabled ? "success" : "secondary",
      };
    }

    if (nodeType === "database") {
      // Mirror the canvas node: conversation persistence is always on once wired to an agent.
      return {
        text: isConnectedToAgent ? "Persistent" : "Unconnected",
        color: isConnectedToAgent ? "bg-emerald-500" : "bg-red-400",
        variant: isConnectedToAgent ? "success" : "destructive",
      };
    }

    if (!isConnectedToAgent) {
      return {
        text: "Unconnected",
        color: "bg-red-400",
        variant: "destructive",
      };
    }

    if (isWorkspace) {
      const workspaceStatus = nodeData?.status ?? "idle";

      return {
        text: nodeStatusBadgeText[workspaceStatus],
        color: nodeStatusBadgeColor[workspaceStatus],
        variant: nodeStatusBadgeVariant[workspaceStatus],
      };
    }

    if (isSandbox) {
      const sandboxStatus = nodeData?.status ?? "idle";

      return {
        text: nodeStatusBadgeText[sandboxStatus],
        color: nodeStatusBadgeColor[sandboxStatus],
        variant: nodeStatusBadgeVariant[sandboxStatus],
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
        color: enabled ? "bg-emerald-500" : "bg-red-400",
        variant: enabled ? "success" : "secondary",
      };
    }

    const nodeStatus = nodeData?.status ?? "idle";

    return {
      text: nodeStatusBadgeText[nodeStatus],
      color: nodeStatusBadgeColor[nodeStatus],
      variant: nodeStatusBadgeVariant[nodeStatus],
    };
  }, [
    isAgent,
    healthStatus,
    isMcp,
    canQueryMcpStatus,
    mcpServer,
    nodeType,
    isConnectedToAgent,
    isWorkspace,
    isSandbox,
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
      // Preserve all existing branches (tools, skills, workspace, etc.);
      // only replace the three branches the Config tab exposes.
      const base = toNestedAgentConfig(agentConfig) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...base };
      for (const branch of ["agent", "model", "provider"] as const) {
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
    const currentProvider = isPlainObject(base.provider) ? base.provider : {};
    const nextProviderConfig = { ...currentProvider };
    if (next.provider === "custom") {
      nextProviderConfig.custom = {
        ...(isPlainObject(currentProvider.custom)
          ? currentProvider.custom
          : {}),
        base_url: next.customBaseUrl,
        baseURL: next.customBaseUrl,
      };
    }
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

  // Resource owned by a broods/ project. Agents read the authoritative
  // `managedBy` from their config row; workspaces/sandboxes read it from the live
  // `resourceOwnership` query keyed by the row `_id` (the node's `resourceId`),
  // not the cached `managedBy` on canvas node data which can be stale or missing.
  // Falls back to the cached value while the query loads. Code-managed resources
  // stay editable but cannot be deleted here.
  const resourceId = nodeData?.resourceId as string | undefined;
  const resourceOwnership = useQuery(
    api.canvas.resourceOwnership,
    (isWorkspace || isSandbox) && projectId && stageId
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );
  const codeOwner = isAgent
    ? agentConfig?.managedBy
    : resourceId && resourceOwnership
      ? resourceOwnership[resourceId]
      : (nodeData as { managedBy?: string } | undefined)?.managedBy;
  const isCodeManaged = codeOwner === "cli" || codeOwner === "api";
  const isOwnershipLoading =
    (isAgent && !!agentConfigId && agentConfig === undefined) ||
    ((isWorkspace || isSandbox) &&
      !!resourceId &&
      resourceOwnership === undefined);

  // Warn when a dashboard-owned node is named the same as a code-managed resource
  // of the same kind: the next `broods deploy` resolves by (stage,
  // name) and would adopt + overwrite this resource with the code definition.
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

  /** Deletes the node (and its agent config); no-op while code owns it. */
  async function handleDelete(): Promise<void> {
    if (isCodeManaged || isOwnershipLoading) return;
    if (isAgent && agentConfigId) {
      await removeConfig({ configId: agentConfigId });
    }
    if (isMcp && projectId && stageId && node) {
      await removeMcpForNode({
        projectId: projectId,
        stageId: stageId,
        nodeId: node.id,
      });
    }
    if (node) {
      onRemoveNode(node.id);
    }
    onClose();
  }

  const handleUpdateOutputFormat = useCallback(
    (outputFormat: Record<string, unknown> | null) => {
      if (agentConfigId) {
        updateConfig({ configId: agentConfigId, outputFormat: outputFormat });
      }
    },
    [agentConfigId, updateConfig],
  );

  // Mint the stage's runtime key on demand, or rotate it. Both return the
  // plaintext once; we remember it locally so the panel can reveal/copy it until
  // the key is rotated again. `rotate` also lands here via `handleRotateKey`.
  const ensureRuntimeKey = useCallback(
    async (rotate: boolean) => {
      // Returns whether the key was actually minted. The caller needs to tell a
      // real rotation apart from this early return, or a no-op reads as success
      // and the user redeploys with a key that never changed.
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

  // Public-endpoint opt-in (issue #65). Stored as a top-level scalar in
  // extraConfig so it rides through the codec to the harness; off by default.
  const handleUpdatePublicAccess = useCallback(
    async (enabled: boolean) => {
      if (!agentConfigId || !agentConfig) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      await updateConfig({
        configId: agentConfigId,
        extraConfig: { ...currentExtra, publicAccess: enabled },
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

  // Reasoning config. Maps the budget/effort knobs to the selected provider's
  // Vercel AI SDK providerOptions (model.providerOptions.<provider>.*) — the only
  // reasoning shape the core accepts. See applyModelReasoning in the config codec.
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

  /** Resolved name for the SettingsTab delete confirmation. */
  const resolvedName = isAgent
    ? (agentConfig?.name ?? "")
    : (nodeData?.label ?? "");
  // Warmed from the tab trigger only. Preloading on open cost every panel view
  // the test bundle (Streamdown, Mermaid, KaTeX, Shiki) whether or not the tab
  // was ever used; intent to open it lands early enough to hide the fetch.
  const warmTestTab = useCallback(() => {
    if (isAgent) {
      void loadAgentTestTab();

      return;
    }

    if (isMcp) {
      void loadMcpToolsTab();
    }
  }, [isAgent, isMcp]);

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            {PANEL_TITLES[nodeType] ?? "Node"}
          </h2>
          {headerStatus && (
            <Badge
              variant={headerStatus.variant}
              className="gap-1.5 py-0 text-[10px]"
            >
              <span className={`size-1.5 rounded-full ${headerStatus.color}`} />
              {headerStatus.text}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <Separator />

      {isCodeManaged && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {codeOwner === "api"
              ? "Managed through the account API, edits re-sync on every API write, delete is locked."
              : "Managed by broods packages, edits sync on deploy, delete is locked."}
          </p>
        </div>
      )}

      {collidesWithCode && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <p className="text-sm text-amber-600 dark:text-amber-400">
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
            <TabsTrigger value="details">Details</TabsTrigger>
            {(isWorkspace ||
              (isSkill &&
                (nodeData?.config?.skillSource ?? "") === "files")) && (
              <TabsTrigger value="files">Files</TabsTrigger>
            )}
            {isMcp && <TabsTrigger value="server">Server</TabsTrigger>}
            {(isAgent || isWorkspace || isSandbox || isSkill) && (
              <TabsTrigger value="config">Config</TabsTrigger>
            )}
            {isMcp && (
              <TabsTrigger
                value="tools"
                onMouseEnter={warmTestTab}
                onFocus={warmTestTab}
                onPointerDown={warmTestTab}
              >
                Tools
              </TabsTrigger>
            )}
            {isAgent && (
              <TabsTrigger
                value="test"
                onMouseEnter={warmTestTab}
                onFocus={warmTestTab}
                onPointerDown={warmTestTab}
              >
                Test
              </TabsTrigger>
            )}
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          {/* Details tab */}
          <TabsContent
            value="details"
            className="flex flex-col overflow-y-auto"
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
                runtimeVariables={runtimeVariables}
                onSaveModelSettings={handleSaveModelSettings}
                onUpdateToolConfig={handleUpdateToolConfig}
                onUpdateChannelConfig={handleUpdateChannelConfig}
                onUpdateModelReasoning={handleUpdateModelReasoning}
                onUpdatePublicAccess={handleUpdatePublicAccess}
                onUpdatePolicyConfig={handleUpdatePolicyConfig}
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
            ) : nodeType === "workspace" && node ? (
              <WorkspaceResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeData={(patch): void =>
                  onUpdateNodeData(node.id, patch)
                }
              />
            ) : nodeType === "sandbox" && node ? (
              <SandboxResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeData={(patch): void =>
                  onUpdateNodeData(node.id, patch)
                }
              />
            ) : nodeType === "skill" && node ? (
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
            ) : nodeType === "database" && node ? (
              <SessionDetailsTab
                nodeId={node.id}
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

          {/* Files tab — workspace nodes */}
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

          {/* Files tab — skill nodes */}
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

          {/* Config tab — agent and tool */}
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
            <TabsContent value="test" className="flex flex-col overflow-hidden">
              <TestTab
                activeDeployment={activeDeployment}
                deploymentApiKey={resolvedDeploymentApiKey}
                agentId={agentConfigId ?? ""}
                nodeColor={nodeData?.properties?.color}
              />
            </TabsContent>
          )}

          {/* Settings tab — all node types */}
          <TabsContent
            value="settings"
            className="flex flex-col overflow-y-auto"
          >
            <SettingsTab
              nodeType={nodeType}
              nodeName={resolvedName}
              openDeleteRequested={deleteRequestToken > handledDeleteToken}
              onDeleteRequestHandled={() =>
                setHandledDeleteToken(deleteRequestToken)
              }
              onDelete={handleDelete}
              managedByCode={isCodeManaged}
              codeOwner={codeOwner === "api" ? "api" : "cli"}
              deleteLocked={isCodeManaged || isOwnershipLoading}
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
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Name
        </span>
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

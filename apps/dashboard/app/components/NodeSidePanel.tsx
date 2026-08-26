"use client";

/** Side panel displaying node details, configuration, and settings for the selected canvas node. */
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { agentStatusConfig } from "@/app/components/node/BaseNode";
import {
  DetailsTab,
  type AgentProvider,
  type StageDeployment,
} from "@/app/components/side-panel/DetailsTab";
import {
  ResourceConfigTab,
  SandboxResourceDetailsTab,
  WorkspaceResourceDetailsTab,
} from "@/app/components/side-panel/ResourceNodeTabs";
import { SessionDetailsTab } from "@/app/components/side-panel/SessionDetailsTab";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { SkillConfigTab } from "@/app/components/side-panel/SkillConfigTab";
import { SkillDetailsTab } from "@/app/components/side-panel/SkillDetailsTab";
import { SkillFilesTab } from "@/app/components/side-panel/SkillFilesTab";
import { ToolConfigTab } from "@/app/components/side-panel/ToolConfigTab";
import { ToolDetailsTab } from "@/app/components/side-panel/ToolDetailsTab";
import { WorkspaceFilesTab } from "@/app/components/side-panel/WorkspaceFilesTab";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/app/components/ui/input-group";
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
import { useMutation, useQuery } from "convex/react";
import {
  ArrowUp,
  BookOpen,
  Check,
  Database,
  FileText,
  FolderOpen,
  MessageSquareText,
  Plug,
  Plus,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
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

const loadToolTestTab = () =>
  import("@/app/components/side-panel/ToolTestTab").then(
    (mod) => mod.ToolTestTab,
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

const ToolTestTab = dynamic(loadToolTestTab, {
  loading: () => (
    <div className="flex flex-1 items-center justify-center p-4">
      <p className="text-center text-xs text-muted-foreground">
        Loading test tab…
      </p>
    </div>
  ),
});

type NodeType =
  "agent" | "database" | "tool" | "workspace" | "sandbox" | "skill";
type HeaderStatusBadge = {
  text: string;
  color: string;
  variant: "success" | "warning" | "secondary" | "destructive";
};
type AgentWorkspaceKind = "skills" | "integrations" | "folders";
type AgentWorkspace = Record<AgentWorkspaceKind, string[]>;

/** Panel header labels per node type. */
const PANEL_TITLES: Record<NodeType, string> = {
  agent: "Agent",
  database: "Session",
  tool: "Tool",
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

function readAgentWorkspace(extraConfig: unknown): AgentWorkspace {
  const config =
    extraConfig &&
    typeof extraConfig === "object" &&
    !Array.isArray(extraConfig)
      ? (extraConfig as Record<string, unknown>)
      : {};
  const workspace =
    config.agentWorkspace &&
    typeof config.agentWorkspace === "object" &&
    !Array.isArray(config.agentWorkspace)
      ? (config.agentWorkspace as Record<string, unknown>)
      : {};

  return {
    skills: readStringList(workspace.skills),
    integrations: readStringList(workspace.integrations),
    folders: readStringList(workspace.folders),
  };
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
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
  const isTool = nodeType === "tool";
  const isWorkspace = nodeType === "workspace";
  const isSandbox = nodeType === "sandbox";
  const isSkill = nodeType === "skill";
  const { stageId } = useStage();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const agentConfigId = nodeData?.agentConfigId as
    Id<"agentConfigs"> | undefined;
  const nodeId = node?.id;
  const canQueryToolStatus = isTool && !!projectId && !!stageId && !!nodeId;

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
    api.agentConfig.getById,
    isAgent && agentConfigId ? { configId: agentConfigId } : "skip",
  );
  const updateConfig = useMutation(api.agentConfig.update).withOptimisticUpdate(
    applyAgentConfigUpdate,
  );
  const removeConfig = useMutation(api.agentConfig.remove);
  const ensureDeployment = useMutation(api.agentDeployments.ensureForStage);
  const rotateDeployment = useMutation(api.agentDeployments.rotate);

  // The stage's runtime API key (shared by every agent in it). The agent
  // itself is selected per request by its Agent ID. Created on demand here or on
  // the first `broods deploy`.
  const activeDeployment =
    useQuery(
      api.agentDeployments.getForStage,
      isAgent && projectId && stageId
        ? { projectId: projectId, stageId: stageId }
        : "skip",
    ) ?? undefined;
  const revealedDeploymentApiKey = useQuery(
    api.agentDeployments.revealKeyForStage,
    isAgent && projectId && stageId
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );

  const toolService = useQuery(
    api.toolService.getByNode,
    canQueryToolStatus
      ? {
          projectId: projectId,
          stageId: stageId,
          nodeId: nodeId,
        }
      : "skip",
  );

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
  const [prevDeleteToken, setPrevDeleteToken] = useState(deleteRequestToken);
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

    if (isTool) {
      if (!canQueryToolStatus || toolService === undefined) {
        return {
          text: "Loading",
          color: "bg-zinc-500",
          variant: "secondary",
        };
      }

      const isToolEnabled = toolService?.disabled !== true;

      return {
        text: isToolEnabled ? "Enabled" : "Disabled",
        color: isToolEnabled ? "bg-emerald-500" : "bg-zinc-500",
        variant: isToolEnabled ? "success" : "secondary",
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
    isTool,
    canQueryToolStatus,
    toolService,
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
  const agentWorkspace = useMemo(
    () => readAgentWorkspace(agentConfig?.extraConfig),
    [agentConfig?.extraConfig],
  );
  const handleAddAgentWorkspaceItem = useCallback(
    async (kind: AgentWorkspaceKind, rawName: string) => {
      if (!agentConfigId || !agentConfig) return;
      const name = titleCase(rawName);
      if (!name) return;

      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentWorkspace = readAgentWorkspace(currentExtra);
      const nextList = Array.from(new Set([...currentWorkspace[kind], name]));
      const nextWorkspace = { ...currentWorkspace, [kind]: nextList };
      const nextExtra: Record<string, unknown> = {
        ...currentExtra,
        agentWorkspace: nextWorkspace,
      };

      if (kind === "skills") {
        const currentSkills =
          currentExtra.skills &&
          typeof currentExtra.skills === "object" &&
          !Array.isArray(currentExtra.skills)
            ? (currentExtra.skills as Record<string, unknown>)
            : {};
        nextExtra.skills = {
          ...currentSkills,
          enabled: true,
          allowed: Array.from(
            new Set([...readStringList(currentSkills.allowed), name]),
          ),
        };
      }

      await updateConfig({
        configId: agentConfigId,
        extraConfig: nextExtra,
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );
  const handleSetAgentWorkspaceItems = useCallback(
    async (kind: AgentWorkspaceKind, items: string[]) => {
      if (!agentConfigId || !agentConfig) return;
      const cleanItems = Array.from(
        new Set(items.map(titleCase).filter((item) => item.length > 0)),
      );
      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentWorkspace = readAgentWorkspace(currentExtra);
      const nextWorkspace = { ...currentWorkspace, [kind]: cleanItems };
      const nextExtra: Record<string, unknown> = {
        ...currentExtra,
        agentWorkspace: nextWorkspace,
      };

      if (kind === "skills") {
        const currentSkills =
          currentExtra.skills &&
          typeof currentExtra.skills === "object" &&
          !Array.isArray(currentExtra.skills)
            ? (currentExtra.skills as Record<string, unknown>)
            : {};
        nextExtra.skills = {
          ...currentSkills,
          enabled: cleanItems.length > 0,
          allowed: cleanItems,
        };
      }

      await updateConfig({
        configId: agentConfigId,
        extraConfig: nextExtra,
      });
    },
    [agentConfigId, agentConfig, updateConfig],
  );
  const handleUpdateSystemPrompt = useCallback(
    async (systemPrompt: string) => {
      if (!agentConfigId) return;
      await updateConfig({
        configId: agentConfigId,
        systemPrompt: systemPrompt,
      });
    },
    [agentConfigId, updateConfig],
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

    if (isTool) {
      void loadToolTestTab();
    }
  }, [isAgent, isTool]);

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            {PANEL_TITLES[nodeType]}
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
            {(!isAgent || isTool || isWorkspace || isSandbox || isSkill) && (
              <TabsTrigger value="config">Config</TabsTrigger>
            )}
            {(isAgent || nodeType === "tool") && (
              <TabsTrigger
                value={isAgent ? "playground" : "test"}
                onMouseEnter={warmTestTab}
                onFocus={warmTestTab}
                onPointerDown={warmTestTab}
              >
                {isAgent ? "Playground" : "Test"}
              </TabsTrigger>
            )}
            {isAgent && <TabsTrigger value="skills">Skills</TabsTrigger>}
            {isAgent && <TabsTrigger value="connect">Connect</TabsTrigger>}
            {isAgent && <TabsTrigger value="context">Context</TabsTrigger>}
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
                onUpdateSystemPrompt={handleUpdateSystemPrompt}
              />
            ) : isTool && node ? (
              <ToolDetailsTab
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
          {!isAgent && isTool && node && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <ToolConfigTab
                projectId={projectId}
                stageId={stageId}
                nodeId={node.id}
                nodeLabel={editName || nodeData.label}
                nodeConfig={nodeData?.config}
              />
            </TabsContent>
          )}
          {!isAgent && (isWorkspace || isSandbox) && node && (
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
          {!isAgent && isSkill && node && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <SkillConfigTab nodeId={node.id} />
            </TabsContent>
          )}

          {/* Playground/Test tab — agent and tool only */}
          {isAgent && (
            <TabsContent
              value="playground"
              className="flex flex-col overflow-hidden"
            >
              <AgentPlayground
                activeDeployment={activeDeployment}
                deploymentApiKey={resolvedDeploymentApiKey}
                agentId={agentConfigId ?? ""}
                nodeColor={nodeData?.properties?.color}
                slashSkills={agentWorkspace.skills}
                onAddItem={handleAddAgentWorkspaceItem}
              />
            </TabsContent>
          )}
          {nodeType === "tool" && (
            <TabsContent value="test" className="flex flex-col overflow-hidden">
              {node ? (
                <ToolTestTab
                  projectId={projectId}
                  stageId={stageId}
                  nodeId={node.id}
                />
              ) : null}
            </TabsContent>
          )}

          {isAgent && (
            <TabsContent
              value="skills"
              className="flex flex-col overflow-hidden"
            >
              <AgentWorkspaceSection
                kind="skills"
                title="Skills Library"
                subtitle="Reusable abilities this agent can call with /."
                icon={<Sparkles className="size-4" />}
                items={agentWorkspace.skills}
                emptyText="No skills yet. Ask in Playground, or add one here."
                examples={[
                  "Customer triage",
                  "Lead research",
                  "Bug report routing",
                ]}
                onAdd={handleAddAgentWorkspaceItem}
                onChangeItems={handleSetAgentWorkspaceItems}
              />
            </TabsContent>
          )}
          {isAgent && (
            <TabsContent
              value="connect"
              className="flex flex-col overflow-hidden"
            >
              <AgentConnectSection
                kind="integrations"
                title="Integrations"
                subtitle="Apps and channels this agent can use."
                icon={<Plug className="size-4" />}
                items={agentWorkspace.integrations}
                emptyText="No integrations yet. Start with Slack, Gmail, or HubSpot."
                examples={["Slack", "Gmail", "HubSpot"]}
                onAdd={handleAddAgentWorkspaceItem}
                onChangeItems={handleSetAgentWorkspaceItems}
              />
            </TabsContent>
          )}
          {isAgent && (
            <TabsContent
              value="context"
              className="flex flex-col overflow-hidden"
            >
              <AgentContextSection
                workspace={agentWorkspace}
                memoryEnabled={agentConfig?.memoryToolEnabled === true}
                onAdd={handleAddAgentWorkspaceItem}
                onChangeItems={handleSetAgentWorkspaceItems}
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
              openDeleteDialogToken={deleteRequestToken}
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

function AgentPlayground({
  activeDeployment,
  deploymentApiKey,
  agentId,
  nodeColor,
  slashSkills,
  onAddItem,
}: {
  activeDeployment: StageDeployment | undefined;
  deploymentApiKey?: string;
  agentId: string;
  nodeColor?: string;
  slashSkills: string[];
  onAddItem: (kind: AgentWorkspaceKind, name: string) => void;
}) {
  const canUseRuntime = Boolean(
    activeDeployment && deploymentApiKey && agentId,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-4">
        <div className="mb-3 flex items-start gap-2">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <MessageSquareText className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Playground</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Chat with this agent, try prompts, or ask it to prepare a reusable
              skill.
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {canUseRuntime ? (
          <TestTab
            activeDeployment={activeDeployment}
            deploymentApiKey={deploymentApiKey}
            agentId={agentId}
            nodeColor={nodeColor}
            slashSkills={slashSkills}
          />
        ) : (
          <LocalPlaygroundChat
            slashSkills={slashSkills}
            onAddItem={onAddItem}
          />
        )}
      </div>
    </div>
  );
}

function SuggestionChips({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {[
        "Draft a customer support skill",
        "Qualify sales leads",
        "Summarize uploaded files",
      ].map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onPick(suggestion)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Wand2 className="size-3.5" />
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function LocalPlaygroundChat({
  slashSkills,
  onAddItem,
}: {
  slashSkills: string[];
  onAddItem: (kind: AgentWorkspaceKind, name: string) => void;
}) {
  const [input, setInput] = useState("");
  const [draftSkill, setDraftSkill] = useState<string | null>(null);
  const [messages, setMessages] = useState([
    {
      role: "agent",
      text: "Runtime chat is not connected yet, but I can still help set up this agent. Ask me to build a skill, connect an app, or create a folder.",
    },
  ]);
  const slashOptions = slashSkills
    .map((skill) => ({
      name: skill,
      command: `/${skill.toLowerCase().replaceAll(" ", "-")}`,
    }))
    .filter((skill) => skill.command.startsWith(input.trim().toLowerCase()));
  const showSlashOptions =
    input.trim().startsWith("/") && slashOptions.length > 0;

  function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: text }]);

    const lower = text.toLowerCase();
    if (lower.includes("connect") || lower.includes("integration")) {
      const name = titleCase(text.replace(/connect|integration|add/gi, ""));
      void onAddItem("integrations", name || "Custom MCP");
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          text: `Connected item prepared: ${name || "Custom MCP"}.`,
        },
      ]);
      return;
    }
    if (lower.includes("folder") || lower.includes("file")) {
      const name = titleCase(text.replace(/folder|file|add/gi, ""));
      void onAddItem("folders", name || "Agent Files");
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: `Folder prepared: ${name || "Agent Files"}.` },
      ]);
      return;
    }

    const name = titleCase(
      text.replace(/build|draft|create|skill|for me|please/gi, ""),
    );
    setDraftSkill(name || "New Skill");
    setMessages((prev) => [
      ...prev,
      {
        role: "agent",
        text: `I drafted "${name || "New Skill"}". Review it below, then save it to the Skills Library.`,
      },
    ]);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <SuggestionChips onPick={setInput} />
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={message.role === "user" ? "flex justify-end" : ""}
          >
            <p
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-6 ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background/60"
              }`}
            >
              {message.text}
            </p>
          </div>
        ))}
        {draftSkill && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Sparkles className="size-4" />
              {draftSkill}
            </div>
            <p className="mb-3 text-xs leading-5 text-muted-foreground">
              Use this when the user needs {draftSkill.toLowerCase()}. The agent
              should ask one clarifying question when the request is vague, then
              produce a concise result.
            </p>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                void onAddItem("skills", draftSkill);
                setDraftSkill(null);
              }}
            >
              <Check className="size-3.5" />
              Save to Skills Library
            </Button>
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="shrink-0 p-3"
      >
        {showSlashOptions && (
          <div className="mb-2 rounded-lg border border-border bg-card p-1">
            {slashOptions.map((skill) => (
              <button
                key={skill.command}
                type="button"
                onClick={() => setInput(`${skill.command} `)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Sparkles className="size-3.5" />
                <span className="font-mono">{skill.command}</span>
                <span className="truncate">{skill.name}</span>
              </button>
            ))}
          </div>
        )}
        <InputGroup className="rounded-lg">
          <InputGroupTextarea
            value={input}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(event.target.value)
            }
            onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Message this agent, or type / to call a skill..."
            rows={1}
            className="max-h-40 min-h-0 py-2.5 text-sm"
          />
          <InputGroupAddon align="block-end" className="pt-0">
            <InputGroupButton
              type="submit"
              size="icon-xs"
              variant="default"
              disabled={!input.trim()}
              className="ml-auto rounded-sm"
            >
              <ArrowUp className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

function AgentWorkspaceSection({
  kind,
  title,
  subtitle,
  icon,
  items,
  emptyText,
  examples,
  onAdd,
  onChangeItems,
}: {
  kind: AgentWorkspaceKind;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: string[];
  emptyText: string;
  examples: string[];
  onAdd: (kind: AgentWorkspaceKind, name: string) => void;
  onChangeItems: (kind: AgentWorkspaceKind, items: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function add(value: string) {
    const next = value.trim();
    if (!next) return;
    void onAdd(kind, next);
    setName("");
  }

  function startEdit(item: string) {
    setEditing(item);
    setEditValue(item);
  }

  function saveEdit() {
    if (!editing) return;
    const next = titleCase(editValue);
    if (!next) return;
    void onChangeItems(
      kind,
      items.map((item) => (item === editing ? next : item)),
    );
    setEditing(null);
    setEditValue("");
  }

  function remove(item: string) {
    void onChangeItems(
      kind,
      items.filter((entry) => entry !== item),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-start gap-2">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {subtitle}
          </p>
        </div>
      </div>

      <div className="mb-4 flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add(name);
          }}
          placeholder={
            kind === "skills"
              ? "Add skill name"
              : kind === "integrations"
                ? "Add app or channel"
                : "Add folder name"
          }
          className="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 text-xs"
          disabled={!name.trim()}
          onClick={() => add(name)}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => add(example)}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs leading-5 text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item}
              className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-3"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                {kind === "skills" ? (
                  <BookOpen className="size-4" />
                ) : kind === "integrations" ? (
                  <Plug className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {editing === item ? (
                  <Input
                    value={editValue}
                    onChange={(event) => setEditValue(event.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveEdit();
                      if (event.key === "Escape") setEditing(null);
                    }}
                    className="h-7 text-sm"
                  />
                ) : (
                  <p className="truncate text-sm font-medium">{item}</p>
                )}
                <p className="truncate text-[11px] text-muted-foreground">
                  {kind === "skills"
                    ? `/${item.toLowerCase().replaceAll(" ", "-")}`
                    : kind === "integrations"
                      ? "Ready to configure"
                      : "Agent working folder"}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => startEdit(item)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                  onClick={() => remove(item)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentConnectSection({
  items,
  examples,
  onAdd,
  onChangeItems,
}: {
  kind: "integrations";
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: string[];
  emptyText: string;
  examples: string[];
  onAdd: (kind: AgentWorkspaceKind, name: string) => void;
  onChangeItems: (kind: AgentWorkspaceKind, items: string[]) => void;
}) {
  const catalog = [
    { name: "Gmail", type: "Web", popular: true },
    { name: "Slack", type: "Web", popular: true },
    { name: "Google Calendar", type: "Web", popular: true },
    { name: "Google Drive", type: "Web", popular: false },
    { name: "Notion", type: "Web", popular: false },
    { name: "GitHub", type: "Web", popular: false },
    { name: "Custom MCP", type: "Desktop", popular: false },
  ];
  const [query, setQuery] = useState("");
  const connected = new Set(items.map((item) => item.toLowerCase()));
  const filtered = catalog.filter((entry) =>
    entry.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  function disconnect(name: string) {
    void onChangeItems(
      "integrations",
      items.filter((item) => item.toLowerCase() !== name.toLowerCase()),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Connectors</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Connect apps, channels, or a custom MCP server this agent can use.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => onAdd("integrations", "Custom MCP")}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search connectors"
        className="mb-4 h-8 text-sm"
      />

      <div className="mb-4 grid gap-2">
        {filtered
          .filter((entry) => entry.popular)
          .map((entry) => {
            const isConnected = connected.has(entry.name.toLowerCase());

            return (
              <div
                key={entry.name}
                className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-3"
              >
                <div className="grid size-8 place-items-center rounded-md bg-muted text-xs font-medium">
                  {entry.name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {entry.type}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={isConnected ? "secondary" : "outline"}
                  className="h-8 text-xs"
                  onClick={() =>
                    isConnected
                      ? disconnect(entry.name)
                      : onAdd("integrations", entry.name)
                  }
                >
                  {isConnected ? "Connected" : "Connect"}
                </Button>
              </div>
            );
          })}
      </div>

      <AgentWorkspaceSection
        kind="integrations"
        title="Connected"
        subtitle="Enabled for this agent."
        icon={<Plug className="size-4" />}
        items={items}
        emptyText="No connectors attached yet."
        examples={examples}
        onAdd={onAdd}
        onChangeItems={onChangeItems}
      />
    </div>
  );
}

function AgentContextSection({
  workspace,
  memoryEnabled,
  onAdd,
  onChangeItems,
}: {
  workspace: AgentWorkspace;
  memoryEnabled: boolean;
  onAdd: (kind: AgentWorkspaceKind, name: string) => void;
  onChangeItems: (kind: AgentWorkspaceKind, items: string[]) => void;
}) {
  const rows = [
    {
      label: "Memory",
      value: memoryEnabled ? "Enabled" : "Not enabled",
      icon: <Database className="size-4" />,
    },
    {
      label: "Skills",
      value: `${workspace.skills.length} available`,
      icon: <Sparkles className="size-4" />,
    },
    {
      label: "Connectors",
      value: `${workspace.integrations.length} connected`,
      icon: <Plug className="size-4" />,
    },
    {
      label: "Files",
      value: `${workspace.folders.length} folders`,
      icon: <FolderOpen className="size-4" />,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-4">
        <h3 className="text-sm font-medium">Context</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Everything this agent can remember, call, open, or use while working.
        </p>
      </div>

      <div className="mb-5 grid gap-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-3"
          >
            <div className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
              {row.icon}
            </div>
            <div>
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-[11px] text-muted-foreground">{row.value}</p>
            </div>
          </div>
        ))}
      </div>

      <AgentWorkspaceSection
        kind="folders"
        title="Files & Folders"
        subtitle="Documents and folders this agent should keep close."
        icon={<FolderOpen className="size-4" />}
        items={workspace.folders}
        emptyText="No folders yet. Add a brief, uploads folder, or run log."
        examples={["Project brief", "Uploaded files", "Run logs"]}
        onAdd={onAdd}
        onChangeItems={onChangeItems}
      />
    </div>
  );
}

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

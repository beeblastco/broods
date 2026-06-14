"use client";

/** Side panel displaying node details, configuration, and settings for the selected canvas node. */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { agentStatusConfig } from "@/app/components/node/BaseNode";
import { ConfigTab } from "@/app/components/side-panel/ConfigTab";
import {
  ResourceConfigTab,
  SandboxResourceDetailsTab,
  WorkspaceResourceDetailsTab,
} from "@/app/components/side-panel/ResourceNodeTabs";
import { SessionDetailsTab } from "@/app/components/side-panel/SessionDetailsTab";
import { SkillConfigTab } from "@/app/components/side-panel/SkillConfigTab";
import { SkillDetailsTab } from "@/app/components/side-panel/SkillDetailsTab";
import { WorkspaceFilesTab } from "@/app/components/side-panel/WorkspaceFilesTab";
import { SkillFilesTab } from "@/app/components/side-panel/SkillFilesTab";
import {
  DetailsTab,
  type AgentProvider,
} from "@/app/components/side-panel/DetailsTab";
import { SettingsTab } from "@/app/components/side-panel/SettingsTab";
import { ToolConfigTab } from "@/app/components/side-panel/ToolConfigTab";
import { ToolDetailsTab } from "@/app/components/side-panel/ToolDetailsTab";
import { VariablesTab } from "@/app/components/side-panel/VariablesTab";
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
import { useEnvironment } from "@/app/hooks/useEnvironment";
import {
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
import {
  forgetDeploymentCredential,
  getRememberedDeploymentApiKey,
  rememberDeploymentCredential,
} from "@/app/lib/deploymentCredentials";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useStore, type Node } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

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
  | "agent"
  | "database"
  | "tool"
  | "workspace"
  | "sandbox"
  | "skill";
type HeaderStatusBadge = {
  text: string;
  color: string;
  variant: "success" | "warning" | "secondary" | "destructive";
};

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

export const NodeSidePanel = memo(function NodeSidePanel({
  node,
  deleteRequestToken,
  onClose,
  onRemoveNode,
  onUpdateNodeLabel,
  onUpdateNodeData,
}: {
  node: Node | null;
  deleteRequestToken: number;
  onClose: () => void;
  onRemoveNode: (nodeId: string) => void;
  onUpdateNodeLabel: (nodeId: string, label: string) => void;
  onUpdateNodeData: (nodeId: string, patch: Partial<BaseNodeData>) => void;
}) {
  const nodeData = node?.data as BaseNodeData | undefined;
  const nodeType = (node?.type ?? "agent") as NodeType;
  const isAgent = nodeType === "agent";
  const isTool = nodeType === "tool";
  const isWorkspace = nodeType === "workspace";
  const isSandbox = nodeType === "sandbox";
  const isSkill = nodeType === "skill";
  const { environmentId } = useEnvironment();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const agentConfigId = nodeData?.agentConfigId as
    | Id<"agentConfigs">
    | undefined;
  const nodeId = node?.id;
  const canQueryToolStatus =
    isTool && !!projectId && !!environmentId && !!nodeId;

  // Agent health status (agent nodes only)
  const healthStatus = useAgentHealth(isAgent ? agentConfigId : undefined);

  // Connected agent config for skill nodes, so the header status badge mirrors
  // the same Enabled/Disabled state shown on the node card.
  const { agentConfig: connectedAgentConfig } = useConnectedAgentConfig(
    isSkill ? nodeId : undefined,
  );

  const isConnectedToAgent = useStore(
    useCallback(
      (state: Record<string, unknown>) => {
        if (nodeType === "agent" || !nodeId) return true;

        const edges = state.edges as Array<{ source: string; target: string }>;
        const nodeLookup = state.nodeLookup as Map<string, { type?: string }>;
        if (!edges || !nodeLookup) return false;

        if (nodeType === "workspace" || nodeType === "sandbox") {
          const visited = new Set<string>([nodeId]);
          const queue = [nodeId];
          while (queue.length > 0) {
            const current = queue.shift()!;
            for (const edge of edges) {
              if (edge.source !== current && edge.target !== current) continue;
              const otherNodeId =
                edge.source === current ? edge.target : edge.source;
              if (visited.has(otherNodeId)) continue;
              visited.add(otherNodeId);
              const otherNode = nodeLookup.get(otherNodeId);
              if (otherNode?.type === "agent") return true;
              if (
                otherNode?.type === "workspace" ||
                otherNode?.type === "sandbox"
              ) {
                queue.push(otherNodeId);
              }
            }
          }

          return false;
        }

        for (const edge of edges) {
          if (edge.source !== nodeId && edge.target !== nodeId) continue;

          const otherNodeId =
            edge.source === nodeId ? edge.target : edge.source;
          const otherNode = nodeLookup.get(otherNodeId);
          if (otherNode?.type === "agent") {
            return true;
          }
        }

        return false;
      },
      [nodeId, nodeType],
    ),
  );

  // Agent config for editable name (agent nodes only)
  const agentConfig = useQuery(
    api.agentConfig.getById,
    isAgent && agentConfigId ? { configId: agentConfigId } : "skip",
  );
  const updateConfig = useMutation(api.agentConfig.update).withOptimisticUpdate(
    applyAgentConfigUpdate,
  );
  const removeConfig = useMutation(api.agentConfig.remove);
  const createDeployment = useMutation(api.agentDeployments.create);
  const revokeDeployment = useMutation(api.agentDeployments.revoke);

  // Deployment credentials (agent nodes only)
  const deployments = useQuery(
    api.agentDeployments.list,
    isAgent && agentConfigId ? { agentConfigId: agentConfigId } : "skip",
  );
  const activeDeployment = deployments?.find(
    (d: { status?: string }) => d.status === "active",
  );

  const toolService = useQuery(
    api.toolService.getByNode,
    canQueryToolStatus
      ? {
          projectId: projectId,
          environmentId: environmentId,
          nodeId: nodeId,
        }
      : "skip",
  );

  // Editable name (agent uses agentConfig, others use canvas label)
  const [editName, setEditName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [isSavingModelSettings, setIsSavingModelSettings] = useState(false);
  const [isSavingVariables, setIsSavingVariables] = useState(false);
  const [isSavingPublicAccess, setIsSavingPublicAccess] = useState(false);
  const [isSavingWebSocket, setIsSavingWebSocket] = useState(false);
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

  // Restore the remembered deployment key when the active deployment changes.
  const deploymentKeySync = activeDeployment?.endpointId ?? "";
  const [syncedDeploymentKey, setSyncedDeploymentKey] =
    useState(deploymentKeySync);
  if (deploymentKeySync !== syncedDeploymentKey) {
    setSyncedDeploymentKey(deploymentKeySync);
    setDeploymentApiKey(
      getRememberedDeploymentApiKey(activeDeployment?.endpointId),
    );
  }

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
  // Cheap boolean derived each render; no memo needed (and the compiler lint
  // can't preserve a manual memo whose dep is a nested optional member access).
  const publicAccessEnabled = ((): boolean => {
    if (!isAgent) return false;
    if (agentConfig?.publicAccessEnabled !== undefined) {
      return agentConfig.publicAccessEnabled === true;
    }

    return !!activeDeployment;
  })();
  // Cheap boolean derived each render; no memo needed (same nested-optional-dep
  // limitation as publicAccessEnabled above).
  const webSocketEnabled = ((): boolean => {
    if (!publicAccessEnabled) return false;
    if (agentConfig?.webSocketEnabled !== undefined) {
      return agentConfig.webSocketEnabled === true;
    }

    // Preserve behavior for legacy deployments that predate this flag.
    return !!activeDeployment;
  })();
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

      const isToolEnabled = toolService?.status !== "disabled";

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
        skills.enabled === true && (skills.allowed ?? []).includes(path);

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
  }) {
    if (!agentConfigId) return;

    setIsSavingModelSettings(true);
    try {
      await updateConfig({
        configId: agentConfigId,
        provider: next.provider,
        modelId: next.modelId,
      });
    } finally {
      setIsSavingModelSettings(false);
    }
  }

  async function handleSaveVariables(next: RuntimeVariable[]) {
    if (!agentConfigId) return;

    setIsSavingVariables(true);
    try {
      await updateConfig({
        configId: agentConfigId,
        runtimeVariables: next,
      });
    } finally {
      setIsSavingVariables(false);
    }
  }

  // Resource owned by a filthypanty/ project. Agents read the authoritative
  // `managedBy` from their config row; workspaces/sandboxes read it from the live
  // `resourceOwnership` query keyed by the row `_id` (the node's `resourceId`),
  // not the cached `managedBy` on canvas node data which can be stale or missing.
  // Falls back to the cached value while the query loads. Code-managed resources
  // stay editable but cannot be deleted here.
  const resourceId = nodeData?.resourceId as string | undefined;
  const resourceOwnership = useQuery(
    api.canvas.resourceOwnership,
    (isWorkspace || isSandbox) && projectId && environmentId
      ? { projectId: projectId, environmentId: environmentId }
      : "skip",
  );
  const isCliManaged = isAgent
    ? agentConfig?.managedBy === "cli"
    : resourceId && resourceOwnership
      ? resourceOwnership[resourceId] === "cli"
      : (nodeData as { managedBy?: string } | undefined)?.managedBy === "cli";
  const isOwnershipLoading =
    (isAgent && !!agentConfigId && agentConfig === undefined) ||
    ((isWorkspace || isSandbox) &&
      !!resourceId &&
      resourceOwnership === undefined);

  // Warn when a dashboard-owned node is named the same as a code-managed resource
  // of the same kind: the next `filthy-panty deploy` resolves by (environment,
  // name) and would adopt + overwrite this resource with the code definition.
  const cliManagedNames = useQuery(
    api.canvas.cliManagedResourceNames,
    (isAgent || isWorkspace || isSandbox) && projectId && environmentId
      ? { projectId: projectId, environmentId: environmentId }
      : "skip",
  );
  const currentResourceName = isAgent
    ? agentConfig?.name
    : (nodeData?.mountName ?? nodeData?.label);
  const collidesWithCode =
    !isCliManaged &&
    !!currentResourceName &&
    !!cliManagedNames &&
    (isAgent || isWorkspace || isSandbox) &&
    cliManagedNames[nodeType as "agent" | "workspace" | "sandbox"].includes(
      currentResourceName,
    );

  async function handleDelete() {
    if (isCliManaged || isOwnershipLoading) return;
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

  const handleTogglePublicAccess = useCallback(
    async (enabled: boolean) => {
      if (!agentConfigId) return;

      setIsSavingPublicAccess(true);
      try {
        if (enabled) {
          if (!activeDeployment) {
            const createdDeployment = await createDeployment({
              agentConfigId: agentConfigId,
            });
            if (
              createdDeployment &&
              typeof createdDeployment.endpointId === "string" &&
              typeof createdDeployment.rawApiKey === "string"
            ) {
              rememberDeploymentCredential({
                endpointId: createdDeployment.endpointId,
                apiKey: createdDeployment.rawApiKey,
                projectSlug: createdDeployment.projectSlug,
                environmentSlug: createdDeployment.environmentSlug,
              });
              setDeploymentApiKey(createdDeployment.rawApiKey);
            }
          }
          await updateConfig({
            configId: agentConfigId,
            publicAccessEnabled: true,
          });
          return;
        }

        if (activeDeployment) {
          forgetDeploymentCredential(activeDeployment.endpointId);
          setDeploymentApiKey(undefined);
          await revokeDeployment({ deploymentId: activeDeployment._id });
        }
        await updateConfig({
          configId: agentConfigId,
          publicAccessEnabled: false,
          webSocketEnabled: false,
        });
      } finally {
        setIsSavingPublicAccess(false);
      }
    },
    [
      agentConfigId,
      activeDeployment,
      createDeployment,
      revokeDeployment,
      updateConfig,
    ],
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

  const handleToggleWebSocket = useCallback(
    async (enabled: boolean) => {
      if (!agentConfigId || !publicAccessEnabled) return;

      setIsSavingWebSocket(true);
      try {
        await updateConfig({
          configId: agentConfigId,
          webSocketEnabled: enabled,
        });
      } finally {
        setIsSavingWebSocket(false);
      }
    },
    [agentConfigId, publicAccessEnabled, updateConfig],
  );

  /** Resolved name for the SettingsTab delete confirmation. */
  const resolvedName = isAgent
    ? (agentConfig?.name ?? "")
    : (nodeData?.label ?? "");
  const warmTestTab = useCallback(() => {
    if (isAgent) {
      void loadAgentTestTab();
      return;
    }

    if (isTool) {
      void loadToolTestTab();
    }
  }, [isAgent, isTool]);

  useEffect(() => {
    if (!nodeData || (!isAgent && !isTool)) return;

    if (typeof window !== "undefined" && window.requestIdleCallback) {
      const idleId = window.requestIdleCallback(warmTestTab, { timeout: 1200 });

      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(warmTestTab, 100);

    return () => window.clearTimeout(timeoutId);
  }, [nodeData, isAgent, isTool, warmTestTab]);

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
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Separator />

      {isCliManaged && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Managed by filthypanty packages, edits sync on deploy, delete is locked.
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
            {isAgent && <TabsTrigger value="variables">Variables</TabsTrigger>}
            {(isAgent || isTool || isWorkspace || isSandbox || isSkill) && (
              <TabsTrigger value="config">Config</TabsTrigger>
            )}
            {(isAgent || nodeType === "tool") && (
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
                activeDeployment={activeDeployment}
                deploymentApiKey={deploymentApiKey}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                nameChanged={!!nameChanged}
                isSaving={isSaving}
                onUpdateOutputFormat={handleUpdateOutputFormat}
                publicAccessEnabled={publicAccessEnabled}
                webSocketEnabled={webSocketEnabled}
                onTogglePublicAccess={handleTogglePublicAccess}
                onToggleWebSocket={handleToggleWebSocket}
                isSavingPublicAccess={isSavingPublicAccess}
                isSavingWebSocket={isSavingWebSocket}
                selectedProvider={selectedProvider}
                runtimeVariables={runtimeVariables}
                onSaveModelSettings={handleSaveModelSettings}
                isSavingModelSettings={isSavingModelSettings}
                onUpdateToolConfig={handleUpdateToolConfig}
                onUpdateChannelConfig={handleUpdateChannelConfig}
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
            ) : nodeType === "workspace" && node ? (
              <WorkspaceResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeData={(patch) => onUpdateNodeData(node.id, patch)}
              />
            ) : nodeType === "sandbox" && node ? (
              <SandboxResourceDetailsTab
                data={nodeData}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeData={(patch) => onUpdateNodeData(node.id, patch)}
              />
            ) : nodeType === "skill" && node ? (
              <SkillDetailsTab
                nodeId={node.id}
                nodeConfig={nodeData?.config}
                editName={editName}
                setEditName={setEditName}
                onSaveName={handleSaveName}
                onUpdateNodeConfig={(patch) =>
                  onUpdateNodeData(node.id, {
                    config: { ...(nodeData?.config ?? {}), ...patch },
                  })
                }
                onUpdateSkillPath={(p) => {
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
              <WorkspaceFilesTab projectId={projectId} nodeId={node.id} />
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
                onUpdateSkillPath={(path) => {
                  setEditName(path);
                  onUpdateNodeLabel(node.id, path);
                }}
              />
            </TabsContent>
          )}

          {/* Variables tab — agent and workspace */}
          {isAgent && (
            <TabsContent
              value="variables"
              className="flex flex-col overflow-hidden"
            >
              <VariablesTab
                key={`${agentConfigId ?? "agent"}-${JSON.stringify(runtimeVariables)}`}
                runtimeVariables={runtimeVariables}
                isSaving={isSavingVariables}
                onSave={handleSaveVariables}
                provider={selectedProvider}
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
          {isTool && node && (
            <TabsContent
              value="config"
              className="flex flex-col overflow-hidden"
            >
              <ToolConfigTab
                projectId={projectId}
                environmentId={environmentId}
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
                onUpdateNodeData={(patch) => onUpdateNodeData(node.id, patch)}
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

          {/* Test tab — agent and tool only */}
          {(isAgent || nodeType === "tool") && (
            <TabsContent value="test" className="flex flex-col overflow-hidden">
              {isAgent ? (
                <TestTab
                  activeDeployment={activeDeployment}
                  deploymentApiKey={deploymentApiKey}
                  publicAccessEnabled={publicAccessEnabled}
                  webSocketEnabled={webSocketEnabled}
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
          <TabsContent
            value="settings"
            className="flex flex-col overflow-y-auto"
          >
            <SettingsTab
              nodeType={nodeType}
              nodeName={resolvedName}
              openDeleteDialogToken={deleteRequestToken}
              onDelete={handleDelete}
              managedByCode={isCliManaged}
              deleteLocked={isCliManaged || isOwnershipLoading}
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
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
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

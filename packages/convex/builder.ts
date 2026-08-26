/**
 * The Builder: a per-stage managed agent that edits the canvas on the user's
 * behalf. Its runtime tools call the internal ops below with the invoking
 * agent's identity; scope is resolved server-side from the runtime agent row,
 * so a deployment key can only ever touch its own project/stage. Layout writes
 * go through `persistLayout`, the same pipeline as the dashboard's save.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { insertAgentConfigRow } from "./agentConfig";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
} from "./model/agentSync";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  insertConfigAuditEvent,
} from "./model/auditEvents";
import { getOwnedStage } from "./model/ownership/stage";
import { persistLayout } from "./canvas";

export const BUILDER_AGENT_NAME = "Builder";

const BUILDER_SYSTEM_PROMPT = [
  "You are the Broods Builder: you edit this stage's agent architecture on the canvas.",
  "",
  "Working rules:",
  "- Call list_canvas first every turn so your edits build on the real current layout.",
  "- add_agent creates an agent node (and its backing config). connect_nodes wires a plain data-flow edge between existing nodes; it cannot create mount or subagent relationships — leave those to the user.",
  "- update_node revises one node's name/description/system prompt. remove_node deletes a node, its edges, and its backing config.",
  "- For skills, draft instructions with draft_skill, then call test_skill with realistic example prompts. Skills are never committed by tools; the dashboard shows Accept/Discard and the user must choose.",
  "- Never delete more than the user asked for. When a request is ambiguous, ask instead of guessing.",
  "- After editing, reply with a short bullet summary of what changed — never raw JSON or node ids unless asked.",
].join("\n");

/** Audit actor recorded for every Builder-driven mutation. */
const BUILDER_ACTOR = {
  kind: "service" as const,
  id: "builder",
};

type CanvasNodeRecord = {
  id: string;
  type: "agent" | "database" | "sandbox" | "workspace" | "tool" | "skill";
  position: { x: number; y: number };
  data: unknown;
};

type CanvasEdgeRecord = {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
};

function asNodeData(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolve the project/stage a runtime agent belongs to, verifying the whole
 * chain: agent row → owning account, config by_agentId → project/stage,
 * project.orgId → the same account. Returns null when any link fails.
 */
async function resolveBuilderScope(
  ctx: QueryCtx,
  args: { accountId: Id<"accounts">; runtimeAgentId: string },
): Promise<{
  authId: string;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
} | null> {
  const normalized = ctx.db.normalizeId("agents", args.runtimeAgentId);
  if (!normalized) return null;
  const agentRow = await ctx.db.get(normalized);
  if (!agentRow || agentRow.accountId !== args.accountId) return null;

  const config = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agentId", (q) => q.eq("agentId", args.runtimeAgentId))
    .unique();
  if (!config) return null;

  const project = await ctx.db.get(config.projectId);
  const orgId = project?.orgId;
  if (!project || !orgId) return null;
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();
  if (!account || account._id !== args.accountId) return null;

  return {
    authId: config.authId,
    projectId: config.projectId,
    stageId: config.stageId,
  };
}

/** Load the layout rows for a scope, or empty scaffolding when none yet. */
async function loadLayout(
  ctx: QueryCtx,
  scope: { projectId: Id<"projects">; stageId: Id<"stages"> },
): Promise<{ nodes: CanvasNodeRecord[]; edges: CanvasEdgeRecord[] }> {
  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", scope.projectId).eq("stageId", scope.stageId),
    )
    .unique();

  return layout
    ? {
        nodes: layout.nodes as CanvasNodeRecord[],
        edges: layout.edges as CanvasEdgeRecord[],
      }
    : { nodes: [], edges: [] };
}

/** First unused String(now)-style node id (the dashboard's id space). */
function nextNodeId(nodes: CanvasNodeRecord[]): string {
  let candidate = String(Date.now());
  const taken = new Set(nodes.map((node) => node.id));
  while (taken.has(candidate)) candidate = `${candidate}-b`;
  return candidate;
}

/** Default placement: one column right of everything else, top-aligned. */
function defaultPosition(nodes: CanvasNodeRecord[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 80 };
  const maxX = Math.max(...nodes.map((node) => node.position.x));
  return { x: maxX + 320, y: 80 };
}

const snapshotValidator = v.object({
  projectId: v.string(),
  stageId: v.string(),
  nodes: v.array(
    v.object({
      id: v.string(),
      type: v.string(),
      label: v.optional(v.string()),
      status: v.optional(v.string()),
      description: v.optional(v.string()),
      agentConfigId: v.optional(v.string()),
      resourceId: v.optional(v.string()),
    }),
  ),
  edges: v.array(
    v.object({
      id: v.string(),
      source: v.string(),
      target: v.string(),
    }),
  ),
});

/** The model-facing view of the canvas: what exists and how it is wired. */
export const canvasSnapshot = internalQuery({
  args: { accountId: v.id("accounts"), runtimeAgentId: v.string() },
  returns: snapshotValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    const layout = await loadLayout(ctx, scope);

    return {
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodes: layout.nodes.map((node) => {
        const data = asNodeData(node.data);
        return {
          id: node.id,
          type: node.type,
          ...(typeof data.label === "string" ? { label: data.label } : {}),
          ...(typeof data.status === "string" ? { status: data.status } : {}),
          ...(typeof data.description === "string"
            ? { description: data.description }
            : {}),
          ...(typeof data.agentConfigId === "string"
            ? { agentConfigId: data.agentConfigId }
            : {}),
          ...(typeof data.resourceId === "string"
            ? { resourceId: data.resourceId }
            : {}),
        };
      }),
      edges: layout.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    };
  },
});

const opResultValidator = v.object({
  nodeId: v.optional(v.string()),
  configId: v.optional(v.string()),
  detail: v.string(),
});

/** Shared tail: audit one Builder op against its resolved scope. */
async function recordBuilderAudit(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  scope: { projectId: Id<"projects">; stageId: Id<"stages"> },
  input: {
    action: string;
    summary: string;
    subjectId: string;
    subjectName?: string;
    resourceKind:
      "agent" | "tool" | "skill" | "workspace" | "sandbox" | "unknown";
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await insertConfigAuditEvent(ctx.db, {
    accountId: accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    actor: BUILDER_ACTOR,
    action: input.action,
    resource: {
      kind: input.resourceKind,
      id: input.subjectId,
      name: input.subjectName,
    },
    summary: input.summary,
    detailsJson: auditDetailsJson(input.detail),
  });
}

/** Map a canvas node type onto the audit feed's resource kinds. */
function auditKindForNodeType(
  nodeType: string,
): "agent" | "tool" | "skill" | "workspace" | "sandbox" | "unknown" {
  switch (nodeType) {
    case "agent":
      return "agent";
    case "tool":
      return "tool";
    case "skill":
      return "skill";
    case "workspace":
      return "workspace";
    case "sandbox":
      return "sandbox";
    default:
      return "unknown";
  }
}

export const addAgent = internalMutation({
  args: {
    accountId: v.id("accounts"),
    runtimeAgentId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    modelId: v.optional(v.string()),
    connectFromNodeId: v.optional(v.string()),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    const layout = await loadLayout(ctx, scope);

    const trimmedName = args.name.trim();
    if (
      layout.nodes.some(
        (node) =>
          node.type === "agent" && asNodeData(node.data).label === trimmedName,
      )
    ) {
      throw new Error(`An agent named "${trimmedName}" already exists.`);
    }

    const configId = await insertAgentConfigRow(ctx, {
      authId: scope.authId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      name: trimmedName,
      modelId: args.modelId,
      description: args.description,
      systemPrompt: args.systemPrompt,
    });
    await ensureAgentsRowForConfig(ctx, configId, scope.authId);
    await pushEncryptedConfigToAgentRow(ctx, configId);

    const nodeId = nextNodeId(layout.nodes);
    const connectFrom =
      args.connectFromNodeId !== undefined &&
      layout.nodes.some((node) => node.id === args.connectFromNodeId)
        ? args.connectFromNodeId
        : undefined;
    await persistLayout(ctx, {
      authId: scope.authId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodes: [
        ...layout.nodes,
        {
          id: nodeId,
          type: "agent" as const,
          position: defaultPosition(layout.nodes),
          data: {
            label: trimmedName,
            status: "idle" as const,
            agentConfigId: configId,
          },
        },
      ],
      edges: connectFrom
        ? [
            ...layout.edges,
            {
              id: `e${connectFrom}-${nodeId}`,
              source: connectFrom,
              target: nodeId,
            },
          ]
        : layout.edges,
    });

    await recordBuilderAudit(ctx, args.accountId, scope, {
      action: "builder-add-agent",
      summary: `Builder added agent "${trimmedName}"`,
      subjectId: configId,
      subjectName: trimmedName,
      resourceKind: "agent",
      detail: { nodeId: nodeId },
    });

    return {
      nodeId: nodeId,
      configId: configId,
      detail: `Added agent "${trimmedName}".`,
    };
  },
});

export const updateNode = internalMutation({
  args: {
    accountId: v.id("accounts"),
    runtimeAgentId: v.string(),
    nodeId: v.string(),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    const layout = await loadLayout(ctx, scope);
    const node = layout.nodes.find((entry) => entry.id === args.nodeId);
    if (!node) throw new Error(`No node with id ${args.nodeId}.`);

    const data = asNodeData(node.data);
    const previousLabel = typeof data.label === "string" ? data.label : "";

    if (node.type === "agent" && typeof data.agentConfigId === "string") {
      const configId = ctx.db.normalizeId("agentConfigs", data.agentConfigId);
      const config = configId ? await ctx.db.get(configId) : null;
      if (!config)
        throw new Error(`Node ${args.nodeId} has no backing config.`);
      if (config.managedBy === "cli" || config.managedBy === "api") {
        throw new Error(
          `Agent "${previousLabel}" is managed by code; ask the user to change it in their broods/ project.`,
        );
      }

      await ctx.db.patch(config._id, {
        ...(args.label !== undefined && { name: args.label.trim() }),
        ...(args.description !== undefined && {
          description: args.description.trim() || undefined,
        }),
        ...(args.systemPrompt !== undefined && {
          systemPrompt: args.systemPrompt.trim() || undefined,
        }),
        updatedAt: Date.now(),
      });
      // Label changes rename the row too, so re-sync the runtime blob.
      await ensureAgentsRowForConfig(ctx, config._id, scope.authId);
      await pushEncryptedConfigToAgentRow(ctx, config._id);
    }

    if (args.label !== undefined || args.description !== undefined) {
      const nextNodes = layout.nodes.map((entry) =>
        entry.id === args.nodeId
          ? {
              ...entry,
              data: {
                ...data,
                ...(args.label !== undefined && { label: args.label.trim() }),
                ...(args.description !== undefined && {
                  description: args.description.trim() || undefined,
                }),
              },
            }
          : entry,
      );
      await persistLayout(ctx, {
        authId: scope.authId,
        projectId: scope.projectId,
        stageId: scope.stageId,
        nodes: nextNodes,
        edges: layout.edges,
      });
    }

    await recordBuilderAudit(ctx, args.accountId, scope, {
      action: "builder-update-node",
      summary: `Builder updated node "${args.label?.trim() || previousLabel}"`,
      subjectId: args.nodeId,
      subjectName: args.label?.trim() || previousLabel,
      resourceKind: auditKindForNodeType(node.type),
      detail: {
        nodeId: args.nodeId,
        fields: [
          ...(args.label !== undefined ? ["label"] : []),
          ...(args.description !== undefined ? ["description"] : []),
          ...(args.systemPrompt !== undefined ? ["systemPrompt"] : []),
        ],
      },
    });

    return {
      nodeId: args.nodeId,
      detail: `Updated node "${args.label?.trim() || previousLabel}".`,
    };
  },
});

export const connectNodes = internalMutation({
  args: {
    accountId: v.id("accounts"),
    runtimeAgentId: v.string(),
    sourceNodeId: v.string(),
    targetNodeId: v.string(),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    if (args.sourceNodeId === args.targetNodeId) {
      throw new Error("Cannot connect a node to itself.");
    }
    const layout = await loadLayout(ctx, scope);
    for (const endpoint of [args.sourceNodeId, args.targetNodeId]) {
      if (!layout.nodes.some((node) => node.id === endpoint)) {
        throw new Error(`No node with id ${endpoint}.`);
      }
    }
    const exists = layout.edges.some(
      (edge) =>
        (edge.source === args.sourceNodeId &&
          edge.target === args.targetNodeId) ||
        (edge.source === args.targetNodeId &&
          edge.target === args.sourceNodeId),
    );
    if (exists) {
      return {
        nodeId: args.targetNodeId,
        detail: "Those nodes are already connected.",
      };
    }

    const edgeId = `e${args.sourceNodeId}-${args.targetNodeId}`;
    await persistLayout(ctx, {
      authId: scope.authId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodes: layout.nodes,
      edges: [
        ...layout.edges,
        {
          id: edgeId,
          source: args.sourceNodeId,
          target: args.targetNodeId,
        },
      ],
    });

    await recordBuilderAudit(ctx, args.accountId, scope, {
      action: "builder-connect-nodes",
      summary: `Builder connected two nodes`,
      subjectId: edgeId,
      resourceKind: "unknown",
      detail: {
        edgeId: edgeId,
        source: args.sourceNodeId,
        target: args.targetNodeId,
      },
    });

    return {
      nodeId: args.targetNodeId,
      detail: "Connected.",
    };
  },
});

export const removeNode = internalMutation({
  args: {
    accountId: v.id("accounts"),
    runtimeAgentId: v.string(),
    nodeId: v.string(),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    const layout = await loadLayout(ctx, scope);
    const node = layout.nodes.find((entry) => entry.id === args.nodeId);
    if (!node) throw new Error(`No node with id ${args.nodeId}.`);
    if (layout.nodes.length <= 1) {
      throw new Error("Refusing to empty the canvas.");
    }

    const data = asNodeData(node.data);
    if (node.type === "agent" && typeof data.agentConfigId === "string") {
      const configId = ctx.db.normalizeId("agentConfigs", data.agentConfigId);
      const config = configId ? await ctx.db.get(configId) : null;
      if (config) {
        if (config.managedBy === "cli" || config.managedBy === "api") {
          throw new Error(
            `Agent "${String(data.label)}" is managed by code; ask the user to remove it from their broods/ project.`,
          );
        }
        // Mirror the dashboard's delete flow: secrets go with the row.
        const secrets = await ctx.db
          .query("agentRuntimeSecrets")
          .withIndex("by_agentConfigId", (q) =>
            q.eq("agentConfigId", config._id),
          )
          .collect();
        for (const secret of secrets) await ctx.db.delete(secret._id);
        await ctx.db.delete(config._id);
      }
    }

    await persistLayout(ctx, {
      authId: scope.authId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodes: layout.nodes.filter((entry) => entry.id !== args.nodeId),
      edges: layout.edges.filter(
        (edge) => edge.source !== args.nodeId && edge.target !== args.nodeId,
      ),
    });

    await recordBuilderAudit(ctx, args.accountId, scope, {
      action: "builder-remove-node",
      summary: `Builder removed node "${String(data.label ?? args.nodeId)}"`,
      subjectId: args.nodeId,
      subjectName: typeof data.label === "string" ? data.label : undefined,
      resourceKind: auditKindForNodeType(node.type),
      detail: { nodeId: args.nodeId },
    });

    return {
      nodeId: args.nodeId,
      detail: `Removed node "${String(data.label ?? args.nodeId)}".`,
    };
  },
});

// ---------------------------------------------------------------------------
// Dashboard-facing provisioning
// ---------------------------------------------------------------------------

const builderStateValidator = v.object({
  configId: v.id("agentConfigs"),
  agentId: v.string(),
});

/** The stage's Builder agent state, or null while none exists. */
export const getForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(builderStateValidator, v.null()),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();
    const builder = configs.find(
      (config) =>
        config.name === BUILDER_AGENT_NAME && config.managedBy === "dashboard",
    );
    if (!builder?.agentId) return null;

    return { configId: builder._id, agentId: builder.agentId };
  },
});

/**
 * Commit a Builder-drafted skill to the canvas: add a skill node, wire it to
 * the Builder's agent config, and enable skills. Called from the dashboard
 * rail after the user clicks Accept and the S3 write (createFromJson) succeeds.
 */
export const commitBuilderSkill = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    runtimeAgentId: v.string(),
    skillPath: v.string(),
    name: v.string(),
    description: v.string(),
    connectFromNodeId: v.optional(v.string()),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, args.stageId);
    if (!stage || stage.projectId !== args.projectId) {
      throw new Error("Stage not found.");
    }

    // Resolve the Builder agent's config to find the agent row for scope.
    const normalized = ctx.db.normalizeId("agents", args.runtimeAgentId);
    if (!normalized) throw new Error("Builder agent not found.");
    const agentRow = await ctx.db.get(normalized);
    if (!agentRow) throw new Error("Builder agent not found.");

    const config = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.runtimeAgentId))
      .unique();
    if (!config) throw new Error("Builder agent config not found.");
    if (
      config.projectId !== args.projectId ||
      config.stageId !== args.stageId
    ) {
      throw new Error("Builder agent does not belong to this stage.");
    }

    const scope = {
      authId: config.authId,
      projectId: config.projectId,
      stageId: config.stageId,
    };
    const layout = await loadLayout(ctx, scope);

    // Reject duplicate skill paths on the canvas.
    if (
      layout.nodes.some(
        (node) =>
          node.type === "skill" &&
          asNodeData(node.data).skillPath === args.skillPath,
      )
    ) {
      throw new Error(
        `Skill "${args.name}" (${args.skillPath}) is already on the canvas.`,
      );
    }

    // Add the skill canvas node.
    const nodeId = nextNodeId(layout.nodes);
    const connectFrom =
      args.connectFromNodeId !== undefined &&
      layout.nodes.some((node) => node.id === args.connectFromNodeId)
        ? args.connectFromNodeId
        : undefined;

    await persistLayout(ctx, {
      authId: scope.authId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodes: [
        ...layout.nodes,
        {
          id: nodeId,
          type: "skill" as const,
          position: defaultPosition(layout.nodes),
          data: {
            label: args.name,
            skillPath: args.skillPath,
            description: args.description,
          },
        },
      ],
      edges: connectFrom
        ? [
            ...layout.edges,
            {
              id: `e${connectFrom}-${nodeId}`,
              source: connectFrom,
              target: nodeId,
            },
          ]
        : layout.edges,
    });

    // Enable skills on the Builder agent and add the new path.
    const extra = asRecord(config.extraConfig);
    const prevSkills = asRecord(extra.skills);
    const currentAllowed = Array.isArray(prevSkills.allowed)
      ? (prevSkills.allowed as string[])
      : [];

    const nextAllowed = currentAllowed.includes(args.skillPath)
      ? currentAllowed
      : [...currentAllowed, args.skillPath];

    const nextExtraConfig = {
      ...extra,
      skills: {
        enabled: true,
        allowed: nextAllowed,
      },
    };

    await ctx.db.patch(config._id, {
      extraConfig: nextExtraConfig,
      updatedAt: Date.now(),
    });
    await pushEncryptedConfigToAgentRow(ctx, config._id);

    await recordBuilderAudit(ctx, agentRow.accountId, scope, {
      action: "builder-commit-skill",
      summary: `Builder committed skill "${args.name}" (${args.skillPath})`,
      subjectId: nodeId,
      subjectName: args.name,
      resourceKind: "skill",
      detail: { nodeId: nodeId, skillPath: args.skillPath },
    });

    return {
      nodeId: nodeId,
      detail: `Committed skill "${args.name}" (${args.skillPath}).`,
    };
  },
});

/**
 * Ensure the stage has its Builder agent (dashboard-managed), returning the
 * runtime agent id the chat rail streams against. Idempotent.
 */
export const ensureForStage = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: builderStateValidator,
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();
    const existing = configs.find(
      (config) =>
        config.name === BUILDER_AGENT_NAME && config.managedBy === "dashboard",
    );

    let configId: Id<"agentConfigs">;
    if (existing) {
      configId = existing._id;
    } else {
      configId = await insertAgentConfigRow(ctx, {
        authId: authUser.id,
        projectId: projectId,
        stageId: stageId,
        name: BUILDER_AGENT_NAME,
        systemPrompt: BUILDER_SYSTEM_PROMPT,
      });
      await ctx.db.patch(configId, {
        extraConfig: { builder: { enabled: true } },
      });
      const accountId = await accountIdForProject(ctx, projectId);
      if (accountId) {
        await insertConfigAuditEvent(ctx.db, {
          accountId: accountId,
          projectId: projectId,
          stageId: stageId,
          actor: dashboardAuditActor(authUser),
          action: "created",
          resource: { kind: "agent", id: configId, name: BUILDER_AGENT_NAME },
          summary: "Builder agent provisioned for this stage",
        });
      }
    }

    const agentId = await ensureAgentsRowForConfig(ctx, configId, authUser.id);
    if (!agentId) {
      throw new Error(
        "Provision your organization's API account first (Settings → API Access).",
      );
    }
    await pushEncryptedConfigToAgentRow(ctx, configId);

    return { configId: configId, agentId: agentId };
  },
});

/**
 * Connect a channel (Telegram, Slack, Discord, etc.) to an agent on the canvas.
 * Patches extraConfig.channels.<kind> with the provided credentials and
 * re-encrypts the agent config so the runtime picks up the new channel.
 */
export const connectChannel = internalMutation({
  args: {
    accountId: v.id("accounts"),
    runtimeAgentId: v.string(),
    agentNodeId: v.string(),
    channel: v.string(),
    credentials: v.record(v.string(), v.string()),
  },
  returns: opResultValidator,
  handler: async (ctx, args) => {
    const scope = await resolveBuilderScope(ctx, args);
    if (!scope) throw new Error("Builder scope could not be resolved.");
    const layout = await loadLayout(ctx, scope);

    const node = layout.nodes.find((entry) => entry.id === args.agentNodeId);
    if (!node) throw new Error(`No node with id ${args.agentNodeId}.`);
    if (node.type !== "agent") {
      throw new Error(
        `Node "${args.agentNodeId}" is a ${node.type} node, not an agent. Only agents can receive channel connections.`,
      );
    }

    const data = asNodeData(node.data);
    const agentConfigId =
      typeof data.agentConfigId === "string" ? data.agentConfigId : null;
    if (!agentConfigId) {
      throw new Error(
        `Agent node "${args.agentNodeId}" has no backing config.`,
      );
    }

    const configId = ctx.db.normalizeId("agentConfigs", agentConfigId);
    if (!configId) throw new Error("Agent config not found.");
    const config = await ctx.db.get(configId);
    if (!config) throw new Error("Agent config not found.");
    if (config.projectId !== scope.projectId || config.stageId !== scope.stageId) {
      throw new Error("Agent config does not belong to this stage.");
    }

    const extra = asRecord(config.extraConfig);
    const channels = asRecord(extra.channels);
    const nextChannels = {
      ...channels,
      [args.channel]: {
        ...args.credentials,
      },
    };
    const nextExtra = {
      ...extra,
      channels: nextChannels,
    };

    await ctx.db.patch(configId, {
      extraConfig: nextExtra,
      updatedAt: Date.now(),
    });
    await pushEncryptedConfigToAgentRow(ctx, configId);

    await recordBuilderAudit(ctx, args.accountId, scope, {
      action: "builder-connect-channel",
      summary: `Builder connected ${args.channel} to agent "${String(data.label ?? args.agentNodeId)}"`,
      subjectId: args.agentNodeId,
      subjectName: typeof data.label === "string" ? data.label : undefined,
      resourceKind: "unknown",
      detail: {
        channel: args.channel,
        agentConfigId: agentConfigId,
      },
    });

    return {
      nodeId: args.agentNodeId,
      detail: `Connected ${args.channel} to "${String(data.label ?? args.agentNodeId)}".`,
    };
  },
});

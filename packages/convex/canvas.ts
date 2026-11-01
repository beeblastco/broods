import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import {
  accountCipherForWrite,
  hasEncryptionSecret,
} from "./model/accountKeys";
import {
  canvasEdgeValidator,
  canvasNodeValidator,
  type CanvasEdge,
  type CanvasNode,
} from "./model/canvasShapes";
import { stableJson } from "./model/objects";
import { assertNoAccountScopedResourceConflict } from "./model/cliSync";
import { hasReservation } from "./model/cliSyncResources";
import { assertSnapshotInScope } from "./sandbox/snapshots";
import { sandboxDisplayConfig } from "./model/sandboxDisplayConfig";
import { getOwnedStage, getProjectStage } from "./model/ownership/stage";
import {
  getProjectForRole,
  getProjectForWrite,
} from "./model/ownership/project";
import {
  normalizeWorkspaceConfig,
  workspaceEnvRefFields,
} from "./model/workspaceRules";

const saveLayoutResult = v.object({
  layoutId: v.id("canvasLayouts"),
  nodes: v.array(canvasNodeValidator),
  edges: v.array(canvasEdgeValidator),
});

type MaterializeNodeOptions = {
  account: Doc<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  node: CanvasNode;
  data: Record<string, unknown>;
  name: string;
  description: string | undefined;
  resourceId: string;
  changed: boolean;
  now: number;
  previousData: Record<string, unknown>;
};

/** The next `broods deploy` adopts a same-named dashboard resource; the panel warns of it. */
export const cliManagedResourceNames = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.object({
    agent: v.array(v.string()),
    workspace: v.array(v.string()),
    sandbox: v.array(v.string()),
  }),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<{ agent: string[]; workspace: string[]; sandbox: string[] }> => {
    const empty = { agent: [], workspace: [], sandbox: [] };
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return empty;

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return empty;

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
      .unique();
    if (!account) return empty;

    const agents = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();
    const workspaces = await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
      .collect();
    const sandboxes = await ctx.db
      .query("sandboxConfigs")
      .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
      .collect();

    return {
      agent: agents
        .filter((row) => row.managedBy === "cli")
        .map((row) => row.name),
      workspace: workspaces
        .filter(
          (row) => row.accountId === account._id && row.managedBy === "cli",
        )
        .map((row) => row.name),
      sandbox: sandboxes
        .filter(
          (row) => row.accountId === account._id && row.managedBy === "cli",
        )
        .map((row) => row.name),
    };
  },
});

/** No `stageId` reads the default stage, so a cold load can ask before the stage list. */
export const getByProject = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.optional(v.id("stages")),
  },
  returns: v.union(
    v.null(),
    v.object({
      nodes: v.array(canvasNodeValidator),
      edges: v.array(canvasEdgeValidator),
    }),
  ),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] } | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // A subscriber may briefly hold a just-deleted stage: null lets the canvas unmount.
    const stage = await getProjectStage(ctx, authUser.id, projectId, stageId);
    if (!stage) return null;

    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stage._id),
      )
      .unique();

    return layout ? { nodes: layout.nodes, edges: layout.edges } : null;
  },
});

/** Read from the rows, not the node's cached `managedBy`, which can be stale or missing. */
export const resourceOwnership = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.record(
    v.string(),
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<Record<string, "cli" | "dashboard" | "api">> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return {};

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return {};

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
      .unique();
    if (!account) return {};

    const workspaces = await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
      .collect();
    const sandboxes = await ctx.db
      .query("sandboxConfigs")
      .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
      .collect();

    const ownership: Record<string, "cli" | "dashboard" | "api"> = {};
    for (const row of [...workspaces, ...sandboxes]) {
      if (row.accountId !== account._id) continue;
      ownership[row._id] =
        row.managedBy === "cli" || row.managedBy === "api"
          ? row.managedBy
          : "dashboard";
    }

    return ownership;
  },
});

export const saveLayout = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    nodes: v.array(canvasNodeValidator),
    edges: v.array(canvasEdgeValidator),
  },
  returns: saveLayoutResult,
  handler: async (
    ctx,
    { projectId, stageId, nodes, edges },
  ): Promise<{
    layoutId: Id<"canvasLayouts">;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) {
      throw new Error("The canvas can only be changed by an org admin.");
    }

    const stage = await getOwnedStage(ctx, authUser.id, stageId, "admin");
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    const now = Date.now();
    const account = await accountForProject(ctx, project);
    const existing = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .unique();
    const persistedNodes = await materializeRuntimeNodes(
      ctx,
      account,
      projectId,
      stageId,
      nodes,
      (existing?.nodes ?? []) as CanvasNode[],
    );
    if (
      resourceReferenceSignature(persistedNodes) !==
      resourceReferenceSignature((existing?.nodes ?? []) as CanvasNode[])
    ) {
      await pruneOrphanedDashboardRows(ctx, account, stageId, persistedNodes);
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        nodes: persistedNodes,
        edges: edges,
        updatedAt: now,
      });

      return { layoutId: existing._id, nodes: persistedNodes, edges: edges };
    }

    const layoutId = await ctx.db.insert("canvasLayouts", {
      authId: authUser.id,
      projectId: projectId,
      stageId: stageId,
      nodes: persistedNodes,
      edges: edges,
      updatedAt: now,
    });

    return { layoutId: layoutId, nodes: persistedNodes, edges: edges };
  },
});

async function accountForProject(
  ctx: MutationCtx,
  project: Doc<"projects">,
): Promise<Doc<"accounts"> | null> {
  return await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
    .unique();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Null without the encryption secret: the row is stored config-less, the save goes on. */
async function encryptSandboxConfigFields(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  config: Record<string, unknown>,
): Promise<{
  encryptedConfig: string;
  encryptionIv: string;
  encryptionTag: string;
} | null> {
  if (!hasEncryptionSecret()) return null;
  const cipher = await accountCipherForWrite(ctx, accountId);
  const encrypted = await cipher.encrypt(
    "sandboxConfigs:encryptedConfig",
    config,
  );

  return {
    encryptedConfig: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionTag: encrypted.tag,
  };
}

async function materializeRuntimeNodes(
  ctx: MutationCtx,
  account: Doc<"accounts"> | null,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  nodes: CanvasNode[],
  previousNodes: CanvasNode[],
): Promise<CanvasNode[]> {
  if (!account) return nodes;

  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const result: CanvasNode[] = [];
  for (const node of nodes) {
    if (node.type !== "workspace" && node.type !== "sandbox") {
      result.push(node);
      continue;
    }

    const data = asRecord(node.data);
    const name = nodeName(data) || node.type;
    const description =
      typeof data.description === "string" ? data.description : undefined;
    const resourceId =
      typeof data.resourceId === "string" ? data.resourceId.trim() : "";
    const now = Date.now();
    const previousData = asRecord(previousById.get(node.id)?.data);
    const changed = resourceFieldsChanged(data, previousData);

    const materialize =
      node.type === "workspace"
        ? materializeWorkspaceNode
        : materializeSandboxNode;
    result.push(
      await materialize(ctx, {
        account: account,
        projectId: projectId,
        stageId: stageId,
        node: node,
        data: data,
        name: name,
        description: description,
        resourceId: resourceId,
        changed: changed,
        now: now,
        previousData: previousData,
      }),
    );
  }

  return result;
}

async function materializeSandboxNode(
  ctx: MutationCtx,
  options: MaterializeNodeOptions,
): Promise<CanvasNode> {
  const { account, projectId, stageId, node, data, name, description } =
    options;
  const { resourceId, changed, now, previousData } = options;
  const sandboxConfig = asRecord(data.config);
  const hasConfig = Object.keys(sandboxConfig).length > 0;
  const encrypted =
    changed && hasConfig
      ? await encryptSandboxConfigFields(ctx, account._id, sandboxConfig)
      : null;
  const normalized = resourceId
    ? ctx.db.normalizeId("sandboxConfigs", resourceId)
    : null;
  const byId = normalized ? await ctx.db.get(normalized) : null;
  if (
    byId &&
    byId.accountId === account._id &&
    !rowBelongsToStage(byId, projectId, stageId)
  ) {
    throw new Error(
      "Sandbox resource belongs to a different project or stage.",
    );
  }
  const existing =
    byId && byId.accountId === account._id
      ? byId
      : await ctx.db
          .query("sandboxConfigs")
          .withIndex("by_stageId_and_name", (q) =>
            q.eq("stageId", stageId).eq("name", name),
          )
          .first();
  if (existing && existing.accountId === account._id) {
    const codeManaged =
      existing.managedBy === "cli" || existing.managedBy === "api";
    if (!codeManaged && changed) {
      // Even an unchanged snapshot: the canvas copy can be older than the row.
      await assertSnapshotInScope(
        ctx,
        account._id,
        { projectId: projectId, stageId: stageId },
        sandboxConfig.snapshot,
      );
      await ctx.db.patch(existing._id, {
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: description,
        managedBy: "dashboard",
        updatedAt: now,
        ...encrypted,
      });
    }

    return sandboxLayoutNode(
      node,
      data,
      existing._id,
      codeManaged ? previousData.config : data.config,
    );
  }

  await assertNoAccountScopedResourceConflict(ctx, {
    table: "sandboxConfigs",
    accountId: account._id,
    name: name,
  });
  await assertSnapshotInScope(
    ctx,
    account._id,
    { projectId: projectId, stageId: stageId },
    sandboxConfig.snapshot,
  );
  const createdId = await ctx.db.insert("sandboxConfigs", {
    accountId: account._id,
    projectId: projectId,
    stageId: stageId,
    name: name,
    description: description,
    managedBy: "dashboard",
    createdAt: now,
    updatedAt: now,
    ...encrypted,
  });

  return sandboxLayoutNode(node, data, createdId, data.config);
}

async function materializeWorkspaceNode(
  ctx: MutationCtx,
  options: MaterializeNodeOptions,
): Promise<CanvasNode> {
  const { account, projectId, stageId, node, data, name, description } =
    options;
  const { resourceId, changed, now } = options;
  // Same rules as the config API: a canvas save never stores what it refuses.
  const config = normalizeWorkspaceConfig(data.config);
  const normalized = resourceId
    ? ctx.db.normalizeId("workspaceConfigs", resourceId)
    : null;
  const byId = normalized ? await ctx.db.get(normalized) : null;
  if (
    byId &&
    byId.accountId === account._id &&
    !rowBelongsToStage(byId, projectId, stageId)
  ) {
    throw new Error(
      "Workspace resource belongs to a different project or stage.",
    );
  }
  // Bind by (stage, name) too: a duplicate row breaks the CLI's by-name `.unique()` on deploy.
  const existing =
    byId && byId.accountId === account._id
      ? byId
      : await ctx.db
          .query("workspaceConfigs")
          .withIndex("by_stageId_and_name", (q) =>
            q.eq("stageId", stageId).eq("name", name),
          )
          .first();
  if (existing && existing.accountId === account._id) {
    if (
      existing.managedBy !== "cli" &&
      existing.managedBy !== "api" &&
      changed
    ) {
      await ctx.db.patch(existing._id, {
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: description,
        config: config,
        ...workspaceEnvRefFields(config),
        managedBy: "dashboard",
        updatedAt: now,
      });
    }

    return { ...node, data: { ...data, resourceId: existing._id } };
  }

  await assertNoAccountScopedResourceConflict(ctx, {
    table: "workspaceConfigs",
    accountId: account._id,
    name: name,
  });
  const createdId = await ctx.db.insert("workspaceConfigs", {
    accountId: account._id,
    projectId: projectId,
    stageId: stageId,
    name: name,
    description: description,
    config: config,
    ...workspaceEnvRefFields(config),
    managedBy: "dashboard",
    createdAt: now,
    updatedAt: now,
  });

  return { ...node, data: { ...data, resourceId: createdId } };
}

function nodeName(data: Record<string, unknown>): string {
  const name =
    typeof data.mountName === "string"
      ? data.mountName
      : typeof data.label === "string"
        ? data.label
        : "";

  return name.trim();
}

/**
 * A config still holding a reserved instance is kept, as the CLI prune does, so the instance
 * never names a gone config; `pruneReleasedDashboardSandbox` drops it once released.
 */
export async function pruneOrphanedDashboardRows(
  ctx: MutationCtx,
  account: Doc<"accounts"> | null,
  stageId: Id<"stages">,
  persistedNodes: CanvasNode[],
): Promise<void> {
  if (!account) return;

  const referenced = new Set(
    persistedNodes
      .map((node) => asRecord(node.data).resourceId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  const workspaces = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const sandboxes = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();

  const orphaned = (
    row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
  ): boolean =>
    row.accountId === account._id &&
    row.managedBy !== "cli" &&
    row.managedBy !== "api" &&
    !referenced.has(row._id);
  for (const row of workspaces) {
    if (orphaned(row)) await ctx.db.delete(row._id);
  }
  for (const row of sandboxes) {
    if (orphaned(row) && !(await hasReservation(ctx, row._id))) {
      await ctx.db.delete(row._id);
    }
  }
}

export async function pruneReleasedDashboardSandbox(
  ctx: MutationCtx,
  sandboxConfigId: Id<"sandboxConfigs">,
): Promise<void> {
  const config = await ctx.db.get(sandboxConfigId);
  if (!config?.projectId || !config.stageId) return;
  if (config.managedBy === "cli" || config.managedBy === "api") return;
  if (await hasReservation(ctx, config._id)) return;
  const { projectId, stageId } = config;
  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .unique();
  if (!layout) return;
  const referenced = layout.nodes.some(
    (node) => asRecord(node.data).resourceId === config._id,
  );
  if (!referenced) await ctx.db.delete(config._id);
}

function resourceFieldsChanged(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): boolean {
  return (
    nodeName(next) !== nodeName(previous) ||
    stableJson(next.description ?? null) !==
      stableJson(previous.description ?? null) ||
    stableJson(next.config ?? null) !== stableJson(previous.config ?? null)
  );
}

function resourceReferenceSignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => asRecord(node.data).resourceId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort()
    .join("\n");
}

function rowBelongsToStage(
  row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): boolean {
  return row.projectId === projectId && row.stageId === stageId;
}

/**
 * Layouts are UI state, not a secret store: only the display fields the node renders persist.
 * A code-managed row re-derives them from what was persisted, as the save never patches it.
 */
function sandboxLayoutNode(
  node: CanvasNode,
  data: Record<string, unknown>,
  resourceId: Id<"sandboxConfigs">,
  displayConfig: unknown,
): CanvasNode {
  const { config: _config, ...safeData } = data;
  const display = sandboxDisplayConfig(displayConfig);

  return {
    ...node,
    data: {
      ...safeData,
      resourceId: resourceId,
      ...(Object.keys(display).length > 0 ? { config: display } : {}),
    },
  };
}

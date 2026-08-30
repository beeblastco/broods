/**
 * Canvas layout persistence keyed by (project, stage).
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { encryptAgentConfigBlob } from "./model/agentConfigCodec";
import { stableJson } from "./model/objects";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";

export const canvasEdgeValidator = v.object({
  id: v.string(),
  source: v.string(),
  target: v.string(),
  animated: v.optional(v.boolean()),
});

export const canvasNodeValidator = v.object({
  id: v.string(),
  type: v.union(
    v.literal("agent"),
    v.literal("database"),
    v.literal("sandbox"),
    v.literal("workspace"),
    v.literal("mcp"),
    v.literal("skill"),
  ),
  position: v.object({ x: v.number(), y: v.number() }),
  data: v.any(),
});

const saveLayoutResult = v.object({
  layoutId: v.id("canvasLayouts"),
  nodes: v.array(canvasNodeValidator),
  edges: v.array(canvasEdgeValidator),
});

export type CanvasEdge = Infer<typeof canvasEdgeValidator>;

// `data` is `v.any()` (which infers `any`); every consumer treats it as an
// unknown-valued record, so the override keeps type checking without casts.
export type CanvasNode = Omit<Infer<typeof canvasNodeValidator>, "data"> & {
  data: Record<string, unknown>;
};

/** Shared inputs for materializing one workspace/sandbox canvas node. */
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
};

/**
 * Names of code-managed (`managedBy: "cli"`) resources in this stage, by
 * kind. The side panel uses this to warn when a dashboard-created agent /
 * workspace / sandbox is named the same as a code-managed one — the next
 * `broods deploy` would adopt and overwrite that resource with the code
 * definition (the CLI resolves by `(stageId, name)`).
 */
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
  handler: async (ctx, { projectId, stageId }) => {
    const empty = { agent: [], workspace: [], sandbox: [] };
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project || !project.orgId) return empty;

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return empty;

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
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

export const getByProject = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.union(
    v.null(),
    v.object({
      nodes: v.array(canvasNodeValidator),
      edges: v.array(canvasEdgeValidator),
    }),
  ),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Reactive subscribers may briefly hold a just-deleted project/stage;
    // return null instead of throwing so the canvas unmounts without crashing.
    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return null;

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .unique();

    return layout ? { nodes: layout.nodes, edges: layout.edges } : null;
  },
});

/**
 * Authoritative ownership for a stage's workspace/sandbox resources,
 * keyed by row `_id` (the canvas node's `resourceId`). The side panel reads this
 * — not the cached `managedBy` on canvas node data — so the "managed by code"
 * lock/warning reflects the real row even if the node JSON is stale or missing it.
 */
export const resourceOwnership = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.record(
    v.string(),
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project || !project.orgId) return {};

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return {};

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
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
      // Preserve both code-owner markers — collapsing "api" into "dashboard"
      // would unlock API-managed resources in the side panel.
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
  handler: async (ctx, { projectId, stageId, nodes, edges }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
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

/** Return the org account backing a project, if it has been provisioned. */
async function accountForProject(
  ctx: MutationCtx,
  project: Doc<"projects">,
): Promise<Doc<"accounts"> | null> {
  if (!project.orgId) return null;

  return await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
    .unique();
}

/** Coerce an unknown canvas node data payload into a mutable record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reject old account-scoped runtime resources instead of silently creating a new
 * stage-scoped row with the same name and a different runtime id.
 */
async function assertNoAccountScopedResourceConflict(
  ctx: MutationCtx,
  options: {
    table: "workspaceConfigs" | "sandboxConfigs";
    accountId: Id<"accounts">;
    name: string;
  },
): Promise<void> {
  const rows = await ctx.db
    .query(options.table)
    .withIndex("by_accountId_and_name", (q) =>
      q.eq("accountId", options.accountId).eq("name", options.name),
    )
    .collect();
  const accountScoped = rows.find((row) => row.stageId === undefined);
  if (!accountScoped) return;

  throw new Error(
    `${options.table} "${options.name}" is account-scoped legacy data. ` +
      "Migrate it to a project/stage or delete it before saving the canvas.",
  );
}

/**
 * Encrypt a plaintext sandbox config object into the at-rest blob fields, or
 * `null` when the encryption secret is unavailable (then the row is stored
 * config-less rather than failing the whole canvas save).
 */
async function encryptSandboxConfigFields(
  config: Record<string, unknown>,
): Promise<{
  encryptedConfig: string;
  encryptionIv: string;
  encryptionTag: string;
} | null> {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) return null;
  const encrypted = await encryptAgentConfigBlob(config, secret);

  return {
    encryptedConfig: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionTag: encrypted.tag,
  };
}

/**
 * Ensure canvas workspace/sandbox nodes point at real, stage-scoped core
 * resource rows. Creates a `managedBy: "dashboard"` row for new nodes and patches
 * existing dashboard-owned rows from the node's edited config, so dashboard adds
 * and edits become real (the runtime resolves these rows by `_id`). Rows owned by
 * a `broods/` project (`managedBy: "cli"`) are left untouched — code is their
 * source of truth and the side panel surfaces them as locked.
 */
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
    const name =
      String(data.mountName ?? data.label ?? node.type).trim() || node.type;
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
      }),
    );
  }

  return result;
}

/**
 * Sandbox arm of `materializeRuntimeNodes`: binds the node to its
 * `sandboxConfigs` row (creating or patching a dashboard-owned one) and
 * returns the node to persist. The config blob is encrypted at rest (may
 * carry provider secrets).
 */
async function materializeSandboxNode(
  ctx: MutationCtx,
  options: MaterializeNodeOptions,
): Promise<CanvasNode> {
  const { account, projectId, stageId, node, data, name, description } =
    options;
  const { resourceId, changed, now } = options;
  const sandboxConfig = asRecord(data.config);
  const hasConfig = Object.keys(sandboxConfig).length > 0;
  const encrypted =
    changed && hasConfig
      ? await encryptSandboxConfigFields(sandboxConfig)
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
        managedBy: "dashboard",
        updatedAt: now,
        ...encrypted,
      });
    }

    return sandboxLayoutNode(node, data, existing._id);
  }

  await assertNoAccountScopedResourceConflict(ctx, {
    table: "sandboxConfigs",
    accountId: account._id,
    name: name,
  });
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

  return sandboxLayoutNode(node, data, createdId);
}

/**
 * Workspace arm of `materializeRuntimeNodes`: binds the node to its
 * `workspaceConfigs` row (creating or patching a dashboard-owned one) and
 * returns the node to persist.
 */
async function materializeWorkspaceNode(
  ctx: MutationCtx,
  options: MaterializeNodeOptions,
): Promise<CanvasNode> {
  const { account, projectId, stageId, node, data, name, description } =
    options;
  const { resourceId, changed, now } = options;
  const config = asRecord(data.config).storage
    ? data.config
    : { storage: { provider: "s3" } };
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
  // Fall back to (stage, name) so a node named like an existing row
  // binds to it instead of inserting a duplicate — duplicates would later
  // break the CLI's by-name `.unique()` lookup on deploy.
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
    // Code owns CLI/API-managed rows; dashboard edits are not written back.
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
    managedBy: "dashboard",
    createdAt: now,
    updatedAt: now,
  });

  return { ...node, data: { ...data, resourceId: createdId } };
}

/**
 * Delete dashboard-owned workspace/sandbox rows in this stage that no
 * canvas node references anymore, making node deletion a real resource delete.
 * CLI-owned (`managedBy: "cli"`) rows are never touched — code owns their
 * lifecycle and prune removes them via the CLI instead.
 */
async function pruneOrphanedDashboardRows(
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

  for (const row of [...workspaces, ...sandboxes]) {
    if (row.accountId !== account._id) continue;
    if (row.managedBy === "cli" || row.managedBy === "api") continue;
    if (referenced.has(row._id)) continue;
    await ctx.db.delete(row._id);
  }
}

/** Compare only the node fields that materialize into runtime resource rows. */
function resourceFieldsChanged(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): boolean {
  return (
    String(next.mountName ?? next.label ?? "").trim() !==
      String(previous.mountName ?? previous.label ?? "").trim() ||
    stableJson(next.description ?? null) !==
      stableJson(previous.description ?? null) ||
    stableJson(next.config ?? null) !== stableJson(previous.config ?? null)
  );
}

/** Stable signature of runtime resource references in a canvas node list. */
function resourceReferenceSignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => asRecord(node.data).resourceId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort()
    .join("\n");
}

/** True when a runtime resource row belongs to the canvas stage being saved. */
function rowBelongsToStage(
  row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): boolean {
  return row.projectId === projectId && row.stageId === stageId;
}

/**
 * Canvas layouts are UI state, not a secret store. Sandbox config may include
 * provider credentials/env vars, so persist only display metadata + resource id.
 */
function sandboxLayoutNode(
  node: CanvasNode,
  data: Record<string, unknown>,
  resourceId: Id<"sandboxConfigs">,
): CanvasNode {
  const { config: _config, ...safeData } = data;

  return { ...node, data: { ...safeData, resourceId: resourceId } };
}

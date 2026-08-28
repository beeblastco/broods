/**
 * Mirrors API-managed agents' runtime wiring onto the dashboard canvas — the
 * account-API counterpart of cliSync's `syncCanvasLayoutForManifest`.
 *
 * An agent created or updated through the public account API carries its
 * wiring inline in the encrypted config blob (`sandbox`, `workspaces`,
 * `skills.allowed`, `subagent.allowed`). The canvas never sees any of it: the
 * back-sync only drops a bare agent node, so the Architecture view shows an
 * agent floating with no workspace, sandbox, or skills even though the runtime
 * resolves all of them. This module recomputes the desired wiring for every
 * `managedBy: "api"` agent in a stage and materializes it as locked
 * `managedBy: "api"` nodes and edges, so the canvas mirrors the API config
 * without ever fighting its owner.
 *
 * Referenced workspace/sandbox rows created through the API are account-scoped
 * (no project/stage). They are adopted into the canvas stage here
 * — without adoption `materializeRuntimeNodes` rejects them on the next
 * dashboard save ("belongs to a different project or stage").
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { CanvasEdge, CanvasNode } from "../canvas";
import { decryptAgentConfigBlob } from "./agentConfigCodec";
import { isPlainObject } from "./objects";

// Same column layout as the CLI canvas sync; agents keep whatever position
// the back-sync or the user gave them.
const API_WIRING_COLUMN_X = {
  sandbox: 340,
  workspace: 600,
  skill: 860,
} as const;

/** The stored layout normalized and indexed by id and back-references. */
type ExistingApiCanvas = {
  existingByAgentConfigId: Map<string, CanvasNode>;
  existingByResourceId: Map<string, CanvasNode>;
  existingEdges: CanvasEdge[];
  nextById: Map<string, CanvasNode>;
};

/** Shared state threaded through one wiring pass over a stage's canvas. */
type ApiWiringSync = ExistingApiCanvas & {
  ctx: MutationCtx;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  secret: string;
  configs: Doc<"agentConfigs">[];
  /** Lazily loaded skill names per owning account. */
  skillNamesByAccount: Map<Id<"accounts">, Set<string>>;
  /** Next free row per resource column; see {@link API_WIRING_COLUMN_X}. */
  rowY: Record<keyof typeof API_WIRING_COLUMN_X, number>;
  desiredEdges: Map<string, CanvasEdge>;
  desiredWiringNodeIds: Set<string>;
  workspaceReferenced: Set<string>;
  workspaceHasWriter: Set<string>;
  agentNodeByConfigId: Map<string, string>;
  /**
   * Agent nodes whose config blob could not be read this pass: their existing
   * wiring must survive reconciliation, since the desired state is unknown.
   */
  unresolvedAgentNodeIds: Set<string>;
};

/**
 * Recomputes the desired API-managed wiring for one stage's canvas and
 * patches the layout: locked workspace/sandbox/skill nodes, agent→resource
 * edges, and pruning of wiring the configs no longer declare. Resources are
 * resolved against each agent's own account, so a mixed stage never
 * aliases or prunes another account's wiring. Agents whose blob cannot be
 * decrypted keep their existing wiring untouched.
 */
export async function syncApiAgentCanvasWiring(
  ctx: MutationCtx,
  options: {
    projectId: Id<"projects">;
    stageId: Id<"stages">;
  },
): Promise<void> {
  const { projectId, stageId } = options;
  // Without the shared secret no blob can be decrypted, so no wiring is known;
  // leave the canvas untouched rather than pruning edges we cannot recompute.
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    return;
  }

  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .unique();
  if (!layout) {
    return;
  }

  const configs = (
    await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect()
  ).filter((config) => config.managedBy === "api" && config.agentId);

  const sync: ApiWiringSync = {
    ...indexExistingCanvas(layout),
    ctx: ctx,
    projectId: projectId,
    stageId: stageId,
    secret: secret,
    configs: configs,
    skillNamesByAccount: new Map(),
    rowY: { sandbox: 80, workspace: 80, skill: 80 },
    desiredEdges: new Map(),
    desiredWiringNodeIds: new Set(),
    workspaceReferenced: new Set(),
    workspaceHasWriter: new Set(),
    agentNodeByConfigId: new Map(),
    unresolvedAgentNodeIds: new Set(),
  };

  for (const config of configs) {
    await wireAgentConfig(sync, config);
  }

  stampWorkspaceReadOnly(sync);
  const reconciled = reconcileApiWiring(sync);

  await ctx.db.patch(layout._id, {
    nodes: reconciled.nextNodes,
    edges: reconciled.nextEdges,
    updatedAt: Date.now(),
  });
}

/** Default agent→service edge, matching the dashboard's `xy-edge__` id scheme. */
function addDefaultEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  target: string,
): void {
  const id = `xy-edge__${source}-${target}`;
  edges.set(id, { id: id, source: source, target: target, animated: true });
}

/**
 * Side-handle mount edge for a workspace↔sandbox override, matching the
 * dashboard's `mount:` id scheme (handles are rebuilt from the id on load).
 */
function addMountEdge(
  edges: Map<string, CanvasEdge>,
  workspaceNodeId: string,
  sandboxNodeId: string,
): void {
  const id = `mount:${workspaceNodeId}-left-${sandboxNodeId}-right`;
  edges.set(id, {
    id: id,
    source: workspaceNodeId,
    target: sandboxNodeId,
    animated: false,
  });
}

/**
 * Adopt an API-created (account-scoped) row into this stage so canvas
 * saves accept it; rows owned by another account or living in another
 * stage cannot be drawn here and are skipped. Dashboard-owned rows in
 * this stage keep their owner — an API agent may reference a
 * dashboard-created resource without stealing it.
 */
async function adoptResourceRow(
  sync: ApiWiringSync,
  row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
  ownerAccountId: Id<"accounts">,
): Promise<boolean> {
  if (row.accountId !== ownerAccountId) {
    return false;
  }
  if (row.stageId === undefined) {
    await sync.ctx.db.patch(row._id, {
      projectId: sync.projectId,
      stageId: sync.stageId,
      managedBy: "api",
      updatedAt: Date.now(),
    });

    return true;
  }

  return row.stageId === sync.stageId;
}

/** Normalize the stored layout and index its nodes by id and back-references. */
function indexExistingCanvas(layout: Doc<"canvasLayouts">): ExistingApiCanvas {
  const existingNodes = (layout.nodes as CanvasNode[]).map((node) => ({
    id: String(node.id),
    type: node.type,
    position: node.position ?? { x: 0, y: 0 },
    data: isPlainObject(node.data) ? node.data : {},
  }));
  const existingEdges: CanvasEdge[] = (layout.edges as CanvasEdge[]).map(
    (edge) => ({
      id: String(edge.id),
      source: String(edge.source),
      target: String(edge.target),
      animated: edge.animated,
    }),
  );
  const nextById = new Map(existingNodes.map((node) => [node.id, node]));
  const existingByAgentConfigId = new Map<string, CanvasNode>();
  const existingByResourceId = new Map<string, CanvasNode>();
  for (const node of existingNodes) {
    if (typeof node.data.agentConfigId === "string")
      existingByAgentConfigId.set(node.data.agentConfigId, node);
    if (typeof node.data.resourceId === "string")
      existingByResourceId.set(node.data.resourceId, node);
  }

  return {
    existingByAgentConfigId: existingByAgentConfigId,
    existingByResourceId: existingByResourceId,
    existingEdges: existingEdges,
    nextById: nextById,
  };
}

/** Next free slot in a resource kind's column. */
function nextColumnPosition(
  sync: ApiWiringSync,
  kind: keyof typeof API_WIRING_COLUMN_X,
): { x: number; y: number } {
  const position = { x: API_WIRING_COLUMN_X[kind], y: sync.rowY[kind] };
  sync.rowY[kind] += 132;

  return position;
}

/**
 * Persistence stage: merge desired wiring with what survives from the
 * existing layout, and drop anything left dangling.
 */
function reconcileApiWiring(sync: ApiWiringSync): {
  nextNodes: CanvasNode[];
  nextEdges: CanvasEdge[];
} {
  /** API-managed edge: both endpoints are API-owned nodes. */
  const isApiManagedEdge = (edge: CanvasEdge) =>
    sync.nextById.get(edge.source)?.data.managedBy === "api" &&
    sync.nextById.get(edge.target)?.data.managedBy === "api";
  // Stale API wiring is pruned; user-drawn edges and the wiring of agents
  // whose desired state is unknown this pass survive.
  const existingEdgeIds = new Set(sync.existingEdges.map((edge) => edge.id));
  const keptEdges = sync.existingEdges.filter(
    (edge) =>
      sync.desiredEdges.has(edge.id) ||
      !isApiManagedEdge(edge) ||
      sync.unresolvedAgentNodeIds.has(edge.source) ||
      sync.unresolvedAgentNodeIds.has(edge.target),
  );
  for (const edge of sync.desiredEdges.values()) {
    if (existingEdgeIds.has(edge.id)) continue;
    keptEdges.push(edge);
  }

  // Prune API-managed wiring nodes nothing references anymore: neither the
  // desired sets nor a surviving edge (an unresolved agent's wiring). Agent
  // nodes are owned by the create/remove back-sync, not by this wiring pass.
  const edgeEndpointIds = new Set(
    keptEdges.flatMap((edge) => [edge.source, edge.target]),
  );
  const nextNodes = [...sync.nextById.values()].filter(
    (node) =>
      node.type === "agent" ||
      node.data.managedBy !== "api" ||
      sync.desiredWiringNodeIds.has(node.id) ||
      edgeEndpointIds.has(node.id),
  );

  // Invariant: every persisted edge has two persisted endpoints — a pruned or
  // externally deleted node must take its edges with it.
  const nextNodeIds = new Set(nextNodes.map((node) => node.id));
  const nextEdges = keptEdges.filter(
    (edge) => nextNodeIds.has(edge.source) && nextNodeIds.has(edge.target),
  );

  return { nextNodes: nextNodes, nextEdges: nextEdges };
}

/** Resolves a sandbox ref into an adopted, materialized node id. */
async function resolveSandboxNode(
  sync: ApiWiringSync,
  sandboxRef: unknown,
  ownerAccountId: Id<"accounts">,
): Promise<string | null> {
  if (typeof sandboxRef !== "string" || !sandboxRef.trim()) {
    return null;
  }
  const normalized = sync.ctx.db.normalizeId("sandboxConfigs", sandboxRef);
  if (!normalized) {
    return null;
  }
  const row = await sync.ctx.db.get(normalized);
  if (!row || !(await adoptResourceRow(sync, row, ownerAccountId))) {
    return null;
  }
  const node = upsertWiringNode(
    sync,
    sync.existingByResourceId.get(row._id),
    `api-sandbox-${row._id}`,
    "sandbox",
    nextColumnPosition(sync, "sandbox"),
    {
      label: row.name,
      status: "idle",
      resourceId: row._id,
      mountName: row.name,
      description: row.description,
      managedBy: "api",
    },
  );
  sync.desiredWiringNodeIds.add(node.id);

  return node.id;
}

/** Skill names for one owning account, loaded once per pass. */
async function skillNamesForAccount(
  sync: ApiWiringSync,
  ownerAccountId: Id<"accounts">,
): Promise<Set<string>> {
  const cached = sync.skillNamesByAccount.get(ownerAccountId);
  if (cached) {
    return cached;
  }
  const names = new Set(
    (
      await sync.ctx.db
        .query("skills")
        .withIndex("by_accountId", (q) => q.eq("accountId", ownerAccountId))
        .collect()
    ).map((skill) => skill.name),
  );
  sync.skillNamesByAccount.set(ownerAccountId, names);

  return names;
}

/**
 * Stamp the resolved read-only state onto referenced workspace nodes; an
 * explicit `false` clears a stale flag once a writer exists.
 */
function stampWorkspaceReadOnly(sync: ApiWiringSync): void {
  for (const nodeId of sync.desiredWiringNodeIds) {
    const node = sync.nextById.get(nodeId);
    if (node?.type !== "workspace") continue;
    node.data = {
      ...node.data,
      readOnly:
        sync.workspaceReferenced.has(nodeId) &&
        !sync.workspaceHasWriter.has(nodeId),
    };
  }
}

/** Creates or refreshes a node in `sync.nextById`, keeping any existing position. */
function upsertWiringNode(
  sync: ApiWiringSync,
  preferred: CanvasNode | undefined,
  id: string,
  kind: CanvasNode["type"],
  position: { x: number; y: number },
  data: Record<string, unknown>,
): CanvasNode {
  const nodeId = preferred?.id ?? id;
  const existing = preferred ?? sync.nextById.get(nodeId);
  const node = {
    id: nodeId,
    type: kind,
    position: existing?.position ?? position,
    data: { ...existing?.data, ...data },
  };
  sync.nextById.set(nodeId, node);

  return node;
}

/**
 * Per-config wiring stage: resolve the agent row and its decrypted blob,
 * upsert the agent node, then materialize the sandbox/workspace/skill/
 * subagent wiring the blob declares. A config whose blob cannot be read is
 * marked unresolved so its existing wiring survives reconciliation.
 */
async function wireAgentConfig(
  sync: ApiWiringSync,
  config: Doc<"agentConfigs">,
): Promise<void> {
  const agentRowId = sync.ctx.db.normalizeId("agents", config.agentId!);
  const agent = agentRowId ? await sync.ctx.db.get(agentRowId) : null;
  const nested =
    agent?.encryptedConfig && agent.encryptionIv && agent.encryptionTag
      ? await decryptAgentConfigBlob(
          {
            ciphertext: agent.encryptedConfig,
            iv: agent.encryptionIv,
            tag: agent.encryptionTag,
          },
          sync.secret,
        )
      : null;
  if (!agent || !nested) {
    const agentNode = sync.existingByAgentConfigId.get(config._id);
    if (agentNode) sync.unresolvedAgentNodeIds.add(agentNode.id);

    return;
  }

  const agentNode = upsertWiringNode(
    sync,
    sync.existingByAgentConfigId.get(config._id),
    `api-agent-${config._id}`,
    "agent",
    { x: 80, y: 80 },
    {
      label: config.name,
      agentConfigId: config._id,
      managedBy: "api",
    },
  );
  sync.agentNodeByConfigId.set(config._id, agentNode.id);

  const defaultSandboxNodeId = await resolveSandboxNode(
    sync,
    nested.sandbox,
    agent.accountId,
  );
  if (defaultSandboxNodeId)
    addDefaultEdge(sync.desiredEdges, agentNode.id, defaultSandboxNodeId);

  if (Array.isArray(nested.workspaces)) {
    await wireAgentWorkspaces(sync, {
      agent: agent,
      agentNodeId: agentNode.id,
      workspaces: nested.workspaces,
      defaultSandboxNodeId: defaultSandboxNodeId,
    });
  }

  const skills = nested.skills;
  if (
    isPlainObject(skills) &&
    skills.enabled !== false &&
    Array.isArray(skills.allowed)
  ) {
    await wireAgentSkills(sync, {
      agent: agent,
      agentNodeId: agentNode.id,
      allowed: skills.allowed,
    });
  }

  const subagent = nested.subagent;
  if (isPlainObject(subagent) && Array.isArray(subagent.allowed)) {
    wireAgentSubagents(sync, {
      agentNodeId: agentNode.id,
      allowed: subagent.allowed,
    });
  }
}

/** Agent→skill wiring from `skills.allowed`, scoped to the owning account. */
async function wireAgentSkills(
  sync: ApiWiringSync,
  options: {
    agent: Doc<"agents">;
    agentNodeId: string;
    allowed: unknown[];
  },
): Promise<void> {
  const skillNames = await skillNamesForAccount(sync, options.agent.accountId);
  for (const entry of options.allowed) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    // Allowed refs are `<accountId>/<name>` paths; the node id carries the
    // owning account so same-named skills never alias across accounts.
    const name = entry.slice(entry.lastIndexOf("/") + 1).trim();
    if (!name || !skillNames.has(name)) continue;
    const skillNodeId = `api-skill-${options.agent.accountId}-${name}`;
    const skillNode = upsertWiringNode(
      sync,
      sync.nextById.get(skillNodeId),
      skillNodeId,
      "skill",
      nextColumnPosition(sync, "skill"),
      {
        label: name,
        status: "idle",
        resourceId: name,
        managedBy: "api",
      },
    );
    sync.desiredWiringNodeIds.add(skillNode.id);
    addDefaultEdge(sync.desiredEdges, options.agentNodeId, skillNode.id);
  }
}

/** Agent→agent edges from `subagent.allowed` toward other API configs in the stage. */
function wireAgentSubagents(
  sync: ApiWiringSync,
  options: {
    agentNodeId: string;
    allowed: unknown[];
  },
): void {
  for (const entry of options.allowed) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const callee = sync.configs.find((other) => other.agentId === entry);
    const calleeNodeId = callee
      ? (sync.agentNodeByConfigId.get(callee._id) ??
        sync.existingByAgentConfigId.get(callee._id)?.id)
      : undefined;
    if (calleeNodeId && calleeNodeId !== options.agentNodeId) {
      const id = `subagent:${options.agentNodeId}-right-${calleeNodeId}-left`;
      sync.desiredEdges.set(id, {
        id: id,
        source: options.agentNodeId,
        target: calleeNodeId,
        animated: false,
      });
    }
  }
}

/** Agent→workspace wiring from `workspaces`, including per-workspace sandbox overrides. */
async function wireAgentWorkspaces(
  sync: ApiWiringSync,
  options: {
    agent: Doc<"agents">;
    agentNodeId: string;
    workspaces: unknown[];
    defaultSandboxNodeId: string | null;
  },
): Promise<void> {
  for (const ref of options.workspaces) {
    if (!isPlainObject(ref) || typeof ref.workspaceId !== "string") continue;
    const normalized = sync.ctx.db.normalizeId(
      "workspaceConfigs",
      ref.workspaceId,
    );
    if (!normalized) continue;
    const row = await sync.ctx.db.get(normalized);
    if (!row || !(await adoptResourceRow(sync, row, options.agent.accountId)))
      continue;
    const workspaceNode = upsertWiringNode(
      sync,
      sync.existingByResourceId.get(row._id),
      `api-workspace-${row._id}`,
      "workspace",
      nextColumnPosition(sync, "workspace"),
      {
        label: row.name,
        status: "idle",
        resourceId: row._id,
        // The agent's ref name is the mount path the runtime uses; prefer
        // it over the row name so a canvas round-trip derives the same ref.
        mountName:
          typeof ref.name === "string" && ref.name.trim()
            ? ref.name.trim()
            : row.name,
        description: row.description,
        config: row.config,
        managedBy: "api",
      },
    );
    sync.desiredWiringNodeIds.add(workspaceNode.id);
    addDefaultEdge(sync.desiredEdges, options.agentNodeId, workspaceNode.id);
    sync.workspaceReferenced.add(workspaceNode.id);
    if (typeof ref.sandbox === "string") {
      // Per-workspace sandbox override → writable, drawn as a mount edge.
      // A ref that fails to resolve grants no writer: readOnly must never
      // claim writability without the mount edge that backs it.
      const overrideNodeId = await resolveSandboxNode(
        sync,
        ref.sandbox,
        options.agent.accountId,
      );
      if (overrideNodeId) {
        sync.workspaceHasWriter.add(workspaceNode.id);
        addMountEdge(sync.desiredEdges, workspaceNode.id, overrideNodeId);
      }
    } else if (ref.sandbox !== null && options.defaultSandboxNodeId) {
      // Omitted sandbox inherits the agent-level default (writable);
      // `null` explicitly forces read-only, so it stays a non-writer.
      sync.workspaceHasWriter.add(workspaceNode.id);
    }
  }
}

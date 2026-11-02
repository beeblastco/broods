import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { CanvasEdge, CanvasNode } from "./canvasShapes";
import { accountCipher, hasEncryptionSecret } from "./accountKeys";
import { applyTidyLayout } from "./canvasLayout";
import { loadMcpServersByNode } from "./mcp";
import { isPlainObject, stableJson } from "./objects";

type ExistingApiCanvas = {
  existingByAgentConfigId: Map<string, CanvasNode>;
  existingByResourceId: Map<string, CanvasNode>;
  existingEdges: CanvasEdge[];
  nextById: Map<string, CanvasNode>;
};

type ApiWiringSync = ExistingApiCanvas & {
  ctx: MutationCtx;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  configs: Doc<"agentConfigs">[];
  desiredEdges: Map<string, CanvasEdge>;
  desiredWiringNodeIds: Set<string>;
  workspaceReferenced: Set<string>;
  workspaceHasWriter: Set<string>;
  agentNodeByConfigId: Map<string, string>;
  /** Agents whose blob could not be read: desired wiring unknown, so existing wiring stays. */
  unresolvedAgentNodeIds: Set<string>;
};

export async function syncApiAgentCanvasWiring(
  ctx: MutationCtx,
  options: {
    projectId: Id<"projects">;
    stageId: Id<"stages">;
  },
): Promise<void> {
  const { projectId, stageId } = options;
  // No secret means no readable blob: leave the canvas, never prune what we cannot recompute.
  if (!hasEncryptionSecret()) {
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
    configs: configs,
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
  const nodes = applyTidyLayout(
    reconciled.nextNodes,
    reconciled.nextEdges,
    await loadMcpServersByNode(ctx, stageId),
  );
  if (
    stableJson(layout.nodes) === stableJson(nodes) &&
    stableJson(layout.edges) === stableJson(reconciled.nextEdges)
  ) {
    return;
  }

  await ctx.db.patch(layout._id, {
    nodes: nodes,
    edges: reconciled.nextEdges,
    updatedAt: Date.now(),
  });
}

// Edge ids follow the dashboard's schemes: it rebuilds handles from the id on load.
function addDefaultEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  target: string,
): void {
  const id = `xy-edge__${source}-${target}`;
  edges.set(id, { id: id, source: source, target: target });
}

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
  });
}

// An account-scoped API row joins the stage, or the next dashboard save rejects it.
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

function reconcileApiWiring(sync: ApiWiringSync): {
  nextNodes: CanvasNode[];
  nextEdges: CanvasEdge[];
} {
  const isApiManagedEdge = (edge: CanvasEdge): boolean =>
    sync.nextById.get(edge.source)?.data.managedBy === "api" &&
    sync.nextById.get(edge.target)?.data.managedBy === "api";
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

  // Agent nodes belong to the create/remove back-sync, not to this wiring pass.
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

  const nextNodeIds = new Set(nextNodes.map((node) => node.id));
  const nextEdges = keptEdges.filter(
    (edge) => nextNodeIds.has(edge.source) && nextNodeIds.has(edge.target),
  );

  return { nextNodes: nextNodes, nextEdges: nextEdges };
}

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

function upsertWiringNode(
  sync: ApiWiringSync,
  preferred: CanvasNode | undefined,
  id: string,
  kind: CanvasNode["type"],
  data: Record<string, unknown>,
): CanvasNode {
  const nodeId = preferred?.id ?? id;
  const existing = preferred ?? sync.nextById.get(nodeId);
  const node = {
    id: nodeId,
    type: kind,
    // Placeholder: the tidy pass in syncApiAgentCanvasWiring assigns every position.
    position: { x: 0, y: 0 },
    data: { ...existing?.data, ...data },
  };
  sync.nextById.set(nodeId, node);

  return node;
}

async function wireAgentConfig(
  sync: ApiWiringSync,
  config: Doc<"agentConfigs">,
): Promise<void> {
  const agentRowId = sync.ctx.db.normalizeId("agents", config.agentId!);
  const agent = agentRowId ? await sync.ctx.db.get(agentRowId) : null;
  const nested =
    agent?.encryptedConfig && agent.encryptionIv && agent.encryptionTag
      ? await (
          await accountCipher(sync.ctx, agent.accountId)
        ).decrypt("agents:encryptedConfig", {
          ciphertext: agent.encryptedConfig,
          iv: agent.encryptionIv,
          tag: agent.encryptionTag,
        })
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
    {
      label: config.name,
      agentConfigId: config._id,
      managedBy: "api",
    },
  );
  sync.agentNodeByConfigId.set(config._id, agentNode.id);

  const sandboxes: unknown[] = Array.isArray(nested.sandboxes)
    ? nested.sandboxes
    : [];
  const sandboxOrder: string[] = [];
  let defaultSandboxNodeId: string | null = null;
  for (const [index, sandbox] of sandboxes.entries()) {
    const sandboxNodeId = await resolveSandboxNode(
      sync,
      sandbox,
      agent.accountId,
    );
    if (index === 0) defaultSandboxNodeId = sandboxNodeId;
    if (!sandboxNodeId || sandboxOrder.includes(sandboxNodeId)) continue;
    addDefaultEdge(sync.desiredEdges, agentNode.id, sandboxNodeId);
    sandboxOrder.push(sandboxNodeId);
  }
  agentNode.data = { ...agentNode.data, sandboxOrder: sandboxOrder };

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
    wireAgentSkills(sync, {
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

function wireAgentSkills(
  sync: ApiWiringSync,
  options: {
    agent: Doc<"agents">;
    agentNodeId: string;
    allowed: unknown[];
  },
): void {
  for (const entry of options.allowed) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    // Refs are `<accountId>/<name>`; the node id keeps the account so names never alias.
    const name = entry.slice(entry.lastIndexOf("/") + 1).trim();
    // Skills live in S3, which a mutation cannot list, so the ref is trusted.
    if (!name) continue;
    const skillNodeId = `api-skill-${options.agent.accountId}-${name}`;
    const skillNode = upsertWiringNode(
      sync,
      sync.nextById.get(skillNodeId),
      skillNodeId,
      "skill",
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
      });
    }
  }
}

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
      {
        label: row.name,
        status: "idle",
        resourceId: row._id,
        // The ref name is the runtime mount path; a canvas round-trip must derive the same ref.
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
      // An omitted sandbox inherits the agent's default (writable); `null` forces read-only.
      sync.workspaceHasWriter.add(workspaceNode.id);
    }
  }
}

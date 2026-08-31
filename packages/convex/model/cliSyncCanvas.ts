/**
 * Canvas layout sync for CLI-managed resources: materializes one node per
 * manifest resource, draws agent→service / mount / subagent edges from the
 * declared refs, stamps workspace read-only badges, and persists the merged
 * layout without touching dashboard-managed nodes or edges.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { CanvasEdge, CanvasNode } from "../canvas";
import {
  authIdForAccount,
  resourceName,
  snapshotExternalConfig,
  type CliResource,
} from "./cliSync";
import { isPlainObject } from "./objects";
import { sandboxDisplayConfig } from "./sandboxDisplayConfig";

type CanvasCliResource = CliResource & {
  kind: "agent" | "workspace" | "sandbox" | "skill" | "mcp";
};

type ExistingCanvas = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  byAgentConfigId: Map<string, CanvasNode>;
  byResourceId: Map<string, CanvasNode>;
  byId: Map<string, CanvasNode>;
};

type MaterializedCanvasNodes = {
  nextById: Map<string, CanvasNode>;
  nodeIdByKindName: Map<string, string>;
  mcpNodeIds: Map<Id<"mcp">, string>;
};

type WorkspaceWriterState = {
  referenced: Set<string>;
  writers: Set<string>;
};

export function canvasNodeId(kind: string, name: string): string {
  return `cli-${kind}-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "resource"
  }`;
}

export async function syncCanvasLayoutForManifest(
  ctx: MutationCtx,
  options: {
    account: Doc<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    resources: CliResource[];
    workspaceIds: Record<string, string>;
    sandboxIds: Record<string, string>;
  },
): Promise<void> {
  const { account, projectId, stageId, resources, workspaceIds, sandboxIds } =
    options;
  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .unique();
  const existing = indexExistingCanvas(layout);

  const agentConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const agentConfigByName = new Map(
    agentConfigs.map((entry) => [entry.name, entry]),
  );
  // Servers resolve by name here: the manifest reaching this mutation already
  // had `config.mcp` keys rewritten to ids, so the node needs the row
  // to map back.
  const mcpByName = new Map(
    (
      await ctx.db
        .query("mcp")
        .withIndex("by_stageId_and_status", (q) =>
          q.eq("stageId", stageId).eq("status", "active"),
        )
        .collect()
    ).map((entry) => [entry.name, entry]),
  );
  const mcpNameById = new Map(
    [...mcpByName.values()].map((entry) => [entry._id as string, entry.name]),
  );
  const desiredResources: CanvasCliResource[] = resources
    .filter(
      (entry): entry is CanvasCliResource =>
        entry.kind === "agent" ||
        entry.kind === "workspace" ||
        entry.kind === "sandbox" ||
        entry.kind === "skill" ||
        entry.kind === "mcp",
    )
    .map((entry) => ({ ...entry, name: resourceName(entry.name) }));
  const desiredNodeKeys = new Set(
    desiredResources.map((entry) => `${entry.kind}:${entry.name}`),
  );

  const materialized = materializeCanvasNodes({
    existing: existing,
    agentConfigByName: agentConfigByName,
    mcpByName: mcpByName,
    desiredResources: desiredResources,
    workspaceIds: workspaceIds,
    sandboxIds: sandboxIds,
  });

  // Point each mcp row at the node the CLI just drew for it. The panel
  // resolves through `getByNode` (`by_stageId_and_nodeId`), so without this a
  // CLI-defined server would be invisible on the canvas.
  for (const [serverId, nodeId] of materialized.mcpNodeIds) {
    await ctx.db.patch(serverId, { nodeId: nodeId });
  }

  const desiredEdges = new Map<string, CanvasEdge>();
  const workspaceWriters = collectDesiredAgentEdges({
    desiredResources: desiredResources,
    nodeIdByKindName: materialized.nodeIdByKindName,
    mcpNameById: mcpNameById,
    desiredEdges: desiredEdges,
  });
  stampWorkspaceReadOnly(
    materialized.nodeIdByKindName,
    materialized.nextById,
    workspaceWriters,
  );

  const nextEdges = mergeCanvasEdges(
    existing.edges,
    desiredEdges,
    materialized.nextById,
  );
  const nextNodes = filterDesiredCanvasNodes(
    materialized.nextById,
    desiredNodeKeys,
  );
  await persistCanvasLayout(ctx, {
    account: account,
    projectId: projectId,
    stageId: stageId,
    layout: layout,
    nextNodes: nextNodes,
    nextEdges: nextEdges,
  });
}

/** Agent→skill edges from `skills.allowed` (bare names or account/name paths). */
function addAgentSkillEdges(
  agentConfig: Record<string, unknown>,
  agentNodeId: string,
  nodeIdByKindName: Map<string, string>,
  desiredEdges: Map<string, CanvasEdge>,
): void {
  const skills = agentConfig.skills;
  if (!isPlainObject(skills) || !Array.isArray(skills.allowed)) return;
  for (const entry of skills.allowed) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const skillNodeId = skillNodeIdForReference(nodeIdByKindName, entry);
    if (skillNodeId)
      addDesiredDefaultEdge(desiredEdges, agentNodeId, skillNodeId);
  }
}

/**
 * Subagent (agent→agent) edges from `subagent.allowed`. The dashboard
 * reconstructs handles + type from the `subagent:` id prefix on load, so the
 * CLI only persists id/source/target — the same way mount edges work.
 */
function addAgentSubagentEdges(
  agentConfig: Record<string, unknown>,
  agentNodeId: string,
  nodeIdByKindName: Map<string, string>,
  desiredEdges: Map<string, CanvasEdge>,
): void {
  const subagent = agentConfig.subagent;
  if (!isPlainObject(subagent) || !Array.isArray(subagent.allowed)) return;
  for (const entry of subagent.allowed) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const calleeNodeId = nodeIdByKindName.get(`agent:${resourceName(entry)}`);
    if (calleeNodeId && calleeNodeId !== agentNodeId) {
      addDesiredSubagentEdge(desiredEdges, agentNodeId, calleeNodeId);
    }
  }
}

/** Agent→mcp edges. `config.mcp` is keyed by server row id. */
function addAgentMcpEdges(
  agentConfig: Record<string, unknown>,
  agentNodeId: string,
  nodeIdByKindName: Map<string, string>,
  mcpNameById: Map<string, string>,
  desiredEdges: Map<string, CanvasEdge>,
): void {
  const mcp = agentConfig.mcp;
  if (!isPlainObject(mcp)) return;
  for (const [serverId, serverConfig] of Object.entries(mcp)) {
    const name = mcpNameById.get(serverId);
    if (!name) continue;
    if (isPlainObject(serverConfig) && serverConfig.enabled === false) continue;
    const mcpNodeId = nodeIdByKindName.get(`mcp:${name}`);
    if (mcpNodeId) addDesiredDefaultEdge(desiredEdges, agentNodeId, mcpNodeId);
  }
}

/**
 * Agent→workspace edges plus each workspace's writability tracking: a string
 * sandbox override or an inherited agent-level sandbox marks a writer, while an
 * explicit `sandbox: null` keeps the workspace read-only.
 */
function addAgentWorkspaceEdges(options: {
  agentConfig: Record<string, unknown>;
  agentNodeId: string;
  agentSandboxName: string | null;
  nodeIdByKindName: Map<string, string>;
  desiredEdges: Map<string, CanvasEdge>;
  workspaceWriters: WorkspaceWriterState;
}): void {
  const {
    agentConfig,
    agentNodeId,
    agentSandboxName,
    nodeIdByKindName,
    desiredEdges,
    workspaceWriters,
  } = options;
  if (!Array.isArray(agentConfig.workspaces)) return;
  for (const workspaceRef of agentConfig.workspaces) {
    if (
      !isPlainObject(workspaceRef) ||
      typeof workspaceRef.workspaceId !== "string"
    )
      continue;
    const workspaceName = resourceName(workspaceRef.workspaceId);
    const workspaceNodeId = nodeIdByKindName.get(`workspace:${workspaceName}`);
    if (!workspaceNodeId) continue;
    addDesiredDefaultEdge(desiredEdges, agentNodeId, workspaceNodeId);
    workspaceWriters.referenced.add(workspaceNodeId);
    if (typeof workspaceRef.sandbox === "string") {
      // Per-workspace sandbox override → writable, drawn as a mount edge.
      workspaceWriters.writers.add(workspaceNodeId);
      const sandboxNodeId = nodeIdByKindName.get(
        `sandbox:${resourceName(workspaceRef.sandbox)}`,
      );
      if (sandboxNodeId)
        addDesiredMountEdge(
          desiredEdges,
          workspaceNodeId,
          "left",
          sandboxNodeId,
          "right",
        );
    } else if (workspaceRef.sandbox !== null && agentSandboxName) {
      // Omitted sandbox inherits the agent-level default (writable).
      // `null` explicitly forces read-only, so it stays a non-writer.
      workspaceWriters.writers.add(workspaceNodeId);
    }
  }
}

/**
 * Default agent→service edge (agent→sandbox, agent→workspace): top/bottom handles,
 * rendered by the dashboard's DeletableEdge. `animated: true` gives the flowing
 * dashed look the dashboard uses for these connections.
 */
function addDesiredDefaultEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  target: string,
): void {
  const id = `xy-edge__${source}-${target}`;
  edges.set(id, { id: id, source: source, target: target, animated: true });
}

/**
 * Side-handle "mount" edge for a workspace↔sandbox relationship, matching the
 * dashboard's id scheme so it renders as the dotted MountEdge. The handles are
 * encoded in the id because the persisted edge keeps only id/source/target.
 */
function addDesiredMountEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): void {
  const id = `mount:${source}-${sourceHandle}-${target}-${targetHandle}`;
  edges.set(id, { id: id, source: source, target: target, animated: false });
}

/**
 * Side-handle "subagent" edge for an agent→agent call relationship. Matches the
 * dashboard's id scheme so it hydrates into the violet SubagentEdge; as with mount
 * edges only id/source/target are persisted and the handles/type are rebuilt from
 * the `subagent:` prefix on load. Source/target are the caller/callee agent nodes.
 */
function addDesiredSubagentEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  target: string,
): void {
  const id = `subagent:${source}-right-${target}-left`;
  edges.set(id, { id: id, source: source, target: target, animated: false });
}

function cliResourceKeyForNode(node: CanvasNode): string {
  const name =
    typeof node.data.label === "string" && node.data.label.trim()
      ? node.data.label.trim()
      : node.id.replace(/^cli-[^-]+-/, "");

  return `${node.type}:${name}`;
}

/**
 * Walk each desired agent's refs (sandbox, workspaces, subagents, skills,
 * mcp servers) and record the corresponding canvas edges plus workspace
 * writability.
 */
function collectDesiredAgentEdges(options: {
  desiredResources: CanvasCliResource[];
  nodeIdByKindName: Map<string, string>;
  mcpNameById: Map<string, string>;
  desiredEdges: Map<string, CanvasEdge>;
}): WorkspaceWriterState {
  const { desiredResources, nodeIdByKindName, mcpNameById, desiredEdges } =
    options;
  const workspaceWriters: WorkspaceWriterState = {
    referenced: new Set<string>(),
    writers: new Set<string>(),
  };

  for (const agent of desiredResources.filter(
    (entry) => entry.kind === "agent",
  )) {
    const agentId = nodeIdByKindName.get(`agent:${agent.name}`);
    if (!agentId || !isPlainObject(agent.config)) continue;
    // Agent→service edges are default (top/bottom handle) edges, like the
    // dashboard's own auto-connect. Only workspace↔sandbox uses a side-handle
    // mount edge (sandbox x=420 sits left of workspace x=760).
    const agentSandboxName =
      typeof agent.config.sandbox === "string"
        ? resourceName(agent.config.sandbox)
        : null;
    if (agentSandboxName) {
      const sandboxNodeId = nodeIdByKindName.get(`sandbox:${agentSandboxName}`);
      if (sandboxNodeId)
        addDesiredDefaultEdge(desiredEdges, agentId, sandboxNodeId);
    }
    addAgentWorkspaceEdges({
      agentConfig: agent.config,
      agentNodeId: agentId,
      agentSandboxName: agentSandboxName,
      nodeIdByKindName: nodeIdByKindName,
      desiredEdges: desiredEdges,
      workspaceWriters: workspaceWriters,
    });
    addAgentSubagentEdges(
      agent.config,
      agentId,
      nodeIdByKindName,
      desiredEdges,
    );
    addAgentSkillEdges(agent.config, agentId, nodeIdByKindName, desiredEdges);
    addAgentMcpEdges(
      agent.config,
      agentId,
      nodeIdByKindName,
      mcpNameById,
      desiredEdges,
    );
  }

  return workspaceWriters;
}

function edgeIsCliManaged(
  edge: CanvasEdge,
  nodesById: Map<string, CanvasNode>,
): boolean {
  if (
    edge.id.startsWith("xy-edge__cli-") ||
    edge.id.startsWith("mount:cli-") ||
    edge.id.startsWith("subagent:cli-")
  ) {
    return true;
  }
  const sourceManagedBy = nodesById.get(edge.source)?.data.managedBy;
  const targetManagedBy = nodesById.get(edge.target)?.data.managedBy;

  return sourceManagedBy === "cli" && targetManagedBy === "cli";
}

/** Keep every non-CLI node; drop CLI nodes whose resource left the manifest. */
function filterDesiredCanvasNodes(
  nextById: Map<string, CanvasNode>,
  desiredNodeKeys: Set<string>,
): CanvasNode[] {
  return [...nextById.values()].filter((node) => {
    const key =
      typeof node.data.cliResourceKey === "string"
        ? node.data.cliResourceKey
        : null;
    if (key) return desiredNodeKeys.has(key);
    if (node.id.startsWith("cli-"))
      return desiredNodeKeys.has(cliResourceKeyForNode(node));

    return true;
  });
}

/** Normalize the stored layout and index its nodes by id and back-references. */
function indexExistingCanvas(
  layout: Doc<"canvasLayouts"> | null,
): ExistingCanvas {
  const nodes = ((layout?.nodes ?? []) as CanvasNode[]).map(
    normalizeCanvasNode,
  );
  const edges = ((layout?.edges ?? []) as CanvasEdge[]).map(
    normalizeCanvasEdge,
  );
  const byAgentConfigId = new Map<string, CanvasNode>();
  const byResourceId = new Map<string, CanvasNode>();
  const byId = new Map<string, CanvasNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
    const data = isPlainObject(node.data) ? node.data : {};
    if (typeof data.agentConfigId === "string")
      byAgentConfigId.set(data.agentConfigId, node);
    if (typeof data.resourceId === "string")
      byResourceId.set(data.resourceId, node);
  }

  return {
    nodes: nodes,
    edges: edges,
    byAgentConfigId: byAgentConfigId,
    byResourceId: byResourceId,
    byId: byId,
  };
}

/**
 * Upsert one canvas node per desired resource, column-laid-out by kind, keeping
 * an existing node's id and position when the resource already had one.
 */
function materializeCanvasNodes(options: {
  existing: ExistingCanvas;
  agentConfigByName: Map<string, Doc<"agentConfigs">>;
  mcpByName: Map<string, Doc<"mcp">>;
  desiredResources: CanvasCliResource[];
  workspaceIds: Record<string, string>;
  sandboxIds: Record<string, string>;
}): MaterializedCanvasNodes {
  const {
    existing,
    agentConfigByName,
    mcpByName,
    desiredResources,
    workspaceIds,
    sandboxIds,
  } = options;
  const nextById = new Map(existing.nodes.map((node) => [node.id, node]));
  const nodeIdByKindName = new Map<string, string>();
  const mcpNodeIds = new Map<Id<"mcp">, string>();
  const columnX = {
    agent: 80,
    sandbox: 340,
    workspace: 600,
    skill: 860,
    mcp: 1120,
  } as const;
  const rowY = {
    agent: 80,
    sandbox: 80,
    workspace: 80,
    skill: 80,
    mcp: 80,
  };
  const nextPosition = (
    kind: keyof typeof columnX,
  ): { x: number; y: number } => {
    const position = { x: columnX[kind], y: rowY[kind] };
    rowY[kind] += 132;

    return position;
  };

  const ordered = [...desiredResources].sort((a, b) => {
    const rank = {
      agent: 0,
      sandbox: 1,
      workspace: 2,
      skill: 3,
      mcp: 4,
    } as const;

    return rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name);
  });
  ordered.forEach((resource) => {
    if (resource.kind === "agent") {
      const config = agentConfigByName.get(resource.name);
      if (!config) return;
      const node = upsertCanvasNode({
        nextById: nextById,
        existingById: existing.byId,
        preferred: existing.byAgentConfigId.get(config._id),
        kind: "agent",
        name: resource.name,
        position: nextPosition("agent"),
        data: {
          label: resource.name,
          status: "idle",
          agentConfigId: config._id,
          managedBy: "cli",
          cliResourceKey: `agent:${resource.name}`,
        },
      });
      nodeIdByKindName.set(`agent:${resource.name}`, node.id);

      return;
    }

    if (resource.kind === "skill") {
      const configSnapshot = snapshotExternalConfig(resource.config);
      const node = upsertCanvasNode({
        nextById: nextById,
        existingById: existing.byId,
        preferred: existing.byId.get(canvasNodeId("skill", resource.name)),
        kind: "skill",
        name: resource.name,
        position: nextPosition("skill"),
        data: {
          label: resource.name,
          status: "idle",
          resourceId: resource.name,
          description: resource.description,
          config: {
            skillSource: "files",
            ...(isPlainObject(configSnapshot) ? configSnapshot : {}),
          },
          managedBy: "cli",
          cliResourceKey: `skill:${resource.name}`,
        },
      });
      nodeIdByKindName.set(`skill:${resource.name}`, node.id);

      return;
    }

    if (resource.kind === "mcp") {
      const record = mcpByName.get(resource.name);
      if (!record) return;
      const node = upsertCanvasNode({
        nextById: nextById,
        existingById: existing.byId,
        preferred: existing.byResourceId.get(record._id),
        kind: "mcp",
        name: resource.name,
        position: nextPosition("mcp"),
        data: {
          label: resource.name,
          status: "idle",
          resourceId: record._id,
          description: record.description,
          config: {
            transport: record.transport,
            ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
          },
          managedBy: "cli",
          cliResourceKey: `mcp:${resource.name}`,
        },
      });
      nodeIdByKindName.set(`mcp:${resource.name}`, node.id);
      if (record.nodeId !== node.id) mcpNodeIds.set(record._id, node.id);

      return;
    }

    const resourceId =
      resource.kind === "workspace"
        ? workspaceIds[resource.name]
        : sandboxIds[resource.name];
    if (!resourceId) return;
    const node = upsertCanvasNode({
      nextById: nextById,
      existingById: existing.byId,
      preferred: existing.byResourceId.get(resourceId),
      kind: resource.kind,
      name: resource.name,
      position: nextPosition(resource.kind),
      data: {
        label: resource.name,
        status: "idle",
        resourceId: resourceId,
        mountName: resource.name,
        description: resource.description,
        // A sandbox config carries envVars and provider options; the layout is
        // UI state the dashboard reads back, so only display keys go in.
        config:
          resource.kind === "sandbox"
            ? sandboxDisplayConfig(resource.config)
            : resource.config,
        managedBy: "cli",
        cliResourceKey: `${resource.kind}:${resource.name}`,
      },
    });
    nodeIdByKindName.set(`${resource.kind}:${resource.name}`, node.id);
  });

  return {
    nextById: nextById,
    nodeIdByKindName: nodeIdByKindName,
    mcpNodeIds: mcpNodeIds,
  };
}

/** Keep non-CLI edges, drop stale CLI edges, and append the newly desired ones. */
function mergeCanvasEdges(
  existingEdges: CanvasEdge[],
  desiredEdges: Map<string, CanvasEdge>,
  nextById: Map<string, CanvasNode>,
): CanvasEdge[] {
  const existingEdgeIds = new Set(existingEdges.map((edge) => edge.id));
  const nextEdges = existingEdges.filter(
    (edge) => desiredEdges.has(edge.id) || !edgeIsCliManaged(edge, nextById),
  );
  for (const edge of desiredEdges.values()) {
    if (existingEdgeIds.has(edge.id)) continue;
    nextEdges.push(edge);
  }

  return nextEdges;
}

function normalizeCanvasEdge(edge: CanvasEdge): CanvasEdge {
  return {
    id: String(edge.id),
    source: String(edge.source),
    target: String(edge.target),
    animated: edge.animated,
  };
}

function normalizeCanvasNode(node: CanvasNode): CanvasNode {
  return {
    id: String(node.id),
    type: node.type,
    position: node.position ?? { x: 0, y: 0 },
    data: isPlainObject(node.data) ? node.data : {},
  };
}

/** Patch the existing layout row, or insert one when nodes exist and none does. */
async function persistCanvasLayout(
  ctx: MutationCtx,
  options: {
    account: Doc<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    layout: Doc<"canvasLayouts"> | null;
    nextNodes: CanvasNode[];
    nextEdges: CanvasEdge[];
  },
): Promise<void> {
  const now = Date.now();
  if (options.layout) {
    await ctx.db.patch(options.layout._id, {
      nodes: options.nextNodes,
      edges: options.nextEdges,
      updatedAt: now,
    });
  } else if (options.nextNodes.length > 0) {
    const authId = await authIdForAccount(ctx, options.account);
    if (!authId) throw new Error("Account org owner not found");
    await ctx.db.insert("canvasLayouts", {
      authId: authId,
      projectId: options.projectId,
      stageId: options.stageId,
      nodes: options.nextNodes,
      edges: options.nextEdges,
      updatedAt: now,
    });
  }
}

function skillNodeIdForReference(
  nodeIdByKindName: Map<string, string>,
  value: string,
): string | undefined {
  const direct = nodeIdByKindName.get(`skill:${resourceName(value)}`);
  if (direct) return direct;

  const slashIndex = value.lastIndexOf("/");
  if (slashIndex < 0) return undefined;
  const localName = value.slice(slashIndex + 1);

  return localName.trim()
    ? nodeIdByKindName.get(`skill:${resourceName(localName)}`)
    : undefined;
}

/**
 * Stamp the resolved read-only state onto each workspace node already in
 * `nextById`. An explicit `false` clears a stale flag once a writer exists.
 */
function stampWorkspaceReadOnly(
  nodeIdByKindName: Map<string, string>,
  nextById: Map<string, CanvasNode>,
  workspaceWriters: WorkspaceWriterState,
): void {
  for (const [key, nodeId] of nodeIdByKindName) {
    if (!key.startsWith("workspace:")) continue;
    const node = nextById.get(nodeId);
    if (!node) continue;
    node.data = {
      ...node.data,
      readOnly:
        workspaceWriters.referenced.has(nodeId) &&
        !workspaceWriters.writers.has(nodeId),
    };
  }
}

function upsertCanvasNode(options: {
  nextById: Map<string, CanvasNode>;
  existingById: Map<string, CanvasNode>;
  preferred: CanvasNode | undefined;
  kind: CanvasNode["type"];
  name: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}): CanvasNode {
  const { nextById, existingById, preferred, kind, name, position, data } =
    options;
  const id = preferred?.id ?? canvasNodeId(kind, name);
  const existing = preferred ?? existingById.get(id);
  const node = {
    id: id,
    type: kind,
    position: existing?.position ?? position,
    data: {
      ...(isPlainObject(existing?.data) ? existing.data : {}),
      ...data,
    },
  };
  nextById.set(id, node);

  return node;
}

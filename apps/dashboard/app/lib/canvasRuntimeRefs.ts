/**
 * Derives broods AgentConfig sandbox/workspace references from canvas
 * runtime-resource nodes and edges.
 */
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import type { Id } from "@broods/convex/_generated/dataModel";
import { findLaterSandboxMount } from "@broods/convex/model/agentRules";
import {
  agentRefCounts,
  agentSandboxOrder,
  workspaceSandboxIds,
} from "@broods/convex/model/canvasFrames";
import type { Edge, Node } from "@xyflow/react";

/** Canvas node types that participate in broods runtime reference projection. */
export type RuntimeNodeType = "agent" | "workspace" | "sandbox";

/** A single broods AgentWorkspaceRef emitted from the canvas graph. */
export type WorkspaceRef = {
  name: string;
  workspaceId: string;
  sandbox?: string | null;
};

/** Runtime reference patch for one agent config. */
export type AgentRuntimeRefs = {
  configId: Id<"agentConfigs">;
  /** Sandbox resource ids in `sandboxes` order; the first is the default. */
  sandboxes: string[];
  workspaces: WorkspaceRef[];
};

/**
 * Effective-sandbox state for a workspace, resolved from the broods cascade
 * `ws.sandbox (override) ?? config.sandboxes[0] (inherited) ?? none (read-only)`.
 * Inherited names every distinct default of the agents wired to it.
 */
export type WorkspaceSandboxState =
  | { kind: "override"; sandboxLabels: string[] }
  | { kind: "inherited"; sandboxLabels: string[] }
  | { kind: "readonly" };

/** Per-node infra annotations derived from the canvas graph for badge rendering. */
export type CanvasInfraAnalysis = {
  /** Workspace node id → its resolved effective-sandbox state. */
  workspaceStates: Record<string, WorkspaceSandboxState>;
  /** Workspace/sandbox node id → number of distinct agents that reference it. */
  agentRefCounts: Record<string, number>;
  /** Node id → whether an agent is reachable from it (drives the unwired badge). */
  connectedToAgent: Record<string, boolean>;
};

/** A dashboard agent whose drawn refs the config API would refuse. */
export type RuntimeRefsProblem = {
  agentId: string;
  /** Resource id of the sandbox the workspace is mounted on, not the agent's first. */
  sandboxId: string;
  sandboxLabel: string;
  workspaceId: string;
  workspaceName: string;
};

/** A caller agent's subagent (agent→agent) call targets derived from the canvas graph. */
export type AgentSubagentRefs = {
  /** Caller agent's config id. */
  configId: Id<"agentConfigs">;
  /** Config ids of the agents this one may call (one per outgoing `subagent` edge). */
  calleeConfigIds: Id<"agentConfigs">[];
};

type RuntimeNode = Node<BaseNodeData> & { type?: string };

// A config id is cached only once its write lands: caching before the await
// marked a failed write as persisted, so the next save skipped it.
export async function writeChangedRefs<
  Ref extends { configId: Id<"agentConfigs"> },
>(
  refs: Ref[],
  cache: Map<string, string>,
  serialize: (ref: Ref) => string,
  write: (ref: Ref) => Promise<unknown>,
): Promise<void> {
  const writes = refs.map(async (ref) => {
    const serialized = serialize(ref);
    if (cache.get(ref.configId) === serialized) return;

    await write(ref);
    cache.set(ref.configId, serialized);
  });

  // allSettled, not all: `all` reports the first failure while the rest are
  // still in flight, so the caller sees an error over a half-updated cache.
  const results = await Promise.allSettled(writes);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function defaultRuntimeNodeData(
  type: string,
  label: string,
  id: string,
): BaseNodeData {
  if (type === "workspace") {
    return {
      label: label,
      status: "idle",
      resourceId: `ws_${id}`,
      mountName: normalizeWorkspaceName(label) || `workspace_${id}`,
      config: { storage: { provider: "s3" } },
    };
  }

  if (type === "sandbox") {
    return {
      label: label,
      status: "idle",
      resourceId: `sb_${id}`,
      config: { provider: "sandbox", permissionMode: "ask" },
    };
  }

  return { label: label, status: "idle" };
}

/**
 * Analyze the canvas graph once to drive per-node infra badges: each workspace's
 * effective-sandbox state (override/inherited/read-only) and how many agents share
 * each workspace/sandbox.
 */
export function analyzeCanvasInfra(
  nodes: Node[],
  edges: Edge[],
): CanvasInfraAnalysis {
  const runtimeNodes = nodes as RuntimeNode[];
  const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(edges);
  const labelsOf = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => {
      const node = byId.get(id);

      return node ? [nodeLabel(node)] : [];
    });
  const workspaceStates: Record<string, WorkspaceSandboxState> = {};
  for (const [id, state] of workspaceSandboxIds(runtimeNodes, edges)) {
    workspaceStates[id] =
      state.kind === "readonly"
        ? state
        : { kind: state.kind, sandboxLabels: labelsOf(state.sandboxIds) };
  }

  return {
    workspaceStates: workspaceStates,
    agentRefCounts: Object.fromEntries(agentRefCounts(runtimeNodes, edges)),
    connectedToAgent: resolveAgentReachability(runtimeNodes, adjacency),
  };
}

export function deriveAgentRuntimeRefs(
  nodes: Node[],
  edges: Edge[],
): AgentRuntimeRefs[] {
  const runtimeNodes = nodes as RuntimeNode[];
  const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(edges);
  const agents = runtimeNodes.filter((node) => node.type === "agent");

  return agents.flatMap((agent) => {
    const agentConfigId = agent.data.agentConfigId as
      | Id<"agentConfigs">
      | undefined;
    if (!agentConfigId) {
      return [];
    }

    // An agent's resources come from its DIRECT edges (explicit model): the sandboxes it
    // points at, in its stored order, are its sandboxes; the workspaces it points at are
    // its workspaces. Workspaces are not inferred transitively through a shared sandbox.
    const directNodes = neighbors(agent.id, adjacency)
      .map((nodeId) => byId.get(nodeId))
      .filter((node): node is RuntimeNode => !!node);
    const sandboxes = agentSandboxOrder(agent, runtimeNodes, edges)
      .map((nodeId) => byId.get(nodeId))
      .filter((node): node is RuntimeNode => !!node)
      .map((node) => resourceIdFor(node, "sandbox"))
      .filter((value): value is string => !!value);
    const workspaceNodes = directNodes.filter(
      (node) => node.type === "workspace",
    );

    const usedNames = new Set<string>();
    const workspaces: WorkspaceRef[] = [];
    for (const workspaceNode of workspaceNodes) {
      const workspaceId = resourceIdFor(workspaceNode, "workspace");
      if (!workspaceId) continue;

      const baseName =
        normalizeWorkspaceName(
          workspaceNode.data.mountName ?? workspaceNode.data.label,
        ) || `workspace_${workspaceNode.id}`;
      const linkedSandboxes = neighbors(workspaceNode.id, adjacency)
        .map((nodeId) => byId.get(nodeId))
        .filter((node): node is RuntimeNode => node?.type === "sandbox");

      // No mount edge means inherit the agent's default sandbox. `readOnly` is
      // the only way the graph can ask for `sandbox: null` instead, which reads
      // the workspace straight from S3 and mounts it nowhere.
      if (linkedSandboxes.length === 0) {
        const name = uniqueWorkspaceName(baseName, usedNames);
        workspaces.push(
          workspaceNode.data.readOnly === true
            ? { name: name, sandbox: null, workspaceId: workspaceId }
            : { name: name, workspaceId: workspaceId },
        );
        continue;
      }

      linkedSandboxes.forEach((sandboxNode, index) => {
        const sandboxId = resourceIdFor(sandboxNode, "sandbox");
        if (!sandboxId) return;
        const suffix = normalizeWorkspaceName(
          sandboxNode.data.mountName ?? sandboxNode.data.label,
        );
        const name =
          index === 0
            ? baseName
            : `${baseName}-${suffix || `sandbox_${index + 1}`}`;
        workspaces.push({
          name: uniqueWorkspaceName(name, usedNames),
          workspaceId: workspaceId,
          sandbox: sandboxId,
        });
      });
    }

    return [
      {
        configId: agentConfigId,
        sandboxes: sandboxes,
        workspaces: workspaces,
      },
    ];
  });
}

/**
 * Dashboard agents whose derived refs `updateRuntimeRefs` would refuse, by the
 * same rule it applies: only the first sandbox backs a workspace. The canvas
 * checks an edit with this before it saves. Code-managed agents are skipped,
 * as the mutation leaves their refs alone.
 */
export function runtimeRefsProblems(
  nodes: Node[],
  edges: Edge[],
): RuntimeRefsProblem[] {
  const agentsByConfig = new Map(
    nodes
      .filter((node) => node.type === "agent")
      .map((node) => [node.data.agentConfigId, node]),
  );
  const sandboxLabels = new Map(
    (nodes as RuntimeNode[])
      .filter((node) => node.type === "sandbox")
      .map((node) => [resourceIdFor(node, "sandbox"), nodeLabel(node)]),
  );

  return deriveAgentRuntimeRefs(nodes, edges).flatMap(
    (refs): RuntimeRefsProblem[] => {
      const agent = agentsByConfig.get(refs.configId);
      const mount = findLaterSandboxMount(refs.sandboxes, refs.workspaces);
      if (!agent || !mount || isCodeManagedOwner(agent.data.managedBy)) {
        return [];
      }

      return [
        {
          agentId: agent.id,
          sandboxId: mount.sandboxId,
          sandboxLabel: sandboxLabels.get(mount.sandboxId) ?? mount.sandboxId,
          workspaceId: mount.workspace.workspaceId,
          workspaceName: mount.workspace.name,
        },
      ];
    },
  );
}

/** Why the config API refuses a problem, without the full stop. */
export function runtimeRefsProblemText(problem: RuntimeRefsProblem): string {
  return `${problem.workspaceName} is mounted on ${problem.sandboxLabel}, and only an agent's default sandbox can back a workspace`;
}

/** Stable serialization for change detection before writing Convex mutations. */
export function serializeRuntimeRefs(refs: AgentRuntimeRefs): string {
  return JSON.stringify({
    sandboxes: refs.sandboxes,
    workspaces: refs.workspaces,
  });
}

/**
 * Derive each agent's subagent call targets from directional `subagent` edges.
 * An edge source→target means the source agent may call the target agent, so the
 * target's config id is added to the source's callee list. Emits an entry for every
 * agent (even with no callees) so clearing the last edge still produces a write.
 */
export function deriveSubagentRefs(
  nodes: Node[],
  edges: Edge[],
): AgentSubagentRefs[] {
  const runtimeNodes = nodes as RuntimeNode[];
  const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
  const agents = runtimeNodes.filter((node) => node.type === "agent");

  // Caller node id → set of callee config ids, walking directional subagent edges only.
  const calleesByCaller = new Map<string, Set<Id<"agentConfigs">>>();
  for (const edge of edges) {
    if (edge.type !== "subagent") continue;
    const callee = byId.get(edge.target);
    const calleeConfigId = callee?.data.agentConfigId as
      | Id<"agentConfigs">
      | undefined;
    if (callee?.type !== "agent" || !calleeConfigId) continue;
    if (!calleesByCaller.has(edge.source))
      calleesByCaller.set(edge.source, new Set());
    calleesByCaller.get(edge.source)!.add(calleeConfigId);
  }

  return agents.flatMap((agent) => {
    const configId = agent.data.agentConfigId as Id<"agentConfigs"> | undefined;
    if (!configId) return [];
    const callees = calleesByCaller.get(agent.id);

    return [
      { configId: configId, calleeConfigIds: callees ? [...callees] : [] },
    ];
  });
}

/** Stable serialization for change detection before writing subagent mutations. */
export function serializeSubagentRefs(refs: AgentSubagentRefs): string {
  return JSON.stringify({ callees: [...refs.calleeConfigIds].sort() });
}

function buildAdjacency(edges: Edge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const source = edge.source;
    const target = edge.target;
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    adjacency.get(source)!.add(target);
    adjacency.get(target)!.add(source);
  }

  return adjacency;
}

function neighbors(
  nodeId: string,
  adjacency: Map<string, Set<string>>,
): string[] {
  return [...(adjacency.get(nodeId) ?? [])];
}

/** Short display label for a runtime node, preferring the mount name. */
function nodeLabel(node: RuntimeNode): string {
  return (node.data.mountName ?? node.data.label ?? "").trim() || node.id;
}

function normalizeWorkspaceName(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "default";
}

// Infra nodes chain through other infra nodes; every other type counts only a
// direct agent edge.
function resolveAgentReachability(
  nodes: RuntimeNode[],
  adjacency: Map<string, Set<string>>,
): Record<string, boolean> {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const touchesAgent = (nodeId: string): boolean =>
    neighbors(nodeId, adjacency).some((id) => typeById.get(id) === "agent");

  const reachable: Record<string, boolean> = {};
  const infraPending = new Set<string>();
  for (const node of nodes) {
    if (node.type === "agent") {
      reachable[node.id] = true;
    } else if (node.type === "workspace" || node.type === "sandbox") {
      infraPending.add(node.id);
    } else {
      reachable[node.id] = touchesAgent(node.id);
    }
  }

  // Infra nodes share one verdict per connected infra component: a single agent
  // edge anywhere in the component wires all of it.
  while (infraPending.size > 0) {
    const seed: string = infraPending.values().next().value!;
    infraPending.delete(seed);
    const component = [seed];
    const queue = [seed];
    let wired = false;
    while (queue.length > 0) {
      const current = queue.pop()!;
      wired ||= touchesAgent(current);
      for (const next of neighbors(current, adjacency)) {
        if (!infraPending.delete(next)) continue;
        component.push(next);
        queue.push(next);
      }
    }
    for (const nodeId of component) reachable[nodeId] = wired;
  }

  return reachable;
}

function resourceIdFor(
  node: RuntimeNode,
  type: "workspace" | "sandbox",
): string | undefined {
  const explicit = node.data.resourceId?.trim();
  if (explicit) return explicit;

  return type === "workspace" ? `ws_${node.id}` : `sb_${node.id}`;
}

function uniqueWorkspaceName(base: string, used: Set<string>): string {
  let name = normalizeWorkspaceName(base);
  let counter = 2;
  while (used.has(name)) {
    name = `${normalizeWorkspaceName(base)}-${counter}`;
    counter += 1;
  }
  used.add(name);

  return name;
}

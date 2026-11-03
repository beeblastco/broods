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

export type WorkspaceRef = {
  name: string;
  workspaceId: string;
  sandbox?: string | null;
};

export type AgentRuntimeRefs = {
  configId: Id<"agentConfigs">;
  sandboxes: string[];
  workspaces: WorkspaceRef[];
};

// The cascade `ws.sandbox` (override) ?? `config.sandboxes[0]` (inherited) ?? none.
export type WorkspaceSandboxState =
  | { kind: "override"; sandboxLabels: string[] }
  | { kind: "inherited"; sandboxLabels: string[] }
  | { kind: "readonly" };

export type CanvasInfraAnalysis = {
  workspaceStates: Record<string, WorkspaceSandboxState>;
  agentRefCounts: Record<string, number>;
  connectedToAgent: Record<string, boolean>;
};

export type RuntimeRefsProblem = {
  agentId: string;
  sandboxId: string;
  sandboxLabel: string;
  workspaceId: string;
  workspaceName: string;
};

export type AgentSubagentRefs = {
  configId: Id<"agentConfigs">;
  calleeConfigIds: Id<"agentConfigs">[];
};

type RuntimeNode = Node<BaseNodeData> & { type?: string };

// Cache only after the write lands, so a failed write is retried on the next save.
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

  // Not `all`: it throws while the other writes are still updating the cache.
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
      config: { provider: "lambda", permissionMode: "ask" },
    };
  }

  return { label: label, status: "idle" };
}

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

    // Direct edges only: a workspace is never inferred through a shared sandbox.
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

      // No mount edge inherits the default; only `readOnly` asks for `sandbox: null`.
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

// Mirrors `updateRuntimeRefs`, which leaves code-managed agents' refs alone.
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

export function runtimeRefsProblemText(problem: RuntimeRefsProblem): string {
  return `${problem.workspaceName} is mounted on ${problem.sandboxLabel}, and only an agent's default sandbox can back a workspace`;
}

export function serializeRuntimeRefs(refs: AgentRuntimeRefs): string {
  return JSON.stringify({
    sandboxes: refs.sandboxes,
    workspaces: refs.workspaces,
  });
}

// One entry per agent, even with no callees, so clearing the last edge still writes.
export function deriveSubagentRefs(
  nodes: Node[],
  edges: Edge[],
): AgentSubagentRefs[] {
  const runtimeNodes = nodes as RuntimeNode[];
  const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
  const agents = runtimeNodes.filter((node) => node.type === "agent");

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

// One agent edge anywhere in a connected infra component wires all of it.
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

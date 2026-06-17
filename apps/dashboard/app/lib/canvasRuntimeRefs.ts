/**
 * Derives filthy-panty AgentConfig sandbox/workspace references from canvas
 * runtime-resource nodes and edges.
 */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import type { Edge, Node } from "@xyflow/react";

/** Canvas node types that participate in filthy-panty runtime reference projection. */
export type RuntimeNodeType = "agent" | "workspace" | "sandbox";

/** A single filthy-panty AgentWorkspaceRef emitted from the canvas graph. */
export type WorkspaceRef = {
    name: string;
    workspaceId: string;
    sandbox?: string | null;
};

/** Runtime reference patch for one agent config. */
export type AgentRuntimeRefs = {
    configId: Id<"agentConfigs">;
    sandbox?: string;
    workspaces: WorkspaceRef[];
};

type RuntimeNode = Node<BaseNodeData> & { type?: string };

/** Build the default node data for a new runtime resource node. */
export function defaultRuntimeNodeData(type: string, label: string, id: string): BaseNodeData {
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

/**
 * Effective-sandbox state for a workspace, resolved from the filthy-panty cascade
 * `ws.sandbox (override) ?? config.sandbox (inherited) ?? none (read-only)`.
 */
export type WorkspaceSandboxState =
    | { kind: "override"; sandboxLabels: string[] }
    | { kind: "inherited"; sandboxLabel: string }
    | { kind: "readonly" };

/** Per-node infra annotations derived from the canvas graph for badge rendering. */
export type CanvasInfraAnalysis = {
    /** Workspace node id → its resolved effective-sandbox state. */
    workspaceStates: Record<string, WorkspaceSandboxState>;
    /** Workspace/sandbox node id → number of distinct agents that reference it. */
    agentRefCounts: Record<string, number>;
};

/** Short display label for a runtime node, preferring the mount name. */
function nodeLabel(node: RuntimeNode): string {
    return (node.data.mountName ?? node.data.label ?? "").trim() || node.id;
}

/**
 * Analyze the canvas graph once to drive per-node infra badges: each workspace's
 * effective-sandbox state (override/inherited/read-only) and how many agents share
 * each workspace/sandbox.
 */
export function analyzeCanvasInfra(nodes: Node[], edges: Edge[]): CanvasInfraAnalysis {
    const runtimeNodes = nodes as RuntimeNode[];
    const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
    const adjacency = buildAdjacency(edges);
    const agents = runtimeNodes.filter((node) => node.type === "agent");

    // agentId → its directly-attached default sandbox node (config.sandbox)
    const agentDefaultSandbox = new Map<string, RuntimeNode | undefined>();
    // resource node id → set of agent ids that reference it (for shared counts)
    const refAgents = new Map<string, Set<string>>();
    // workspace node id → agent ids directly wired to it
    const workspaceDirectAgents = new Map<string, string[]>();
    const addRef = (nodeId: string, agentId: string) => {
        if (!refAgents.has(nodeId)) refAgents.set(nodeId, new Set());
        refAgents.get(nodeId)!.add(agentId);
    };

    for (const agent of agents) {
        const directNodes = neighbors(agent.id, adjacency)
            .map((id) => byId.get(id))
            .filter((node): node is RuntimeNode => !!node);
        const defaultSandbox = directNodes.find((node) => node.type === "sandbox");
        agentDefaultSandbox.set(agent.id, defaultSandbox);
        if (defaultSandbox) addRef(defaultSandbox.id, agent.id);

        for (const workspace of directNodes.filter((node) => node.type === "workspace")) {
            addRef(workspace.id, agent.id);
            if (!workspaceDirectAgents.has(workspace.id)) workspaceDirectAgents.set(workspace.id, []);
            workspaceDirectAgents.get(workspace.id)!.push(agent.id);

            // The agent also references each sandbox this workspace is mounted into (override).
            for (const mount of neighbors(workspace.id, adjacency)) {
                if (byId.get(mount)?.type === "sandbox") addRef(mount, agent.id);
            }
        }
    }

    const agentRefCounts: Record<string, number> = {};
    for (const [nodeId, agentSet] of refAgents) {
        agentRefCounts[nodeId] = agentSet.size;
    }

    const workspaceStates: Record<string, WorkspaceSandboxState> = {};
    for (const node of runtimeNodes) {
        if (node.type !== "workspace") continue;

        const mountSandboxes = neighbors(node.id, adjacency)
            .map((id) => byId.get(id))
            .filter((n): n is RuntimeNode => n?.type === "sandbox");

        if (mountSandboxes.length > 0) {
            workspaceStates[node.id] = {
                kind: "override",
                sandboxLabels: mountSandboxes.map(nodeLabel),
            };

            continue;
        }

        // No mount edge. A CLI-resolved `readOnly` flag (e.g. a `sandbox: null` ref
        // with no other writer) forces read-only even when a directly-wired agent has
        // a default sandbox — the pure-canvas graph can't express that intent.
        if (node.data.readOnly === true) {
            workspaceStates[node.id] = { kind: "readonly" };

            continue;
        }

        // Otherwise inherit a directly-wired agent's default sandbox, else read-only.
        const inheritedFrom = (workspaceDirectAgents.get(node.id) ?? [])
            .map((agentId) => agentDefaultSandbox.get(agentId))
            .find((sandbox): sandbox is RuntimeNode => !!sandbox);

        workspaceStates[node.id] = inheritedFrom
            ? { kind: "inherited", sandboxLabel: nodeLabel(inheritedFrom) }
            : { kind: "readonly" };
    }

    return { workspaceStates: workspaceStates, agentRefCounts: agentRefCounts };
}

/** Derive all agent runtime references from the current canvas graph. */
export function deriveAgentRuntimeRefs(nodes: Node[], edges: Edge[]): AgentRuntimeRefs[] {
    const runtimeNodes = nodes as RuntimeNode[];
    const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
    const adjacency = buildAdjacency(edges);
    const agents = runtimeNodes.filter((node) => node.type === "agent");

    return agents.flatMap((agent) => {
        const agentConfigId = agent.data.agentConfigId as Id<"agentConfigs"> | undefined;
        if (!agentConfigId) {
            return [];
        }

        // An agent's resources come from its DIRECT edges (explicit model): the sandbox it
        // points at is its default; the workspaces it points at are its workspaces. Workspaces
        // are no longer inferred transitively through a shared sandbox.
        const directNodes = neighbors(agent.id, adjacency)
            .map((nodeId) => byId.get(nodeId))
            .filter((node): node is RuntimeNode => !!node);
        const directSandboxIds = directNodes
            .filter((node) => node.type === "sandbox")
            .map((node) => resourceIdFor(node, "sandbox"))
            .filter((value): value is string => !!value);
        const defaultSandbox = directSandboxIds[0];
        const workspaceNodes = directNodes.filter((node) => node.type === "workspace");

        const usedNames = new Set<string>();
        const workspaces: WorkspaceRef[] = [];
        for (const workspaceNode of workspaceNodes) {
            const workspaceId = resourceIdFor(workspaceNode, "workspace");
            if (!workspaceId) continue;

            const baseName = normalizeWorkspaceName(workspaceNode.data.mountName ?? workspaceNode.data.label)
                || `workspace_${workspaceNode.id}`;
            const linkedSandboxes = neighbors(workspaceNode.id, adjacency)
                .map((nodeId) => byId.get(nodeId))
                .filter((node): node is RuntimeNode => node?.type === "sandbox");

            if (linkedSandboxes.length === 0) {
                workspaces.push({
                    name: uniqueWorkspaceName(baseName, usedNames),
                    workspaceId: workspaceId,
                });
                continue;
            }

            linkedSandboxes.forEach((sandboxNode, index) => {
                const sandboxId = resourceIdFor(sandboxNode, "sandbox");
                if (!sandboxId) return;
                const suffix = normalizeWorkspaceName(sandboxNode.data.mountName ?? sandboxNode.data.label);
                const name = index === 0 ? baseName : `${baseName}-${suffix || `sandbox_${index + 1}`}`;
                workspaces.push({
                    name: uniqueWorkspaceName(name, usedNames),
                    workspaceId: workspaceId,
                    sandbox: sandboxId,
                });
            });
        }

        return [{
            configId: agentConfigId,
            ...(defaultSandbox ? { sandbox: defaultSandbox } : {}),
            workspaces: workspaces,
        }];
    });
}

/** Stable serialization for change detection before writing Convex mutations. */
export function serializeRuntimeRefs(refs: AgentRuntimeRefs): string {
    return JSON.stringify({
        sandbox: refs.sandbox ?? null,
        workspaces: refs.workspaces,
    });
}

/** A caller agent's subagent (agent→agent) call targets derived from the canvas graph. */
export type AgentSubagentRefs = {
    /** Caller agent's config id. */
    configId: Id<"agentConfigs">;
    /** Config ids of the agents this one may call (one per outgoing `subagent` edge). */
    calleeConfigIds: Id<"agentConfigs">[];
};

/**
 * Derive each agent's subagent call targets from directional `subagent` edges.
 * An edge source→target means the source agent may call the target agent, so the
 * target's config id is added to the source's callee list. Emits an entry for every
 * agent (even with no callees) so clearing the last edge still produces a write.
 */
export function deriveSubagentRefs(nodes: Node[], edges: Edge[]): AgentSubagentRefs[] {
    const runtimeNodes = nodes as RuntimeNode[];
    const byId = new Map(runtimeNodes.map((node) => [node.id, node]));
    const agents = runtimeNodes.filter((node) => node.type === "agent");

    // Caller node id → set of callee config ids, walking directional subagent edges only.
    const calleesByCaller = new Map<string, Set<Id<"agentConfigs">>>();
    for (const edge of edges) {
        if (edge.type !== "subagent") continue;
        const callee = byId.get(edge.target);
        const calleeConfigId = callee?.data.agentConfigId as Id<"agentConfigs"> | undefined;
        if (callee?.type !== "agent" || !calleeConfigId) continue;
        if (!calleesByCaller.has(edge.source)) calleesByCaller.set(edge.source, new Set());
        calleesByCaller.get(edge.source)!.add(calleeConfigId);
    }

    return agents.flatMap((agent) => {
        const configId = agent.data.agentConfigId as Id<"agentConfigs"> | undefined;
        if (!configId) return [];
        const callees = calleesByCaller.get(agent.id);

        return [{ configId: configId, calleeConfigIds: callees ? [...callees] : [] }];
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

function neighbors(nodeId: string, adjacency: Map<string, Set<string>>): string[] {
    return [...(adjacency.get(nodeId) ?? [])];
}

function resourceIdFor(node: RuntimeNode, type: "workspace" | "sandbox"): string | undefined {
    const explicit = node.data.resourceId?.trim();
    if (explicit) return explicit;

    return type === "workspace" ? `ws_${node.id}` : `sb_${node.id}`;
}

function normalizeWorkspaceName(value: string | undefined): string {
    const normalized = (value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return normalized || "default";
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

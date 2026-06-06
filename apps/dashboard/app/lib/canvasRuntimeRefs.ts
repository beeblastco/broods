/**
 * Derives filthy-panty AgentConfig sandbox/workspace references from canvas
 * runtime-resource nodes and edges.
 */
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import type { Id } from "@/convex/_generated/dataModel";
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

        const component = collectRuntimeComponent(agent.id, byId, adjacency);
        const directSandboxIds = neighbors(agent.id, adjacency)
            .map((nodeId) => byId.get(nodeId))
            .filter((node): node is RuntimeNode => node?.type === "sandbox")
            .map((node) => resourceIdFor(node, "sandbox"))
            .filter((value): value is string => !!value);
        const defaultSandbox = directSandboxIds[0];
        const workspaceNodes = [...component]
            .map((nodeId) => byId.get(nodeId))
            .filter((node): node is RuntimeNode => node?.type === "workspace");

        const usedNames = new Set<string>();
        const workspaces: WorkspaceRef[] = [];
        for (const workspaceNode of workspaceNodes) {
            const workspaceId = resourceIdFor(workspaceNode, "workspace");
            if (!workspaceId) continue;

            const baseName = normalizeWorkspaceName(workspaceNode.data.mountName ?? workspaceNode.data.label)
                || `workspace_${workspaceNode.id}`;
            const linkedSandboxes = neighbors(workspaceNode.id, adjacency)
                .map((nodeId) => byId.get(nodeId))
                .filter((node): node is RuntimeNode => node?.type === "sandbox" && component.has(node.id));

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

function collectRuntimeComponent(
    agentId: string,
    byId: Map<string, RuntimeNode>,
    adjacency: Map<string, Set<string>>,
): Set<string> {
    const visited = new Set<string>([agentId]);
    const component = new Set<string>();
    const queue = [agentId];

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of neighbors(current, adjacency)) {
            if (visited.has(next)) continue;
            visited.add(next);
            const node = byId.get(next);
            if (!node) continue;
            if (node.type !== "workspace" && node.type !== "sandbox") continue;
            component.add(next);
            queue.push(next);
        }
    }

    return component;
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

/**
 * Canvas helpers for tool service sync and agent connection rebuild.
 */
import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { canvasEdgeValidator, canvasNodeValidator } from "../schema";
import {
  defaultToolSourceCode,
  makeUniqueToolName,
  normalizeToolName,
} from "./toolService";

type CanvasNode = Infer<typeof canvasNodeValidator>;
type CanvasEdge = Infer<typeof canvasEdgeValidator>;

/**
 * Sync tool service records from tool nodes on the canvas.
 * Creates new tool services for new tool nodes, renames existing ones
 * when labels change, and deletes orphaned tool services.
 * @param ctx Mutation context
 * @param args Canvas and project context
 * @returns List of stale tool names that were removed or renamed
 */
export async function syncToolServicesFromNodes(
  ctx: MutationCtx,
  args: {
    authId: string;
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    nodes: CanvasNode[];
    now: number;
  },
): Promise<string[]> {
  const { authId, projectId, environmentId, nodes, now } = args;

  const toolNodes = nodes
    .filter((node) => node.type === "tool")
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const toolNodeIds = new Set(toolNodes.map((node) => node.id));

  const existingToolServices = await ctx.db
    .query("toolServices")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();
  const existingToolsByNodeId = new Map(existingToolServices.map((tool) => [tool.nodeId, tool]));
  const usedToolNames = new Set(existingToolServices.map((tool) => tool.name));
  const staleToolNames: string[] = [];

  for (const toolNode of toolNodes) {
    const nodeLabel = toolNode.data.label?.trim() || `tool_${toolNode.id}`;
    const existingToolService = existingToolsByNodeId.get(toolNode.id);

    if (existingToolService) {
      usedToolNames.delete(existingToolService.name);
      const nextName = makeUniqueToolName(normalizeToolName(nodeLabel), usedToolNames);
      usedToolNames.add(nextName);

      if (nextName !== existingToolService.name) {
        staleToolNames.push(existingToolService.name);
        await ctx.db.patch(existingToolService._id, {
          name: nextName,
          updatedAt: now,
        });
      }
      continue;
    }

    const nextName = makeUniqueToolName(normalizeToolName(nodeLabel), usedToolNames);
    usedToolNames.add(nextName);

    await ctx.db.insert("toolServices", {
      authId: authId,
      projectId: projectId,
      environmentId: environmentId,
      nodeId: toolNode.id,
      name: nextName,
      status: "enabled",
      language: "javascript",
      sourceCode: defaultToolSourceCode("javascript"),
      updatedAt: now,
    });
  }

  for (const existingToolService of existingToolServices) {
    if (toolNodeIds.has(existingToolService.nodeId)) {
      continue;
    }
    staleToolNames.push(existingToolService.name);
    await ctx.db.delete(existingToolService._id);
  }

  return staleToolNames;
}

/**
 * Rebuild agentConnections from the current edge graph.
 * Compares desired connections (derived from edges) with existing ones
 * and inserts/deletes as needed.
 * @param ctx Mutation context
 * @param args Canvas and project context
 */
export async function rebuildAgentConnections(
  ctx: MutationCtx,
  args: {
    authId: string;
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    now: number;
  },
): Promise<void> {
  const { authId, projectId, environmentId, nodes, edges, now } = args;

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const desiredConnectionsByAgent = new Map<
    Id<"agentConfigs">,
    Map<string, { targetType: "agent" | "tool" | "workspace" | "database"; targetId: string }>
  >();

  function addDesiredConnection(
    agentConfigId: Id<"agentConfigs">,
    targetType: "agent" | "tool" | "workspace" | "database",
    targetId: string,
  ) {
    const key = `${targetType}:${targetId}`;
    const existing = desiredConnectionsByAgent.get(agentConfigId);
    if (existing) {
      existing.set(key, { targetType: targetType, targetId: targetId });
    } else {
      desiredConnectionsByAgent.set(
        agentConfigId,
        new Map([[key, { targetType: targetType, targetId: targetId }]]),
      );
    }
  }

  for (const edge of edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) {
      continue;
    }

    const sourceAgentConfigId =
      sourceNode.type === "agent"
        ? (sourceNode.data.agentConfigId as Id<"agentConfigs"> | undefined)
        : undefined;
    const targetAgentConfigId =
      targetNode.type === "agent"
        ? (targetNode.data.agentConfigId as Id<"agentConfigs"> | undefined)
        : undefined;

    if (sourceAgentConfigId && targetNode.type === "agent" && targetAgentConfigId) {
      addDesiredConnection(sourceAgentConfigId, "agent", String(targetAgentConfigId));
      continue;
    }

    if (
      sourceAgentConfigId &&
      (targetNode.type === "tool" || targetNode.type === "workspace" || targetNode.type === "database")
    ) {
      addDesiredConnection(sourceAgentConfigId, targetNode.type, targetNode.id);
      continue;
    }

    if (
      targetAgentConfigId &&
      (sourceNode.type === "tool" || sourceNode.type === "workspace" || sourceNode.type === "database")
    ) {
      addDesiredConnection(targetAgentConfigId, sourceNode.type, sourceNode.id);
    }
  }

  const environmentConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();

  for (const config of environmentConfigs) {
    const existingConnections = await ctx.db
      .query("agentConnections")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
      .collect();
    const existingByKey = new Map(
      existingConnections.map((connection) => [
        `${connection.targetType}:${connection.targetId}`,
        connection,
      ]),
    );
    const desiredForAgent = desiredConnectionsByAgent.get(config._id) ?? new Map();

    for (const [key, existingConnection] of existingByKey) {
      if (!desiredForAgent.has(key)) {
        await ctx.db.delete(existingConnection._id);
      }
    }

    for (const [key, desiredConnection] of desiredForAgent) {
      if (existingByKey.has(key)) {
        continue;
      }
      await ctx.db.insert("agentConnections", {
        authId: authId,
        agentConfigId: config._id,
        targetType: desiredConnection.targetType,
        targetId: desiredConnection.targetId,
        updatedAt: now,
      });
    }
  }
}

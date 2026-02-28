/**
 * Canvas layout queries and mutations for managing node/edge data by project and environment.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { rebuildAgentConnections, syncToolServicesFromNodes } from "./model/canvas";
import { syncSubAgentFlagsForEnvironment } from "./model/agentConfig";
import { verifyProjectOwnership } from "./model/ownership";
import { syncAgentToolPermissionsForEnvironment } from "./model/toolService";
import { canvasEdgeValidator, canvasNodeValidator } from "./schema";

/**
 * Get the canvas layout for a given project and environment.
 * @param projectId The project to fetch the canvas for
 * @param environmentId The environment to scope the canvas to
 * @returns Object with nodes and edges arrays, or null if no layout exists
 */
export const getByProject = query({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
  },
  returns: v.union(
    v.object({
      nodes: v.array(canvasNodeValidator),
      edges: v.array(canvasEdgeValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const { projectId, environmentId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId),
      )
      .first();

    if (!layout) {
      return null;
    }

    return { nodes: layout.nodes, edges: layout.edges };
  },
});

/**
 * Save the full canvas layout (nodes + edges) for a project environment.
 * @param projectId The project this layout belongs to
 * @param environmentId The environment to scope the layout to
 * @param nodes Full array of canvas nodes
 * @param edges Full array of canvas edges
 * @returns null
 * @throws Error if user is not authenticated or does not own the project
 */
export const saveLayout = mutation({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodes: v.array(canvasNodeValidator),
    edges: v.array(canvasEdgeValidator),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { projectId, environmentId, nodes, edges } = args;
    const now = Date.now();

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    const existingLayout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId),
      )
      .first();

    if (existingLayout) {
      await ctx.db.patch(existingLayout._id, {
        nodes: nodes,
        edges: edges,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("canvasLayouts", {
        authId: user.subject,
        projectId: projectId,
        environmentId: environmentId,
        nodes: nodes,
        edges: edges,
        updatedAt: now,
      });
    }

    // Sync tool services from tool nodes on the canvas.
    const staleToolNames = await syncToolServicesFromNodes(ctx, {
      authId: user.subject,
      projectId: projectId,
      environmentId: environmentId,
      nodes: nodes,
      now: now,
    });

    // Rebuild agentConnections from the current edge graph.
    await rebuildAgentConnections(ctx, {
      authId: user.subject,
      projectId: projectId,
      environmentId: environmentId,
      nodes: nodes,
      edges: edges,
      now: now,
    });

    // Keep each config's isSubAgent flag in sync with inbound agent connections.
    await syncSubAgentFlagsForEnvironment(ctx, {
      projectId: projectId,
      environmentId: environmentId,
    });

    // Keep each agent config's allowed/disallowed custom tool names in sync.
    await syncAgentToolPermissionsForEnvironment(ctx, {
      projectId: projectId,
      environmentId: environmentId,
      extraToolNamesToClear: staleToolNames,
    });

    return null;
  },
});

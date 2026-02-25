/**
 * Canvas layout queries for reading node/edge data by project and environment.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
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

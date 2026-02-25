/**
 * Canvas layout queries for reading node/edge data by project.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { canvasEdgeValidator, canvasNodeValidator } from "./schema";

/**
 * Get the canvas layout for a given project.
 * @param projectId The project to fetch the canvas for
 * @returns Object with nodes and edges arrays, or null if no layout exists
 */
export const getByProject = query({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.union(
    v.object({
      nodes: v.array(canvasNodeValidator),
      edges: v.array(canvasEdgeValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      return null;
    }

    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .first();

    if (!layout) {
      return null;
    }

    return { nodes: layout.nodes, edges: layout.edges };
  },
});

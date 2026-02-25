/**
 * Project queries and mutations for workspace management.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { projectFields } from "./schema";

/** Validator for project records with system fields. */
const projectValidator = v.object(withSystemFields("projects", projectFields));

/**
 * List all projects owned by the authenticated user.
 * @returns Array of project documents
 */
export const list = query({
  args: {},
  returns: v.array(projectValidator),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      return [];
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .collect();

    return projects;
  },
});

/**
 * Create a new project for the authenticated user.
 * @param name Display name for the project
 * @param description Optional project description
 * @returns The new project document ID
 * @throws Error if user is not authenticated or slug already exists
 */
export const create = mutation({
  args: {
    name: projectFields.name,
    description: projectFields.description,
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const { name, description } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const projectId = await ctx.db.insert("projects", {
      authId: user.subject,
      name: name,
      description: description,
      slug: slug,
      updatedAt: Date.now(),
    });

    return projectId;
  },
});

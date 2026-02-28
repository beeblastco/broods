/**
 * Agent deployment endpoint management for external gateway access.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { agentConfigFields, agentDeploymentFields } from "./schema";
import { createDeploymentForConfig } from "./model/agentDeployment";
import { verifyAgentConfigOwnership, verifyDeploymentOwnership } from "./model/ownership";

/** Validator for deployment records with system fields. */
const agentDeploymentValidator = v.object(
  withSystemFields("agentDeployments", agentDeploymentFields),
);

/** Validator for agent config records with system fields. */
const agentConfigValidator = v.object(
  withSystemFields("agentConfigs", agentConfigFields),
);

/** Validator for gateway lookup by endpointId. */
const deploymentWithConfigValidator = v.union(
  v.object({
    deployment: agentDeploymentValidator,
    agentConfig: agentConfigValidator,
  }),
  v.null(),
);

/**
 * Create a deployed endpoint with an API key for an agent config.
 * Resolves the environment slug from the agent config's environment.
 * @param agentConfigId Agent config ID to deploy
 * @returns Endpoint ID, raw API key (shown once), and environment slug
 * @throws Error if user is not authenticated or does not own the config
 */
export const create = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
  },
  returns: v.object({
    endpointId: v.string(),
    rawApiKey: v.string(),
    projectSlug: v.optional(v.string()),
    environmentSlug: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const { agentConfigId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyAgentConfigOwnership(ctx, agentConfigId, user.subject);

    // Resolve agent config for project and environment lookups
    const agentConfig = await ctx.db.get(agentConfigId);
    if (!agentConfig) {
      throw new Error("Agent config not found");
    }

    // Resolve project slug from the agent config's project
    const project = await ctx.db.get(agentConfig.projectId);
    const projectSlug = project?.slug;

    // Resolve environment slug from the agent config's environment
    let environmentSlug: string | undefined;
    if (agentConfig.environmentId) {
      const env = await ctx.db.get(agentConfig.environmentId);
      if (env && !env.isDefault) {
        environmentSlug = env.name.toLowerCase().replace(/\s+/g, "-");
      }
    }

    return await createDeploymentForConfig(ctx, user.subject, agentConfigId, projectSlug, environmentSlug);
  },
});

/**
 * List deployments for the authenticated user.
 * @param agentConfigId Optional filter by config ID
 * @returns Deployment records
 */
export const list = query({
  args: {
    agentConfigId: v.optional(v.id("agentConfigs")),
  },
  returns: v.array(agentDeploymentValidator),
  handler: async (ctx, args) => {
    const { agentConfigId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    let deployments;
    if (agentConfigId) {
      await verifyAgentConfigOwnership(ctx, agentConfigId, user.subject);

      deployments = await ctx.db
        .query("agentDeployments")
        .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfigId))
        .take(100);
    } else {
      deployments = await ctx.db
        .query("agentDeployments")
        .withIndex("by_authId", (q) => q.eq("authId", user.subject))
        .take(100);
    }

    return deployments;
  },
});

/**
 * Revoke a deployed endpoint so the API key can no longer be used.
 * @param deploymentId Deployment ID
 * @returns null
 * @throws Error if user is not authenticated or does not own the deployment
 */
export const revoke = mutation({
  args: {
    deploymentId: v.id("agentDeployments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { deploymentId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyDeploymentOwnership(ctx, deploymentId, user.subject);

    await ctx.db.patch(deploymentId, {
      status: "revoked",
      revokedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Resolve deployment and config by external endpoint ID for gateway usage.
 * @param endpointId External endpoint ID from URL
 * @param environmentSlug Optional environment slug from URL path
 * @returns Deployment and config, or null if missing/mismatched
 */
export const getByEndpointIdForGateway = internalQuery({
  args: {
    endpointId: v.string(),
    environmentSlug: v.optional(v.string()),
  },
  returns: deploymentWithConfigValidator,
  handler: async (ctx, args) => {
    const { endpointId, environmentSlug } = args;

    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
      .unique();
    if (!deployment) {
      return null;
    }

    // Verify environment slug matches the deployment
    if ((deployment.environmentSlug ?? undefined) !== environmentSlug) {
      return null;
    }

    const agentConfig = await ctx.db.get(deployment.agentConfigId);
    if (!agentConfig) {
      return null;
    }

    return {
      deployment: deployment,
      agentConfig: agentConfig,
    };
  },
});

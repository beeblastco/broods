/**
 * Agent deployment endpoint management for external gateway access.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { agentConfigFields, agentDeploymentFields } from "./schema";
import { assertGatewaySecret } from "./model/gateway";
import { verifyAgentConfigOwnership } from "./model/ownership";

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
 * Create a new deployed endpoint and one-time API key for an agent config.
 * @param agentConfigId Agent config ID to deploy
 * @returns Endpoint ID and raw API key (shown once)
 * @throws Error if user is not authenticated or does not own the config
 */
export const create = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
  },
  returns: v.object({
    endpointId: v.string(),
    rawApiKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const { agentConfigId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyAgentConfigOwnership(ctx, agentConfigId, user.subject);

    const endpointId = await generateUniqueEndpointId(ctx);
    const rawApiKey = `sk_live_${createSecureToken(48)}`;
    const apiKeyHash = await hashApiKey(rawApiKey);

    await ctx.db.insert("agentDeployments", {
      authId: user.subject,
      agentConfigId: agentConfigId,
      endpointId: endpointId,
      apiKey: rawApiKey,
      apiKeyHash: apiKeyHash,
      status: "active",
      updatedAt: Date.now(),
    });

    return {
      endpointId: endpointId,
      rawApiKey: rawApiKey,
    };
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

    const deployment = await ctx.db.get(deploymentId);
    if (!deployment || deployment.authId !== user.subject) {
      throw new Error("Deployment not found or access denied");
    }

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
 * @returns Deployment and config, or null if missing
 */
export const getByEndpointIdForGateway = query({
  args: {
    endpointId: v.string(),
    gatewaySecret: v.string(),
  },
  returns: deploymentWithConfigValidator,
  handler: async (ctx, args) => {
    const { endpointId, gatewaySecret } = args;

    assertGatewaySecret(gatewaySecret);

    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
      .unique();
    if (!deployment) {
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

/**
 * Generate an endpoint ID with collision retry.
 * @param ctx Convex query/mutation context
 * @returns Unique endpoint ID
 */
async function generateUniqueEndpointId(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const endpointId = `ag_${createSecureToken(16)}`;
    const existing = await ctx.db
      .query("agentDeployments")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
      .unique();
    if (!existing) {
      return endpointId;
    }
  }

  throw new Error("Failed to generate unique endpoint ID");
}

/**
 * Generate a secure random token from URL-safe characters.
 * @param length Token length
 * @returns Random token string
 */
function createSecureToken(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Hash an API key using SHA-256 for secure storage.
 * @param apiKey Raw API key
 * @returns Hex encoded hash
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const pepper = process.env.AGENT_API_KEY_PEPPER ?? "";
  const payload = `${pepper}:${apiKey}`;
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return bytesToHex(new Uint8Array(digest));
}

/**
 * Convert bytes to lowercase hexadecimal string.
 * @param bytes Byte array
 * @returns Hex representation
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

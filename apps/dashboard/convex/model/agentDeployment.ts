/**
 * Shared agent deployment helpers for creating endpoints and managing API keys.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Create a deployment record for an agent config.
 * @param ctx Convex mutation context
 * @param authId Authenticated user's subject ID
 * @param agentConfigId Agent config to deploy
 * @param projectSlug Optional project slug for URL prefix
 * @param environmentSlug Optional environment slug for URL prefix and key naming
 * @returns Endpoint ID, raw API key, project slug, and environment slug
 */
export async function createDeploymentForConfig(
  ctx: MutationCtx,
  authId: string,
  agentConfigId: Id<"agentConfigs">,
  projectSlug: string | undefined,
  environmentSlug: string | undefined,
): Promise<{
  endpointId: string;
  rawApiKey: string;
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
}> {
  const endpointId = await generateUniqueEndpointId(ctx);
  const keyPrefix = environmentSlug ? `sk_${environmentSlug}_` : "sk_live_";
  const rawApiKey = `${keyPrefix}${createSecureToken(48)}`;
  const apiKeyHash = await hashApiKey(rawApiKey);

  await ctx.db.insert("agentDeployments", {
    authId: authId,
    agentConfigId: agentConfigId,
    endpointId: endpointId,
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: rawApiKey,
    apiKeyHash: apiKeyHash,
    status: "active",
    updatedAt: Date.now(),
  });

  return {
    endpointId: endpointId,
    rawApiKey: rawApiKey,
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
  };
}

/**
 * Generate an endpoint ID with collision retry.
 * @param ctx Convex mutation context
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
  const maxValid = 256 - (256 % alphabet.length);
  const result: string[] = [];

  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - result.length + 16));
    for (const byte of bytes) {
      if (byte < maxValid && result.length < length) {
        result.push(alphabet[byte % alphabet.length]);
      }
    }
  }

  return result.join("");
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

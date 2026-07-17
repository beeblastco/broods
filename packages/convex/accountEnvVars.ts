/**
 * Internal storage for write-only account environment variables used by the
 * public config plane. Values are encrypted with the same AES-GCM codec as
 * environmentVariables and source-backed agent configs are refreshed on change.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  substituteAccountEnvPlaceholders,
} from "./model/agentConfigCodec";

/** List write-only account variable metadata; ciphertext never leaves storage. */
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(v.object({ name: v.string(), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("accountEnvVars")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();

    return rows.map((row) => ({ name: row.name, updatedAt: row.updatedAt }));
  },
});

/** Load decrypted account variable values for resolving a config write. */
export const loadValues = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, args) => {
    return await loadValuesForAccount(ctx, args.accountId);
  },
});

/** Upsert an account variable and refresh every source-backed agent in the account. */
export const set = internalMutation({
  args: { accountId: v.id("accounts"), name: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const secret = encryptionSecret();
    const existing = await ctx.db
      .query("accountEnvVars")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", args.name),
      )
      .unique();
    const encrypted = await encryptAgentConfigBlob(
      { value: args.value },
      secret,
    );
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accountEnvVars", {
        accountId: args.accountId,
        name: args.name,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        updatedAt: now,
      });
    }
    await refreshSourceBackedAgents(ctx, args.accountId);

    return null;
  },
});

/** Delete an account variable and re-resolve source-backed agents, preserving missing placeholders literally. */
export const remove = internalMutation({
  args: { accountId: v.id("accounts"), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("accountEnvVars")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", args.name),
      )
      .unique();
    if (!existing) return false;

    await ctx.db.delete(existing._id);
    await refreshSourceBackedAgents(ctx, args.accountId);

    return true;
  },
});

/** Read the shared AES-GCM secret used by config and environment blobs. */
function encryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required");

  return secret;
}

/** Decrypt every account variable into the map used for write-time substitution. */
async function loadValuesForAccount(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
): Promise<Record<string, string>> {
  const rows = await ctx.db
    .query("accountEnvVars")
    .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
    .collect();
  const secret = encryptionSecret();
  const values: Record<string, string> = {};
  for (const row of rows) {
    const decrypted = await decryptAgentConfigBlob(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      secret,
    );
    // Fail loudly: silently resolving to "" would bake an empty secret
    // into an agent's live config instead of surfacing the corruption.
    if (typeof decrypted?.value !== "string") {
      throw new Error(`Failed to decrypt account env var "${row.name}"`);
    }
    values[row.name] = decrypted.value;
  }

  return values;
}

/** Re-encrypt resolved agent configs from their retained source configs after an env change. */
async function refreshSourceBackedAgents(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const secret = encryptionSecret();
  const values = await loadValuesForAccount(ctx, accountId);
  const agents = await ctx.db
    .query("agents")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();
  for (const agent of agents) {
    if (
      !agent.encryptedSourceConfig ||
      !agent.sourceEncryptionIv ||
      !agent.sourceEncryptionTag
    )
      continue;
    const source = await decryptAgentConfigBlob(
      {
        ciphertext: agent.encryptedSourceConfig,
        iv: agent.sourceEncryptionIv,
        tag: agent.sourceEncryptionTag,
      },
      secret,
    );
    if (!source) continue;
    const encrypted = await encryptAgentConfigBlob(
      substituteAccountEnvPlaceholders(source, values),
      secret,
    );
    await ctx.db.patch(agent._id, {
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      updatedAt: Date.now(),
    });
  }
}

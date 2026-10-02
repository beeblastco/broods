/**
 * Internal storage for OAuth sign-ins that back a model provider instead of an
 * API key (`providerCredentials`). The config plane writes a fresh sign-in,
 * core loads it per model call and saves each rotated refresh back. Tokens are
 * encrypted with the agent-config codec; only metadata leaves through `status`.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "../model/agentConfigCodec";
import { providerCredentialsFields } from "../schema";

const providerValidator = providerCredentialsFields.provider;

export type CredentialProvider = Infer<typeof providerValidator>;

const statusFields = {
  clientId: v.string(),
  hostId: v.string(),
  email: v.optional(v.string()),
  scopes: v.array(v.string()),
  expiresAt: v.number(),
  updatedAt: v.number(),
};
const statusValidator = v.object(statusFields);

const tokenFields = {
  accessToken: v.string(),
  refreshToken: v.string(),
};

export type ProviderCredentialStatus = Infer<typeof statusValidator>;

/** What the sign-in holds, never its tokens. Null when the account has none. */
export const status = internalQuery({
  args: { accountId: v.id("accounts"), provider: providerValidator },
  returns: v.union(v.null(), statusValidator),
  handler: async (ctx, args): Promise<ProviderCredentialStatus | null> => {
    const row = await findRow(ctx, args.accountId, args.provider);

    return row ? statusOf(row) : null;
  },
});

/** The decrypted sign-in, for core's model calls and for revocation. */
export const load = internalQuery({
  args: { accountId: v.id("accounts"), provider: providerValidator },
  returns: v.union(v.null(), v.object({ ...statusFields, ...tokenFields })),
  handler: async (ctx, args) => {
    const row = await findRow(ctx, args.accountId, args.provider);
    if (!row) return null;
    const tokens = await decryptAgentConfigBlob(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      encryptionSecret(),
    );
    if (
      typeof tokens?.accessToken !== "string" ||
      typeof tokens.refreshToken !== "string"
    ) {
      throw new Error(`Failed to decrypt the ${args.provider} credential`);
    }

    return {
      ...statusOf(row),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  },
});

/** Store a fresh sign-in, replacing the account's previous one. */
export const set = internalMutation({
  args: {
    accountId: v.id("accounts"),
    provider: providerValidator,
    clientId: v.string(),
    hostId: v.string(),
    email: v.optional(v.string()),
    scopes: v.array(v.string()),
    expiresAt: v.number(),
    ...tokenFields,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { accessToken, refreshToken, ...metadata } = args;
    const fields = {
      ...metadata,
      ...(await encryptTokens(accessToken, refreshToken)),
      updatedAt: Date.now(),
    };
    const existing = await findRow(ctx, args.accountId, args.provider);
    if (existing) {
      await ctx.db.replace(existing._id, fields);
    } else {
      await ctx.db.insert("providerCredentials", fields);
    }

    return null;
  },
});

/**
 * Save a refreshed token set over the one core loaded. False when the row
 * changed since (a new sign-in, a logout), so a refresh never overwrites it.
 */
export const saveRefreshed = internalMutation({
  args: {
    accountId: v.id("accounts"),
    provider: providerValidator,
    loadedUpdatedAt: v.number(),
    scopes: v.array(v.string()),
    expiresAt: v.number(),
    ...tokenFields,
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.accountId, args.provider);
    if (!row || row.updatedAt !== args.loadedUpdatedAt) return false;
    await ctx.db.patch(row._id, {
      ...(await encryptTokens(args.accessToken, args.refreshToken)),
      scopes: args.scopes,
      expiresAt: args.expiresAt,
      updatedAt: Date.now(),
    });

    return true;
  },
});

/**
 * Forget the sign-in logout loaded. False when there was none, or when a new
 * sign-in replaced it since, so a slow logout never deletes the newer one.
 */
export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    provider: providerValidator,
    loadedUpdatedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.accountId, args.provider);
    if (!row || row.updatedAt !== args.loadedUpdatedAt) return false;
    await ctx.db.delete(row._id);

    return true;
  },
});

async function findRow(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  provider: CredentialProvider,
): Promise<Doc<"providerCredentials"> | null> {
  return await ctx.db
    .query("providerCredentials")
    .withIndex("by_accountId_and_provider", (q) =>
      q.eq("accountId", accountId).eq("provider", provider),
    )
    .unique();
}

function statusOf(row: Doc<"providerCredentials">): ProviderCredentialStatus {
  return {
    clientId: row.clientId,
    hostId: row.hostId,
    ...(row.email !== undefined ? { email: row.email } : {}),
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

async function encryptTokens(
  accessToken: string,
  refreshToken: string,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  return await encryptAgentConfigBlob(
    { accessToken: accessToken, refreshToken: refreshToken },
    encryptionSecret(),
  );
}

function encryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required");

  return secret;
}

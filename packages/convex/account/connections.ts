/**
 * Internal storage for connections: external accounts signed in by `broods
 * connect`. The config plane writes a fresh sign-in, core loads it per call
 * and saves each rotated refresh back, and a disconnect forgets it, then
 * revokes at the provider. Tokens and the client secret are encrypted with the
 * agent-config codec; only metadata leaves through `list`.
 */

import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { configEncryptionSecret } from "../config/routes/shared";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  type EncryptedAgentConfig,
} from "../model/agentConfigCodec";
import { CONNECTION_TYPES } from "../model/connections";
import { connectionsFields } from "../schema";

const REVOKE_TIMEOUT_MS = 5_000;

const signInFields = {
  type: connectionsFields.type,
  clientId: connectionsFields.clientId,
  hostId: connectionsFields.hostId,
  email: connectionsFields.email,
  scopes: connectionsFields.scopes,
  expiresAt: connectionsFields.expiresAt,
};
const statusFields = {
  name: connectionsFields.name,
  ...signInFields,
  updatedAt: connectionsFields.updatedAt,
};
export const statusValidator = v.object(statusFields);
const secretFields = {
  accessToken: v.string(),
  refreshToken: v.string(),
  clientSecret: v.optional(v.string()),
};
const storedValidator = v.object({ ...statusFields, ...secretFields });
const secretsValidator = v.object(secretFields);
const ref = { accountId: v.id("accounts"), name: v.string() };

export type ConnectionStatus = Infer<typeof statusValidator>;
export type StoredConnection = Infer<typeof storedValidator>;
type ConnectionSecrets = Infer<typeof secretsValidator>;

/** Every connection the account holds, never their tokens. */
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(statusValidator),
  handler: async (ctx, args): Promise<ConnectionStatus[]> => {
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();

    return rows.map((row) => statusOf(row));
  },
});

/** One connection by name, never its tokens. */
export const status = internalQuery({
  args: ref,
  returns: v.union(v.null(), statusValidator),
  handler: async (ctx, args): Promise<ConnectionStatus | null> => {
    const row = await findRow(ctx, args.accountId, args.name);

    return row ? statusOf(row) : null;
  },
});

/** The decrypted connection, for core's refresh and calls. */
export const load = internalQuery({
  args: ref,
  returns: v.union(v.null(), storedValidator),
  handler: async (ctx, args): Promise<StoredConnection | null> => {
    const row = await findRow(ctx, args.accountId, args.name);

    return row ? await decrypted(row) : null;
  },
});

/** Store a fresh sign-in under its name, replacing what was there; answers what is stored. */
export const set = internalMutation({
  args: { ...ref, ...signInFields, ...secretFields },
  returns: statusValidator,
  handler: async (ctx, args): Promise<ConnectionStatus> => {
    const { accessToken, refreshToken, clientSecret, ...metadata } = args;
    const fields = {
      ...metadata,
      ...(await encryptSecrets({
        accessToken: accessToken,
        refreshToken: refreshToken,
        clientSecret: clientSecret,
      })),
      updatedAt: Date.now(),
    };
    const existing = await findRow(ctx, args.accountId, args.name);
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("connections", fields);

    return statusOf(fields);
  },
});

/**
 * Save a refreshed token pair over the one core loaded. False when the row
 * changed since (a new sign-in, a disconnect), so a refresh never overwrites it.
 */
export const saveRefreshed = internalMutation({
  args: {
    ...ref,
    loadedUpdatedAt: v.number(),
    expiresAt: v.number(),
    accessToken: v.string(),
    refreshToken: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.accountId, args.name);
    if (!row || row.updatedAt !== args.loadedUpdatedAt) return false;
    const { clientSecret } = await decrypted(row);
    await ctx.db.patch(row._id, {
      ...(await encryptSecrets({
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        clientSecret: clientSecret,
      })),
      expiresAt: args.expiresAt,
      updatedAt: Date.now(),
    });

    return true;
  },
});

/** Forget the connection, then revoke it at the provider. False when there was none. */
export const disconnect = internalMutation({
  args: ref,
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.accountId, args.name);
    if (!row) return false;
    await ctx.db.delete(row._id);
    const revokeUrl = CONNECTION_TYPES[row.type].revokeUrl;
    // The secrets stay encrypted in the scheduler; the action decrypts them.
    if (revokeUrl) {
      await ctx.scheduler.runAfter(0, internal.account.connections.revoke, {
        revokeUrl: revokeUrl,
        clientId: row.clientId,
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
      });
    }

    return true;
  },
});

/**
 * Best effort: a disconnect must still forget the tokens when the provider is
 * down, and the user can always end the grant in the provider's own settings.
 */
export const revoke = internalAction({
  args: {
    revokeUrl: v.string(),
    clientId: v.string(),
    ciphertext: connectionsFields.ciphertext,
    iv: connectionsFields.iv,
    tag: connectionsFields.tag,
  },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    try {
      const secrets = await decryptSecrets(args);
      const response = await fetch(args.revokeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: secrets.refreshToken,
          token_type_hint: "refresh_token",
          client_id: args.clientId,
          ...(secrets.clientSecret
            ? { client_secret: secrets.clientSecret }
            : {}),
        }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(
          `Token revocation at ${args.revokeUrl} failed: HTTP ${response.status}`,
        );
      }
    } catch (error) {
      console.warn(`Token revocation at ${args.revokeUrl} failed`, error);
    }

    return null;
  },
});

/** The row with its tokens and client secret decrypted. */
async function decrypted(row: Doc<"connections">): Promise<StoredConnection> {
  return { ...statusOf(row), ...(await decryptSecrets(row)) };
}

/** The tokens and client secret out of a row's encrypted blob. */
async function decryptSecrets(
  blob: EncryptedAgentConfig,
): Promise<ConnectionSecrets> {
  const secrets = await decryptAgentConfigBlob(
    { ciphertext: blob.ciphertext, iv: blob.iv, tag: blob.tag },
    configEncryptionSecret(),
  );
  if (
    typeof secrets?.accessToken !== "string" ||
    typeof secrets.refreshToken !== "string"
  ) {
    throw new Error("Failed to decrypt a connection");
  }

  return {
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    ...(typeof secrets.clientSecret === "string"
      ? { clientSecret: secrets.clientSecret }
      : {}),
  };
}

/** The tokens and client secret as one encrypted blob for the row. */
async function encryptSecrets(secrets: {
  accessToken: string;
  refreshToken: string;
  clientSecret: string | undefined;
}): Promise<EncryptedAgentConfig> {
  return await encryptAgentConfigBlob(
    {
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
    },
    configEncryptionSecret(),
  );
}

/** The account's connection by name, if any. */
async function findRow(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  name: string,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_accountId_and_name", (q) =>
      q.eq("accountId", accountId).eq("name", name),
    )
    .unique();
}

/** What a connection holds, never its secrets. */
function statusOf(
  row: Omit<Doc<"connections">, "_id" | "_creationTime">,
): ConnectionStatus {
  return {
    name: row.name,
    type: row.type,
    clientId: row.clientId,
    ...(row.hostId !== undefined ? { hostId: row.hostId } : {}),
    ...(row.email !== undefined ? { email: row.email } : {}),
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

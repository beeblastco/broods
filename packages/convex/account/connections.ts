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
import { accountCipher, accountCipherForWrite } from "../model/accountKeys";
import { accountCipherForAction } from "../config/routes/shared";
import type { AccountCipher, EncryptedBlob } from "../model/envelope";
import { CONNECTION_TYPES, type ConnectionType } from "../model/connections";
import { connectionsFields } from "../schema";

const REVOKE_TIMEOUT_MS = 5_000;

const signInFields = {
  clientId: connectionsFields.clientId,
  hostId: connectionsFields.hostId,
  email: connectionsFields.email,
  scopes: connectionsFields.scopes,
  expiresAt: connectionsFields.expiresAt,
};
const statusFields = {
  type: connectionsFields.type,
  ...signInFields,
  updatedAt: connectionsFields.updatedAt,
};
export const statusValidator = v.object(statusFields);
const secretFields = {
  accessToken: v.string(),
  refreshToken: v.string(),
};
const storedValidator = v.object({ ...statusFields, ...secretFields });
const secretsValidator = v.object(secretFields);
const ref = { accountId: v.id("accounts"), type: connectionsFields.type };

export type ConnectionStatus = Infer<typeof statusValidator>;
export type StoredConnection = Infer<typeof storedValidator>;
type ConnectionSecrets = Infer<typeof secretsValidator>;

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(statusValidator),
  handler: async (ctx, args): Promise<ConnectionStatus[]> => {
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_accountId_and_type", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();

    return rows.map((row) => statusOf(row));
  },
});

export const status = internalQuery({
  args: ref,
  returns: v.union(v.null(), statusValidator),
  handler: async (ctx, args): Promise<ConnectionStatus | null> => {
    const row = await findRow(ctx, args.accountId, args.type);

    return row ? statusOf(row) : null;
  },
});

export const load = internalQuery({
  args: ref,
  returns: v.union(v.null(), storedValidator),
  handler: async (ctx, args): Promise<StoredConnection | null> => {
    const row = await findRow(ctx, args.accountId, args.type);
    if (!row) return null;

    return {
      ...statusOf(row),
      ...(await decryptSecrets(await accountCipher(ctx, row.accountId), row)),
    };
  },
});

export const set = internalMutation({
  args: { ...ref, ...signInFields, ...secretFields },
  returns: statusValidator,
  handler: async (ctx, args): Promise<ConnectionStatus> => {
    const { accessToken, refreshToken, ...metadata } = args;
    const fields = {
      ...metadata,
      ...(await encryptSecrets(
        await accountCipherForWrite(ctx, args.accountId),
        { accessToken: accessToken, refreshToken: refreshToken },
      )),
      updatedAt: Date.now(),
    };
    const existing = await findRow(ctx, args.accountId, args.type);
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("connections", fields);

    return statusOf(fields);
  },
});

// A sign-in or disconnect since core loaded the row wins over this refresh.
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
    const row = await findRow(ctx, args.accountId, args.type);
    if (!row || row.updatedAt !== args.loadedUpdatedAt) return false;
    await ctx.db.patch(row._id, {
      ...(await encryptSecrets(
        await accountCipherForWrite(ctx, args.accountId),
        { accessToken: args.accessToken, refreshToken: args.refreshToken },
      )),
      expiresAt: args.expiresAt,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const disconnect = internalMutation({
  args: ref,
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.accountId, args.type);
    if (!row) return false;
    await ctx.db.delete(row._id);
    const revokeUrl = CONNECTION_TYPES[row.type].revokeUrl;
    // The secrets stay encrypted in the scheduler; the action decrypts them.
    if (revokeUrl) {
      await ctx.scheduler.runAfter(0, internal.account.connections.revoke, {
        accountId: row.accountId,
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

// Best effort: the row is already gone, and the user can end the grant at the provider.
export const revoke = internalAction({
  args: {
    accountId: v.id("accounts"),
    revokeUrl: v.string(),
    clientId: v.string(),
    ciphertext: connectionsFields.ciphertext,
    iv: connectionsFields.iv,
    tag: connectionsFields.tag,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const secrets = await decryptSecrets(
        await accountCipherForAction(ctx, args.accountId, "read"),
        args,
      );
      const response = await fetch(args.revokeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: secrets.refreshToken,
          token_type_hint: "refresh_token",
          client_id: args.clientId,
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

async function decryptSecrets(
  cipher: AccountCipher,
  blob: EncryptedBlob,
): Promise<ConnectionSecrets> {
  const secrets = await cipher.decrypt("connections:ciphertext", blob);
  if (
    typeof secrets?.accessToken !== "string" ||
    typeof secrets.refreshToken !== "string"
  ) {
    throw new Error("Failed to decrypt a connection");
  }

  return {
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
  };
}

async function encryptSecrets(
  cipher: AccountCipher,
  secrets: ConnectionSecrets,
): Promise<EncryptedBlob> {
  return await cipher.encrypt("connections:ciphertext", {
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
  });
}

async function findRow(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  type: ConnectionType,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_accountId_and_type", (q) =>
      q.eq("accountId", accountId).eq("type", type),
    )
    .unique();
}

function statusOf(
  row: Omit<Doc<"connections">, "_id" | "_creationTime">,
): ConnectionStatus {
  return {
    type: row.type,
    clientId: row.clientId,
    hostId: row.hostId,
    ...(row.email !== undefined ? { email: row.email } : {}),
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

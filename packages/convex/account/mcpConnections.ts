import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { accountCipher, accountCipherForWrite } from "../model/accountKeys";
import type { AccountCipher, EncryptedBlob } from "../model/envelope";

const CIPHER_PURPOSE = "mcpConnections:ciphertext";

const ref = { accountId: v.id("accounts"), serverId: v.id("mcp") };
const secretFields = {
  accessToken: v.string(),
  refreshToken: v.string(),
  clientSecret: v.optional(v.string()),
};
const storedValidator = v.object({
  clientId: v.string(),
  tokenUrl: v.string(),
  resource: v.string(),
  expiresAt: v.number(),
  updatedAt: v.number(),
  ...secretFields,
});
const secretsValidator = v.object(secretFields);

type McpConnectionSecrets = Infer<typeof secretsValidator>;
export type StoredMcpConnection = Infer<typeof storedValidator>;

export const load = internalQuery({
  args: ref,
  returns: v.union(v.null(), storedValidator),
  handler: async (ctx, args): Promise<StoredMcpConnection | null> => {
    const row = await findRow(ctx, args.serverId);
    if (!row || row.accountId !== args.accountId) return null;
    const cipher = await accountCipher(ctx, row.accountId);

    return {
      clientId: row.clientId,
      tokenUrl: row.tokenUrl,
      resource: row.resource,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
      ...((await cipher.decrypt(CIPHER_PURPOSE, row)) as McpConnectionSecrets),
    };
  },
});

export const set = internalMutation({
  args: {
    ...ref,
    clientId: v.string(),
    tokenUrl: v.string(),
    resource: v.string(),
    expiresAt: v.number(),
    ...secretFields,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { accessToken, refreshToken, clientSecret, ...metadata } = args;
    const server = await ctx.db.get(args.serverId);
    if (server?.accountId !== args.accountId) return null;
    const fields = {
      ...metadata,
      ...(await encryptSecrets(
        await accountCipherForWrite(ctx, args.accountId),
        {
          accessToken: accessToken,
          refreshToken: refreshToken,
          ...(clientSecret !== undefined ? { clientSecret: clientSecret } : {}),
        },
      )),
      updatedAt: Date.now(),
    };
    const existing = await findRow(ctx, args.serverId);
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("mcpConnections", fields);
    await ctx.db.patch(args.serverId, { connected: true });

    return null;
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
    clientSecret: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await findRow(ctx, args.serverId);
    if (
      !row ||
      row.accountId !== args.accountId ||
      row.updatedAt !== args.loadedUpdatedAt
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      ...(await encryptSecrets(
        await accountCipherForWrite(ctx, args.accountId),
        {
          accessToken: args.accessToken,
          refreshToken: args.refreshToken,
          ...(args.clientSecret !== undefined
            ? { clientSecret: args.clientSecret }
            : {}),
        },
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
    const server = await ctx.db.get(args.serverId);
    if (server?.accountId !== args.accountId) return false;

    return await dropMcpConnection(ctx, args.serverId);
  },
});

/** Tokens are bound to one URL, so every path that repoints or removes a server calls this. */
export async function dropMcpConnection(
  ctx: MutationCtx,
  serverId: Id<"mcp">,
): Promise<boolean> {
  const row = await findRow(ctx, serverId);
  if (row) await ctx.db.delete(row._id);
  await ctx.db.patch(serverId, { connected: undefined });

  return row !== null;
}

async function encryptSecrets(
  cipher: AccountCipher,
  secrets: McpConnectionSecrets,
): Promise<EncryptedBlob> {
  return await cipher.encrypt(CIPHER_PURPOSE, secrets);
}

async function findRow(
  ctx: QueryCtx | MutationCtx,
  serverId: Id<"mcp">,
): Promise<Doc<"mcpConnections"> | null> {
  return await ctx.db
    .query("mcpConnections")
    .withIndex("by_serverId", (q) => q.eq("serverId", serverId))
    .unique();
}

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import {
  accountCipher,
  encryptionSecrets,
  ensureWrappedKeys,
  listWrappedKeys,
  mintKey,
  reencryptBatch,
  reencryptWalkArgs,
} from "../model/accountKeys";
import { rewrapAccountKey, type WrappedAccountKey } from "../model/envelope";

const wrappedKeyValidator = v.object({
  keyId: v.string(),
  kekId: v.string(),
  wrappedKey: v.string(),
  retiredAt: v.optional(v.number()),
});

export const ensure = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.array(wrappedKeyValidator),
  handler: async (ctx, args): Promise<WrappedAccountKey[]> => {
    return await ensureWrappedKeys(ctx, args.accountId);
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(wrappedKeyValidator),
  handler: async (ctx, args): Promise<WrappedAccountKey[]> => {
    return await listWrappedKeys(ctx, args.accountId);
  },
});

// Operator runbook, KEK step two: drop the old secret once no row carries its `kekId`.
export const rewrapAllKeys = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ rewrapped: v.number(), isDone: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ rewrapped: number; isDone: boolean }> => {
    const secrets = encryptionSecrets();
    const page = await ctx.db
      .query("accountKeys")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    let rewrapped = 0;
    for (const row of page.page) {
      const next = await rewrapAccountKey(row.accountId, secrets, row);
      if (!next) continue;
      await ctx.db.patch(row._id, next);
      rewrapped += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.account.keys.rewrapAllKeys, {
        cursor: page.continueCursor,
      });
    }

    return { rewrapped: rewrapped, isDone: page.isDone };
  },
});

// Operator runbook (`bunx convex run`): pass only `accountId`; re-running resumes the walk.
export const rotateAccountKey = internalMutation({
  args: {
    accountId: v.id("accounts"),
    ...reencryptWalkArgs,
    target: v.optional(v.string()),
  },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    // Two live keys: a rotation is mid-walk, and a third would let it retire a key this needs.
    if (args.table === undefined && (await liveKeys(ctx, args.accountId)) < 2) {
      await mintKey(ctx, args.accountId);
    }
    const current = (await accountCipher(ctx, args.accountId)).keyId;
    const target = args.target ?? current ?? undefined;
    const batch = await reencryptBatch(ctx, args);
    if (batch.next) {
      await ctx.scheduler.runAfter(0, internal.account.keys.rotateAccountKey, {
        accountId: args.accountId,
        target: target,
        ...batch.next,
      });

      return { patched: batch.patched, isDone: false };
    }
    // A newer key means a later rotation began; its own walk retires what it replaces.
    if (current === target) await retireOlderKeys(ctx, args.accountId);

    return { patched: batch.patched, isDone: true };
  },
});

async function liveKeys(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<number> {
  const keys = await listWrappedKeys(ctx, accountId);

  return keys.filter((key) => key.retiredAt === undefined).length;
}

async function retireOlderKeys(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const rows = await ctx.db
    .query("accountKeys")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();
  const live = rows.filter((row) => row.retiredAt === undefined);
  const now = Date.now();
  for (const row of live.slice(0, -1)) {
    await ctx.db.patch(row._id, { retiredAt: now });
  }
}

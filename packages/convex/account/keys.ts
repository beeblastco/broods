/**
 * Internal functions over `accountKeys`: the wrapped key list core and the
 * HTTP actions read, plus the two operator runbook entries, `rotateAccountKey`
 * and `rewrapAllKeys`. Neither has a UI; run them with `bunx convex run`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import {
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

/** The account's keys, minting the first when it has none. For actions, which cannot read `ctx.db`. */
export const ensure = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.array(wrappedKeyValidator),
  handler: async (ctx, args): Promise<WrappedAccountKey[]> => {
    return await ensureWrappedKeys(ctx, args.accountId);
  },
});

/** The account's keys as stored. Core unwraps them in process and caches the result. */
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(wrappedKeyValidator),
  handler: async (ctx, args): Promise<WrappedAccountKey[]> => {
    return await listWrappedKeys(ctx, args.accountId);
  },
});

/**
 * KEK rotation step two: rewrap every account key under the first secret in
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET`. Paginated with a self-reschedule and
 * idempotent. Drop the old secret only once no row carries its `kekId`.
 * @returns keys rewrapped in this batch and whether this batch was the last
 */
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

/**
 * DEK rotation for one account: mints a new key (every write from now on
 * uses it), rewrites every blob of the account under it table by table in
 * bounded batches, then retires the older keys. Call it with only
 * `accountId`; the other arguments are the walk's own continuation. Calling
 * it again before it finishes, or after a batch failed, resumes that rotation.
 * @returns rows rewritten in this batch and whether the rotation finished
 */
export const rotateAccountKey = internalMutation({
  args: { accountId: v.id("accounts"), ...reencryptWalkArgs },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    // Two live keys mean a rotation is already walking or stopped midway.
    // Minting a third would let the first walk retire a key the second needs.
    if (args.table === undefined && (await liveKeys(ctx, args.accountId)) < 2) {
      await mintKey(ctx, args.accountId);
    }
    const batch = await reencryptBatch(ctx, args);
    if (batch.next) {
      await ctx.scheduler.runAfter(0, internal.account.keys.rotateAccountKey, {
        accountId: args.accountId,
        ...batch.next,
      });

      return { patched: batch.patched, isDone: false };
    }
    await retireOlderKeys(ctx, args.accountId);

    return { patched: batch.patched, isDone: true };
  },
});

/** How many of the account's keys still open blobs. */
async function liveKeys(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<number> {
  const keys = await listWrappedKeys(ctx, accountId);

  return keys.filter((key) => key.retiredAt === undefined).length;
}

/** Every key but the newest live one stops opening blobs. */
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

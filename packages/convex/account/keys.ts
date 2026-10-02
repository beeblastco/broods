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
  ENVELOPE_TABLES,
  type EnvelopeTable,
  encryptionSecrets,
  ensureWrappedKeys,
  listWrappedKeys,
  reencryptBatch,
} from "../model/accountKeys";
import {
  createWrappedAccountKey,
  rewrapAccountKey,
  type WrappedAccountKey,
} from "../model/envelope";

const wrappedKeyValidator = v.object({
  keyId: v.string(),
  kekId: v.string(),
  wrappedKey: v.string(),
  retiredAt: v.optional(v.number()),
});

const envelopeTableValidator = v.union(
  ...ENVELOPE_TABLES.map((table) => v.literal(table)),
);

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
 * idempotent, so run it until it reports `isDone` and then drop the old
 * secret from the list.
 * @returns keys rewrapped in this batch and whether the walk finished
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
      if (next.kekId === row.kekId) continue;
      await ctx.db.patch(row._id, {
        kekId: next.kekId,
        wrappedKey: next.wrappedKey,
      });
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
 * `accountId`; the other arguments are the walk's own continuation.
 * @returns rows rewritten in this batch and whether the rotation finished
 */
export const rotateAccountKey = internalMutation({
  args: {
    accountId: v.id("accounts"),
    table: v.optional(envelopeTableValidator),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    if (args.table === undefined) await mintKey(ctx, args.accountId);
    const table: EnvelopeTable = args.table ?? ENVELOPE_TABLES[0];
    const batch = await reencryptBatch(ctx, {
      table: table,
      cursor: args.cursor ?? null,
      accountId: args.accountId,
    });
    const next = nextStep(table, batch);
    if (next) {
      await ctx.scheduler.runAfter(0, internal.account.keys.rotateAccountKey, {
        accountId: args.accountId,
        ...next,
      });

      return { patched: batch.patched, isDone: false };
    }
    await retireOlderKeys(ctx, args.accountId);

    return { patched: batch.patched, isDone: true };
  },
});

/** The walk's next `{table, cursor}`, or null once the last table is done. */
export function nextStep(
  table: EnvelopeTable,
  batch: { isDone: boolean; continueCursor: string },
): { table: EnvelopeTable; cursor: string | null } | null {
  if (!batch.isDone) return { table: table, cursor: batch.continueCursor };
  const following = ENVELOPE_TABLES[ENVELOPE_TABLES.indexOf(table) + 1];

  return following ? { table: following, cursor: null } : null;
}

async function mintKey(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const created = await createWrappedAccountKey(accountId, encryptionSecrets());
  await ctx.db.insert("accountKeys", {
    ...created,
    accountId: accountId,
    createdAt: Date.now(),
  });
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

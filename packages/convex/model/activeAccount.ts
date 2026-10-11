/**
 * Account guards for writes made on behalf of one account: runtime writes
 * from core (runtime keys embed it as `acct:<accountId>:...`) and the
 * dashboard's direct writes, uploads and compute calls.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** @throws when the key has no `acct:<id>:` prefix. */
export function accountIdFromKey(value: string): string {
  const match = /^acct:([^:]+):/.exec(value);
  if (!match?.[1]) throw new Error("Runtime key is not account scoped");

  return match[1];
}

/** @throws when the account is missing or disabled. */
export async function requireActiveAccount(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const account = await ctx.db.get(accountId);
  if (!account || account.status !== "active") {
    throw new Error(`Account is not active: ${accountId}`);
  }
}

/**
 * @throws when the org's account is disabled. An org with no account yet has
 * nothing to suspend.
 */
export async function requireActiveOrgAccount(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<void> {
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();
  if (account) await requireActiveAccount(ctx, account._id);
}

/**
 * The active account a runtime key belongs to.
 * @throws when the key is unscoped or its account is missing or disabled.
 */
export async function requireActiveKeyAccount(
  ctx: MutationCtx,
  key: string,
): Promise<Id<"accounts">> {
  const raw = accountIdFromKey(key);
  const accountId = ctx.db.normalizeId("accounts", raw);
  if (!accountId) throw new Error(`Account is not active: ${raw}`);
  await requireActiveAccount(ctx, accountId);

  return accountId;
}

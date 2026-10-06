/**
 * Account guards for runtime writes, which core makes on behalf of one
 * account. Runtime keys embed it as `acct:<accountId>:...`.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** @throws when the key has no `acct:<id>:` prefix. */
export function accountIdFromKey(value: string): string {
  const match = /^acct:([^:]+):/.exec(value);
  if (!match?.[1]) throw new Error("Runtime key is not account scoped");

  return match[1];
}

/** @throws when the account is missing or disabled. */
export async function requireActiveAccount(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const account = await ctx.db.get(accountId);
  if (!account || account.status !== "active") {
    throw new Error(`Account is not active: ${accountId}`);
  }
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

/**
 * Core's side of envelope encryption: reads an account's wrapped keys from
 * the config plane, unwraps them with the local KEK secrets and keeps the
 * keyring for a few minutes, so decrypting a stored config costs one Convex
 * read per account per window instead of one per row. The codec is
 * `@broods/convex/model/envelope`, the one copy both sides share.
 */

import type { FunctionReference } from "convex/server";
import {
  AccountCipher,
  type BlobScope,
  type EncryptedBlob,
  parseEncryptionSecrets,
  type WrappedAccountKey,
} from "@broods/convex/model/envelope";
import { requireEnv } from "../env.ts";
import { getConvexClient } from "./client.ts";

const KEYRING_TTL_MS = 5 * 60_000;

/** Fetches an account's wrapped keys; swapped out by tests. */
type WrappedKeyLoader = (accountId: string) => Promise<WrappedAccountKey[]>;

interface CachedKeyring {
  cipher: AccountCipher;
  expiresAt: number;
}

// Same boundary as storage.ts: the backend registers this as an internal
// query, which the deploy key may call, and require() keeps its generated
// types out of this package's typecheck. Only the args and result are typed.
const listAccountKeys: FunctionReference<
  "query",
  "public",
  { accountId: string },
  WrappedAccountKey[]
> = require("@broods/convex/_generated/api").internal.account.keys.list;

const keyrings = new Map<string, CachedKeyring>();
let loader: WrappedKeyLoader = loadFromConvex;

/**
 * Decrypts one stored blob of `accountId`. A blob under a key the cached
 * keyring has not seen (a rotation since the last read) refreshes it once.
 * @throws when the blob does not decrypt under any key the account holds
 */
export async function decryptAccountBlob(
  accountId: string,
  scope: BlobScope,
  blob: EncryptedBlob,
): Promise<Record<string, unknown>> {
  let cipher = await keyringFor(accountId);
  if (!cipher.hasKey(blob)) {
    keyrings.delete(accountId);
    cipher = await keyringFor(accountId);
  }
  const value = await cipher.decrypt(scope, blob);
  if (!value) {
    throw new Error(`Stored ${scope} of account ${accountId} does not decrypt`);
  }

  return value;
}

/** Drops every cached keyring and restores the Convex loader. */
export function resetAccountKeysForTests(
  loaderOverride?: WrappedKeyLoader,
): void {
  keyrings.clear();
  loader = loaderOverride ?? loadFromConvex;
}

async function keyringFor(accountId: string): Promise<AccountCipher> {
  const cached = keyrings.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.cipher;
  const cipher = new AccountCipher(
    accountId,
    parseEncryptionSecrets(requireEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET")),
    await loader(accountId),
  );
  keyrings.set(accountId, {
    cipher: cipher,
    expiresAt: Date.now() + KEYRING_TTL_MS,
  });

  return cipher;
}

function loadFromConvex(accountId: string): Promise<WrappedAccountKey[]> {
  return getConvexClient().query(listAccountKeys, { accountId: accountId });
}

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
  blobKeyId,
  type BlobScope,
  type EncryptedBlob,
  type WrappedAccountKey,
} from "@broods/convex/model/envelope";
import { requireEnv, requireSecretsEnv } from "../env.ts";
import { NODE_CRYPTO } from "../node-aead.ts";
import { getConvexClient } from "./client.ts";

const KEYRING_TTL_MS = 5 * 60_000;
const SECRETS_ENV = "ACCOUNT_CONFIG_ENCRYPTION_SECRET";

/** Fetches an account's wrapped keys; swapped out by tests. */
type WrappedKeyLoader = (accountId: string) => Promise<WrappedAccountKey[]>;

/** The promise is cached, not its result, so concurrent decrypts share one load. */
interface CachedKeyring {
  cipher: Promise<AccountCipher>;
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
 * A legacy blob needs no keyring, so core can roll out before the backend
 * that serves the key list.
 * @throws when the blob does not decrypt under any key the account holds
 */
export async function decryptAccountBlob(
  accountId: string,
  scope: BlobScope,
  blob: EncryptedBlob,
): Promise<Record<string, unknown>> {
  const cipher =
    blobKeyId(blob) === null
      ? cipherFromKeys(accountId, [])
      : await keyringHolding(accountId, blob);
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

/** A keyring over `keys` on `node:crypto`, under this process's secrets, legacy blobs included. */
function cipherFromKeys(
  accountId: string,
  keys: WrappedAccountKey[],
): AccountCipher {
  return new AccountCipher(accountId, requireSecretsEnv(SECRETS_ENV), keys, {
    rawSecret: requireEnv(SECRETS_ENV),
    primitive: NODE_CRYPTO,
  });
}

/** The cached entry for the account, loading its keys when there is none or it expired. */
function keyringFor(accountId: string): CachedKeyring {
  const cached = keyrings.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const cipher = loader(accountId).then((keys): AccountCipher =>
    cipherFromKeys(accountId, keys),
  );
  const entry: CachedKeyring = {
    cipher: cipher,
    expiresAt: Date.now() + KEYRING_TTL_MS,
  };
  keyrings.set(accountId, entry);
  // A failed load is not kept for the whole window.
  cipher.catch((): void => {
    if (keyrings.get(accountId) === entry) keyrings.delete(accountId);
  });

  return entry;
}

/** The account's keyring, reloaded once when `blob` names a key the cached one has not seen. */
async function keyringHolding(
  accountId: string,
  blob: EncryptedBlob,
): Promise<AccountCipher> {
  const cached = keyringFor(accountId);
  const cipher = await cached.cipher;
  if (cipher.hasKey(blob)) return cipher;
  // Rows decrypted together share one reload: only the first drops the stale entry.
  if (keyrings.get(accountId) === cached) keyrings.delete(accountId);

  return await keyringFor(accountId).cipher;
}

function loadFromConvex(accountId: string): Promise<WrappedAccountKey[]> {
  return getConvexClient().query(listAccountKeys, { accountId: accountId });
}

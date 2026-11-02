import {
  AccountCipher,
  type BlobScope,
  type EncryptedBlob,
  type WrappedAccountKey,
} from "@broods/convex/model/envelope";
import { requireSecretsEnv } from "../env.ts";
import { NODE_CRYPTO } from "../node-aead.ts";
import { adminQuery, internal } from "./client.ts";

const KEYRING_TTL_MS = 5 * 60_000;
const SECRETS_ENV = "ACCOUNT_CONFIG_ENCRYPTION_SECRET";

type WrappedKeyLoader = (accountId: string) => Promise<WrappedAccountKey[]>;

// The promise is cached, not its result, so concurrent decrypts share one load.
interface CachedKeyring {
  cipher: Promise<AccountCipher>;
  expiresAt: number;
}

const keyrings = new Map<string, CachedKeyring>();
let loader: WrappedKeyLoader = loadFromConvex;

export async function decryptAccountBlob(
  accountId: string,
  scope: BlobScope,
  blob: EncryptedBlob,
): Promise<Record<string, unknown>> {
  const cipher = await keyringHolding(accountId, blob);
  const value = await cipher.decrypt(scope, blob);
  if (!value) {
    throw new Error(`Stored ${scope} of account ${accountId} does not decrypt`);
  }

  return value;
}

export function resetAccountKeysForTests(
  loaderOverride?: WrappedKeyLoader,
): void {
  keyrings.clear();
  loader = loaderOverride ?? loadFromConvex;
}

function cipherFromKeys(
  accountId: string,
  keys: WrappedAccountKey[],
): AccountCipher {
  return new AccountCipher(accountId, requireSecretsEnv(SECRETS_ENV), keys, {
    primitive: NODE_CRYPTO,
  });
}

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
  cipher.catch((): void => {
    if (keyrings.get(accountId) === entry) keyrings.delete(accountId);
  });

  return entry;
}

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
  return adminQuery(internal.account.keys.list, { accountId: accountId });
}

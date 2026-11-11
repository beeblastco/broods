import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  AccountCipher,
  createWrappedAccountKey,
  type BlobScope,
  type EncryptedBlob,
  type WrappedAccountKey,
} from "../../../../packages/convex/model/envelope.ts";
import {
  decryptAccountBlob,
  resetAccountKeysForTests,
} from "../../../../apps/core/src/shared/convex/account-keys.ts";

const SECRET = "keyring-sequence-secret";
const SCOPE: BlobScope = "agents:encryptedConfig";
const ACCOUNTS = ["acct_a", "acct_b", "acct_c"];

let keysByAccount: Map<string, WrappedAccountKey[]>;
let loadsByAccount: Map<string, number>;

beforeEach(async (): Promise<void> => {
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = SECRET;
  keysByAccount = new Map();
  loadsByAccount = new Map();
  for (const account of ACCOUNTS) {
    keysByAccount.set(account, [
      await createWrappedAccountKey(account, [SECRET]),
    ]);
  }
  resetAccountKeysForTests(
    async (accountId: string): Promise<WrappedAccountKey[]> => {
      loadsByAccount.set(accountId, (loadsByAccount.get(accountId) ?? 0) + 1);

      return keysByAccount.get(accountId) ?? [];
    },
  );
});

afterEach((): void => {
  setSystemTime();
  resetAccountKeysForTests();
});

test("each account keeps its own keyring across rows decrypted one after another", async () => {
  for (const account of ACCOUNTS) {
    const blob = await seal(account, { owner: account });

    for (let row = 0; row < 3; row += 1) {
      expect(await decryptAccountBlob(account, SCOPE, blob)).toEqual({
        owner: account,
      });
    }
  }

  expect([...loadsByAccount.values()]).toEqual([1, 1, 1]);
});

test("a row under a rotated key reloads the keyring once and later rows reuse it", async () => {
  const account = "acct_a";
  const old = await seal(account, { generation: "old" });
  expect(await decryptAccountBlob(account, SCOPE, old)).toEqual({
    generation: "old",
  });

  const rotated = await createWrappedAccountKey(account, [SECRET]);
  keysByAccount.set(account, [rotated]);
  const fresh = await sealWith(account, [rotated], { generation: "new" });
  for (let row = 0; row < 3; row += 1) {
    expect(await decryptAccountBlob(account, SCOPE, fresh)).toEqual({
      generation: "new",
    });
  }

  expect(loadsByAccount.get(account)).toBe(2);
});

test("an expired keyring is loaded again for the next row", async () => {
  const account = "acct_b";
  const blob = await seal(account, { owner: account });
  await decryptAccountBlob(account, SCOPE, blob);

  setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
  expect(await decryptAccountBlob(account, SCOPE, blob)).toEqual({
    owner: account,
  });
  expect(await decryptAccountBlob(account, SCOPE, blob)).toEqual({
    owner: account,
  });

  expect(loadsByAccount.get(account)).toBe(2);
});

async function seal(
  account: string,
  value: Record<string, unknown>,
): Promise<EncryptedBlob> {
  return await sealWith(account, keysByAccount.get(account) ?? [], value);
}

async function sealWith(
  account: string,
  keys: WrappedAccountKey[],
  value: Record<string, unknown>,
): Promise<EncryptedBlob> {
  return await new AccountCipher(account, [SECRET], keys).encrypt(SCOPE, value);
}

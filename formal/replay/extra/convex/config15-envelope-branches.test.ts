import { describe, expect, test } from "bun:test";

import {
  AccountCipher,
  createWrappedAccountKey,
  kekIdOf,
  type WrappedAccountKey,
} from "../../../../packages/convex/model/envelope";

const SECRET = "envelope-branch-secret";
const SCOPE = "agents:encryptedConfig" as const;
describe("AccountCipher without a live key", (): void => {
  test("encrypt and digest refuse", async (): Promise<void> => {
    const cipher = new AccountCipher("acct_a", [SECRET], []);

    await expect(cipher.encrypt(SCOPE, { a: 1 })).rejects.toThrow(
      "Account acct_a has no live encryption key",
    );
    await expect(cipher.digest("x")).rejects.toThrow(
      "Account acct_a has no live encryption key",
    );
  });
});

describe("AccountCipher key lookup", (): void => {
  test("a blob sealed by an unknown key decrypts to null", async (): Promise<void> => {
    const wrapped = await createWrappedAccountKey("acct_a", [SECRET]);
    const cipher = new AccountCipher("acct_a", [SECRET], [wrapped]);
    const blob = await cipher.encrypt(SCOPE, { a: 1 });
    const other = new AccountCipher(
      "acct_a",
      [SECRET],
      [await createWrappedAccountKey("acct_a", [SECRET])],
    );

    expect(await other.decrypt(SCOPE, blob)).toBeNull();
  });

  test("a wrapped key without an iv and sealed part is malformed", async (): Promise<void> => {
    const kekId = await kekIdOf(SECRET);
    const broken: WrappedAccountKey = {
      keyId: "k1",
      kekId: kekId,
      wrappedKey: "nodot",
    };
    const cipher = new AccountCipher("acct_a", [SECRET], [broken]);

    await expect(cipher.digest("x")).rejects.toThrow(
      "Malformed wrapped account key",
    );
  });
});

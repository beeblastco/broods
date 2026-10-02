import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  setSystemTime,
} from "bun:test";
import {
  AccountCipher,
  createWrappedAccountKey,
  type WrappedAccountKey,
} from "@broods/convex/model/envelope";
import {
  decryptAccountBlob,
  resetAccountKeysForTests,
} from "../src/shared/convex/account-keys.ts";

const SECRET = "core-test-secret";
const ACCOUNT = "acct_core";
const VALUE = { model: { provider: "deepseek" } };

describe("account key cache", () => {
  let keys: WrappedAccountKey[];
  let loads = 0;

  beforeEach(async () => {
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = SECRET;
    keys = [await createWrappedAccountKey(ACCOUNT, [SECRET])];
    loads = 0;
    resetAccountKeysForTests(async () => {
      loads += 1;

      return keys;
    });
  });

  afterEach(() => {
    setSystemTime();
    resetAccountKeysForTests();
  });

  test("loads an account's keys once and keeps them for five minutes", async () => {
    const blob = await new AccountCipher(ACCOUNT, [SECRET], keys).encrypt(
      "agents:encryptedConfig",
      VALUE,
    );

    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", blob),
    ).toEqual(VALUE);
    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", blob),
    ).toEqual(VALUE);
    expect(loads).toBe(1);

    setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", blob),
    ).toEqual(VALUE);
    expect(loads).toBe(2);
  });

  test("a blob under a key it has not seen refreshes the keyring once", async () => {
    const stale = await new AccountCipher(ACCOUNT, [SECRET], keys).encrypt(
      "agents:encryptedConfig",
      VALUE,
    );
    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", stale),
    ).toEqual(VALUE);

    // A rotation happened in the config plane: the row now names a new key.
    const rotated = await createWrappedAccountKey(ACCOUNT, [SECRET]);
    const fresh = await new AccountCipher(ACCOUNT, [SECRET], [rotated]).encrypt(
      "agents:encryptedConfig",
      VALUE,
    );
    keys = [{ ...keys[0]!, retiredAt: Date.now() }, rotated];

    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", fresh),
    ).toEqual(VALUE);
    expect(loads).toBe(2);
    await expect(
      decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", stale),
    ).rejects.toThrow("does not decrypt");
  });

  test("refuses a blob bound to another column", async () => {
    const blob = await new AccountCipher(ACCOUNT, [SECRET], keys).encrypt(
      "sandboxConfigs:encryptedConfig",
      VALUE,
    );

    await expect(
      decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", blob),
    ).rejects.toThrow("does not decrypt");
  });
});

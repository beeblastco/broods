import { describe, expect, test } from "vitest";
import {
  AccountCipher,
  createWrappedAccountKey,
  kekIdOf,
  rewrapAccountKey,
  type WrappedAccountKey,
} from "../model/envelope";

const ACCOUNT = "acct_one";
const OTHER_ACCOUNT = "acct_two";
const SECRETS = ["secret-a"];
const VALUE = { apiKey: "sk-live-123", nested: { n: 1 } };

async function cipherWith(
  secrets: string[],
  keys?: WrappedAccountKey[],
): Promise<{ cipher: AccountCipher; keys: WrappedAccountKey[] }> {
  const list = keys ?? [await createWrappedAccountKey(ACCOUNT, secrets)];

  return { cipher: new AccountCipher(ACCOUNT, secrets, list), keys: list };
}

describe("envelope codec", () => {
  test("round-trips under the account key and names it in the blob", async () => {
    const { cipher, keys } = await cipherWith(SECRETS);
    const blob = await cipher.encrypt("agents:encryptedConfig", VALUE);

    expect(blob.ciphertext.startsWith(`v2:${keys[0]!.keyId}:`)).toBe(true);
    expect(cipher.needsRewrite(blob)).toBe(false);
    expect(await cipher.decrypt("agents:encryptedConfig", blob)).toEqual(VALUE);
  });

  test("refuses a blob moved to another column or tenant", async () => {
    const { cipher, keys } = await cipherWith(SECRETS);
    const blob = await cipher.encrypt("agents:encryptedConfig", VALUE);
    const otherTenant = new AccountCipher(OTHER_ACCOUNT, SECRETS, keys);

    expect(
      await cipher.decrypt("agents:encryptedSourceConfig", blob),
    ).toBeNull();
    expect(
      await otherTenant.decrypt("agents:encryptedConfig", blob),
    ).toBeNull();
  });

  test("refuses a blob without a v2 key id", async () => {
    const { cipher, keys } = await cipherWith(SECRETS);
    const blob = await cipher.encrypt("agents:encryptedConfig", VALUE);
    const bare = {
      ...blob,
      ciphertext: blob.ciphertext.slice(`v2:${keys[0]!.keyId}:`.length),
    };

    expect(cipher.hasKey(bare)).toBe(false);
    expect(cipher.needsRewrite(bare)).toBe(true);
    expect(await cipher.decrypt("agents:encryptedConfig", bare)).toBeNull();
  });

  test("a KEK list unwraps under any entry and rewraps under the first", async () => {
    const { keys } = await cipherWith(["kek-old"]);
    const blob = await new AccountCipher(ACCOUNT, ["kek-old"], keys).encrypt(
      "connections:ciphertext",
      VALUE,
    );
    const rotated = new AccountCipher(ACCOUNT, ["kek-new", "kek-old"], keys);
    expect(await rotated.decrypt("connections:ciphertext", blob)).toEqual(
      VALUE,
    );

    const patch = await rewrapAccountKey(
      ACCOUNT,
      ["kek-new", "kek-old"],
      keys[0]!,
    );
    const rewrapped = { ...keys[0]!, ...patch };
    expect(rewrapped.kekId).toBe(await kekIdOf("kek-new"));
    expect(
      await rewrapAccountKey(ACCOUNT, ["kek-new", "kek-old"], rewrapped),
    ).toBeNull();
    expect(
      await new AccountCipher(ACCOUNT, ["kek-new"], [rewrapped]).decrypt(
        "connections:ciphertext",
        blob,
      ),
    ).toEqual(VALUE);
    expect(
      await new AccountCipher(ACCOUNT, ["kek-old"], [rewrapped]).decrypt(
        "connections:ciphertext",
        blob,
      ),
    ).toBeNull();
  });

  test("an older key keeps opening blobs until it is retired", async () => {
    const oldKey = await createWrappedAccountKey(ACCOUNT, SECRETS);
    const blob = await new AccountCipher(ACCOUNT, SECRETS, [oldKey]).encrypt(
      "accountEnvVars:ciphertext",
      VALUE,
    );
    const newKey = await createWrappedAccountKey(ACCOUNT, SECRETS);
    const live = new AccountCipher(ACCOUNT, SECRETS, [oldKey, newKey]);
    expect(live.keyId).toBe(newKey.keyId);
    expect(live.needsRewrite(blob)).toBe(true);
    expect(await live.decrypt("accountEnvVars:ciphertext", blob)).toEqual(
      VALUE,
    );

    const retired = new AccountCipher(ACCOUNT, SECRETS, [
      { ...oldKey, retiredAt: Date.now() },
      newKey,
    ]);
    expect(retired.hasKey(blob)).toBe(true);
    expect(await retired.decrypt("accountEnvVars:ciphertext", blob)).toBeNull();
  });

  test("digests are keyed per account", async () => {
    const { cipher, keys } = await cipherWith(SECRETS);
    const other = new AccountCipher(OTHER_ACCOUNT, SECRETS, [
      await createWrappedAccountKey(OTHER_ACCOUNT, SECRETS),
    ]);

    expect(await cipher.digest("hunter2")).toBe(await cipher.digest("hunter2"));
    expect(await cipher.digest("hunter2")).not.toBe(
      await other.digest("hunter2"),
    );
    expect(keys[0]!.wrappedKey).not.toContain(await cipher.digest("hunter2"));
  });
});

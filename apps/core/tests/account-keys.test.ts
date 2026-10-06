import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  setSystemTime,
} from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  AccountCipher,
  createWrappedAccountKey,
  type WrappedAccountKey,
} from "@broods/convex/model/envelope";
import {
  decryptAccountBlob,
  resetAccountKeysForTests,
} from "../src/shared/convex/account-keys.ts";
import { NODE_CRYPTO } from "../src/shared/node-aead.ts";

const SECRET = "core-test-secret";
const ACCOUNT = "acct_core";
const VALUE = { model: { provider: "deepseek" } };

describe("node:crypto and Web Crypto primitives", () => {
  test("a blob sealed by either opens with the other, and both refuse another column", async () => {
    const keys = [await createWrappedAccountKey(ACCOUNT, [SECRET])];
    const web = new AccountCipher(ACCOUNT, [SECRET], keys);
    const node = new AccountCipher(ACCOUNT, [SECRET], keys, {
      primitive: NODE_CRYPTO,
    });
    const fromWeb = await web.encrypt("agents:encryptedConfig", VALUE);
    const fromNode = await node.encrypt("agents:encryptedConfig", VALUE);

    expect(await node.decrypt("agents:encryptedConfig", fromWeb)).toEqual(
      VALUE,
    );
    expect(await web.decrypt("agents:encryptedConfig", fromNode)).toEqual(
      VALUE,
    );
    expect(
      await node.decrypt("sandboxConfigs:encryptedConfig", fromWeb),
    ).toBeNull();
    expect(
      await web.decrypt("sandboxConfigs:encryptedConfig", fromNode),
    ).toBeNull();
    expect(await node.digest("hunter2")).toBe(await web.digest("hunter2"));
  });
});

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

    // A listing decrypts its rows together; they share the one refresh.
    expect(
      await Promise.all(
        [fresh, fresh, fresh].map((blob) =>
          decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", blob),
        ),
      ),
    ).toEqual([VALUE, VALUE, VALUE]);
    expect(loads).toBe(2);
    await expect(
      decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", stale),
    ).rejects.toThrow("does not decrypt");
  });

  test("a legacy blob decrypts without loading keys", async () => {
    // Core may roll out before the backend that serves `account.keys.list`.
    resetAccountKeysForTests(async (): Promise<WrappedAccountKey[]> => {
      throw new Error("Could not find function account/keys:list");
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(SECRET).digest(),
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(VALUE), "utf-8"),
      cipher.final(),
    ]);

    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", {
        ciphertext: ciphertext.toString("base64url"),
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      }),
    ).toEqual(VALUE);
  });

  test("a legacy blob opens under a secret that holds a comma", async () => {
    const raw = "left, right ";
    process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = raw;
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(raw).digest(),
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(VALUE), "utf-8"),
      cipher.final(),
    ]);

    expect(
      await decryptAccountBlob(ACCOUNT, "agents:encryptedConfig", {
        ciphertext: ciphertext.toString("base64url"),
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      }),
    ).toEqual(VALUE);
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

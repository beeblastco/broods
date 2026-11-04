import { describe, expect, it } from "vitest";
import { createAccountSecret, sha256Hex } from "../model/accountSecrets";

describe("account keys", () => {
  it("generates bask_-prefixed 32-byte base64url keys", () => {
    const secret = createAccountSecret();

    expect(secret.startsWith("bask_")).toBe(true);
    expect(secret).toHaveLength("bask_".length + 43);
    expect(secret.slice("bask_".length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes secrets as lowercase SHA-256 hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

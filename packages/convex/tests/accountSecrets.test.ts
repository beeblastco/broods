/** Account key helper parity tests for config HTTP account rotation. */

import { describe, expect, it } from "vitest";
import {
  createAccountSecret,
  hexFromBytes,
  sha256Hex,
} from "../model/accountSecrets";

describe("account keys", () => {
  it("generates bask_-prefixed 32-byte base64url keys", () => {
    const secret = createAccountSecret();

    expect(secret.startsWith("bask_")).toBe(true);
    expect(secret).toHaveLength("bask_".length + 43);
    expect(secret.slice("bask_".length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes secrets with the same SHA-256 hex digest as Web Crypto", async () => {
    const secret = "bask_test-secret";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret),
    );
    const expected = hexFromBytes(new Uint8Array(digest));

    expect(await sha256Hex(secret)).toBe(expected);
  });
});

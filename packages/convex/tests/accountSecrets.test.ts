/** Account secret helper parity tests for config HTTP account rotation. */

import { describe, expect, it } from "vitest";
import {
  createAccountSecret,
  hashAccountSecret,
  hexFromBytes,
} from "../model/accountSecrets";

describe("account secrets", () => {
  it("generates account-prefixed 32-byte base64url secrets", () => {
    const secret = createAccountSecret();

    expect(secret.startsWith("fp_acct_")).toBe(true);
    expect(secret).toHaveLength("fp_acct_".length + 43);
    expect(secret.slice("fp_acct_".length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes secrets with the same SHA-256 hex digest as Web Crypto", async () => {
    const secret = "fp_acct_test-secret";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret),
    );
    const expected = hexFromBytes(new Uint8Array(digest));

    expect(await hashAccountSecret(secret)).toBe(expected);
  });
});

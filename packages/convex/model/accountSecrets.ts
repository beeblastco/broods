/**
 * Account secret generation, plus the SHA-256 hashing every default-runtime
 * Convex path uses to store a bearer token as a digest instead of plaintext.
 */

export const ACCOUNT_SECRET_PREFIX = "fp_acct_";

/**
 * Generate a one-time account secret with the public account prefix.
 * @returns plaintext secret to show once to the caller
 */
export function createAccountSecret(): string {
  return randomToken(ACCOUNT_SECRET_PREFIX);
}

/**
 * Generate a prefixed random bearer credential (base64url payload).
 * @param prefix public token prefix, e.g. "fp_sts_"
 * @param bytes entropy size
 * @returns plaintext token to show once to the caller
 */
export function randomToken(prefix: string, bytes = 32): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${prefix}${base64url}`;
}

/**
 * SHA-256 hex digest of a UTF-8 string.
 * @param value string to digest
 * @returns lowercase SHA-256 hex digest
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return hexFromBytes(new Uint8Array(digest));
}

/**
 * Encode bytes as lowercase hex.
 * @param bytes bytes to encode
 * @returns lowercase hex string
 */
export function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

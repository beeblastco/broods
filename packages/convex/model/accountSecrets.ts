/**
 * Account secret generation and hashing for default-runtime Convex code.
 */

const ACCOUNT_SECRET_PREFIX = "fp_acct_";
const ACCOUNT_SECRET_BYTES = 32;

/**
 * Generate a one-time account secret with the public account prefix.
 * @returns plaintext secret to show once to the caller
 */
export function createAccountSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(ACCOUNT_SECRET_BYTES));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    return `${ACCOUNT_SECRET_PREFIX}${base64url}`;
}

/**
 * Hash an account secret using SHA-256 hex, matching core's storage scheme.
 * @param secret plaintext account secret
 * @returns lowercase SHA-256 hex digest
 */
export async function hashAccountSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));

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

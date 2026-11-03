// Every Broods credential starts with `b`, so people and secret scanners can tell it apart.
export const ACCOUNT_KEY_PREFIX = "bask_";
export const PROJECT_KEY_PREFIX = "bpdk_";
export const RUNTIME_KEY_PREFIX = "bsk_";

export function createAccountSecret(): string {
  return randomToken(ACCOUNT_KEY_PREFIX);
}

export function keyHint(prefix: string, token: string): string {
  return `${prefix}…${token.slice(-4)}`;
}

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

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return hexFromBytes(new Uint8Array(digest));
}

export function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

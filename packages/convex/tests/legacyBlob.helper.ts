/**
 * Writes a blob the way the pre-envelope codec did (AES-256-GCM under
 * SHA-256(secret), no additional data), so tests can seed rows that
 * `migrateToEnvelope` must still read. Test-only; nothing in production
 * encrypts this way any more.
 */

import type { EncryptedBlob } from "../model/envelope";

export async function encryptLegacyBlob(
  value: Record<string, unknown>,
  secret: string,
): Promise<EncryptedBlob> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      key,
      encoder.encode(JSON.stringify(value)),
    ),
  );
  const split = sealed.length - 16;

  return {
    ciphertext: base64Url(sealed.subarray(0, split)),
    iv: base64Url(iv),
    tag: base64Url(sealed.subarray(split)),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

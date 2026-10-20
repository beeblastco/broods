/**
 * A short-lived bearer that opens one sandbox's terminal and nothing else.
 * Core signs it with the bridge API key and seals it in the terminal ticket,
 * so the gateway never holds the key that reaches every sandbox. Core's
 * cloudflare executor imports this file, so both sides share one format.
 */

const PREFIX = "tt1";
const encoder = new TextEncoder();

/** Signs a terminal token for `sandboxId` that stops working at `expiresAt` (epoch ms). */
export async function signTerminalToken(
  apiKey: string,
  sandboxId: string,
  expiresAt: number,
): Promise<string> {
  return `${PREFIX}.${expiresAt}.${await mac(apiKey, sandboxId, expiresAt)}`;
}

/** True when `token` was signed with `apiKey` for `sandboxId` and has not expired. A bridge with no key yet verifies nothing. */
export async function verifyTerminalToken(
  apiKey: string,
  token: string,
  sandboxId: string,
  now: number,
): Promise<boolean> {
  if (!apiKey) return false;
  const [prefix, expiry, signature, ...rest] = token.split(".");
  if (prefix !== PREFIX || !expiry || !signature || rest.length > 0)
    return false;
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(signature)),
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(await mac(apiKey, sandboxId, expiresAt)),
    ),
  ]);

  return timingSafeEqual(new Uint8Array(given), new Uint8Array(expected));
}

// The "terminal" label keeps a token from ever matching a MAC made for
// another purpose with the same key.
async function mac(
  apiKey: string,
  sandboxId: string,
  expiresAt: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`terminal\0${sandboxId}\0${expiresAt}`),
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Both inputs are SHA-256 digests, so the lengths always match.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;

  return diff === 0;
}

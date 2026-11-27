// Opens one sandbox's terminal, so the gateway never holds the key that reaches every sandbox.

const PREFIX = "tt1";
const encoder = new TextEncoder();

export async function signTerminalToken(
  apiKey: string,
  sandboxId: string,
  expiresAt: number,
): Promise<string> {
  return `${PREFIX}.${expiresAt}.${await mac(apiKey, sandboxId, expiresAt)}`;
}

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

// The "terminal" label domain-separates this MAC from any other made with the same key.
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

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;

  return diff === 0;
}

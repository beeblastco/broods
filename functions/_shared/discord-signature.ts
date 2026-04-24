/**
 * Discord request signature helpers.
 * Keep Ed25519 verification for HTTP interactions here.
 */

const DISCORD_REPLAY_WINDOW_SECONDS = 60 * 5;

export async function verifyDiscordSignature(
  publicKey: string,
  signature: string | undefined,
  timestamp: string | undefined,
  body: string,
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  const unixTimestamp = Number(timestamp);
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - unixTimestamp);
  if (!Number.isFinite(unixTimestamp) || ageSeconds > DISCORD_REPLAY_WINDOW_SECONDS) {
    return false;
  }

  try {
    const algorithm = { name: "Ed25519" };
    const bodyBytes = toArrayBuffer(new TextEncoder().encode(timestamp + body));
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeHex(publicKey)),
      algorithm,
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      algorithm,
      key,
      toArrayBuffer(decodeHex(signature)),
      bodyBytes,
    );
  } catch {
    return false;
  }
}

function decodeHex(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Hex string must have an even number of characters");
  }

  if (!/^[\da-f]+$/i.test(normalized)) {
    throw new Error("Hex string must contain only hexadecimal characters");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

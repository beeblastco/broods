/**
 * Discord signature verification tests.
 * Cover valid Ed25519 verification plus replay-window and malformed-input failures here.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { verifyDiscordSignature } from "../functions/_shared/discord-signature.ts";

const FIXED_NOW = new Date("2026-04-24T00:00:00.000Z");
const FIXED_TIMESTAMP = "1776988800";

describe("verifyDiscordSignature", () => {
  beforeEach(() => {
    setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    setSystemTime();
  });

  it("accepts a valid Ed25519 signature inside the replay window", async () => {
    const body = JSON.stringify({ type: 1 });
    const signed = await createSignedPayload(FIXED_TIMESTAMP, body);

    await expect(
      verifyDiscordSignature(
        signed.publicKey,
        signed.signature,
        FIXED_TIMESTAMP,
        body,
      ),
    ).resolves.toBe(true);
  });

  it("rejects missing fields and timestamps outside the replay window", async () => {
    const body = JSON.stringify({ type: 1 });
    const signed = await createSignedPayload(FIXED_TIMESTAMP, body);

    await expect(
      verifyDiscordSignature(signed.publicKey, undefined, FIXED_TIMESTAMP, body),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(signed.publicKey, signed.signature, undefined, body),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(signed.publicKey, signed.signature, "not-a-number", body),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(signed.publicKey, signed.signature, `${Number(FIXED_TIMESTAMP) - 301}`, body),
    ).resolves.toBe(false);
  });

  it("rejects malformed hex and signatures for a different body", async () => {
    const body = JSON.stringify({ type: 1 });
    const signed = await createSignedPayload(FIXED_TIMESTAMP, body);

    await expect(
      verifyDiscordSignature("zz", signed.signature, FIXED_TIMESTAMP, body),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(signed.publicKey, "abc", FIXED_TIMESTAMP, body),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(
        signed.publicKey,
        signed.signature,
        FIXED_TIMESTAMP,
        JSON.stringify({ type: 2 }),
      ),
    ).resolves.toBe(false);
  });
});

async function createSignedPayload(timestamp: string, body: string) {
  const algorithm = { name: "Ed25519" };
  const keyPair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const signature = await crypto.subtle.sign(
    algorithm,
    keyPair.privateKey,
    new TextEncoder().encode(timestamp + body),
  );

  return {
    publicKey: toHex(publicKey),
    signature: toHex(signature),
  };
}

function toHex(bytes: ArrayBuffer | ArrayBufferView): string {
  const array = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

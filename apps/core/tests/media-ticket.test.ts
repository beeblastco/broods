/**
 * The sealed media ticket's own contract: a fresh ticket opens, an expired,
 * tampered or legacy pre-expiry token is refused.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_MEDIA_TICKET_TTL_SECONDS,
  openMediaTicket,
  sealMediaTicket,
  type MediaTicket,
} from "../src/shared/media-ticket.ts";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "media-ticket-secret";
const WORKSPACE_TICKET: MediaTicket = {
  accountId: "acct_1",
  workspaceId: "ws_a",
  namespace: "fs-0123456789abcdef0123456789abcdef01234567",
  path: "pics/shot.png",
};
const ATTACHMENT_TICKET: MediaTicket = {
  accountId: "acct_1",
  path: "media/ab12/0-photo.png",
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sealMediaTicket / openMediaTicket", () => {
  it("opens a fresh ticket, both shapes", (): void => {
    for (const ticket of [WORKSPACE_TICKET, ATTACHMENT_TICKET]) {
      const token = sealMediaTicket(ticket, SECRET);

      expect(openMediaTicket(token, [SECRET])).toEqual(ticket);
    }
  });

  it("opens right up to the default TTL and refuses past it", (): void => {
    const sealedAt = Date.now();
    const token = sealMediaTicket(WORKSPACE_TICKET, SECRET, sealedAt);
    const expiry = sealedAt + DEFAULT_MEDIA_TICKET_TTL_SECONDS * 1000;

    expect(openMediaTicket(token, [SECRET], expiry - 1000)).toEqual(
      WORKSPACE_TICKET,
    );
    expect(openMediaTicket(token, [SECRET], expiry)).toBeNull();
  });

  it("takes the TTL from MEDIA_TICKET_TTL_SECONDS when set", (): void => {
    process.env.MEDIA_TICKET_TTL_SECONDS = "60";
    const sealedAt = Date.now();
    const token = sealMediaTicket(ATTACHMENT_TICKET, SECRET, sealedAt);

    expect(openMediaTicket(token, [SECRET], sealedAt + 59_000)).toEqual(
      ATTACHMENT_TICKET,
    );
    expect(openMediaTicket(token, [SECRET], sealedAt + 61_000)).toBeNull();
  });

  it("refuses a legacy no-expiry token outright", (): void => {
    // What sealMediaTicket wrote before tickets expired: version ml1, no exp.
    const legacy = sealRaw("ml1", WORKSPACE_TICKET, SECRET);

    expect(openMediaTicket(legacy, [SECRET])).toBeNull();
  });

  it("refuses an authentic current-version payload missing exp", (): void => {
    const token = sealRaw("ml2", WORKSPACE_TICKET, SECRET);

    expect(openMediaTicket(token, [SECRET])).toBeNull();
  });

  it("refuses tamper and a wrong secret", (): void => {
    const token = sealMediaTicket(WORKSPACE_TICKET, SECRET);
    const [version, iv, tag, ciphertext] = token.split(".");
    const flipped = ciphertext![0] === "A" ? "B" : "A";
    const tampered = [
      version,
      iv,
      tag,
      `${flipped}${ciphertext!.slice(1)}`,
    ].join(".");

    expect(openMediaTicket(tampered, [SECRET])).toBeNull();
    expect(openMediaTicket(token, ["other-secret"])).toBeNull();
  });
});

// Seals an arbitrary payload under an arbitrary version with the real key
// derivation, to forge what older code (or no code) would have written.
function sealRaw(version: string, payload: object, secret: string): string {
  const key = createHash("sha256")
    .update(`workspace-media-link:${secret}`)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);

  return [
    version,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

const TICKET_ALGORITHM = "aes-256-gcm";
const TICKET_AUTH_TAG_LENGTH = 16;
const TICKET_VERSION = "st1";
const SEALED_TICKET = z.object({
  url: z.string(),
  authorization: z.string(),
  authorizationHeader: z.string().optional(),
  accountId: z.string(),
  expiresAt: z.number(),
});

export const TERMINAL_TICKET_TTL_MS = 2 * 60 * 1000;
export const TERMINAL_WEBSOCKET_PATH = "/v1/sandboxes/terminal/ws";

export interface TerminalTicket {
  url: string;
  authorization: string;
  /** Defaults to `authorization`; MicroVM shells use `X-aws-proxy-auth`. */
  authorizationHeader?: string;
  accountId: string;
  expiresAt: number;
}

// Null, never a throw, so a caller can try its other live secrets.
export function openTerminalTicket(
  token: string,
  secret: string,
  now = Date.now(),
): TerminalTicket | null {
  const [version, iv, tag, ciphertext, extra] = token.split(".");
  if (
    version !== TICKET_VERSION ||
    !iv ||
    !tag ||
    !ciphertext ||
    extra !== undefined
  )
    return null;
  // Node decodes base64url leniently; only the canonical spelling opens, or a re-spelled token
  // would dodge the gateway's single-use check.
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  const ciphertextBytes = Buffer.from(ciphertext, "base64url");
  if (
    ivBytes.toString("base64url") !== iv ||
    tagBytes.toString("base64url") !== tag ||
    ciphertextBytes.toString("base64url") !== ciphertext
  )
    return null;
  try {
    const decipher = createDecipheriv(
      TICKET_ALGORITHM,
      ticketKey(secret),
      ivBytes,
      { authTagLength: TICKET_AUTH_TAG_LENGTH },
    );
    decipher.setAuthTag(tagBytes);
    const plaintext = Buffer.concat([
      decipher.update(ciphertextBytes),
      decipher.final(),
    ]).toString("utf-8");
    const sealed = SEALED_TICKET.safeParse(JSON.parse(plaintext));
    if (!sealed.success || sealed.data.expiresAt <= now) return null;
    const { authorizationHeader, ...ticket } = sealed.data;

    return authorizationHeader
      ? { ...ticket, authorizationHeader: authorizationHeader }
      : ticket;
  } catch {
    return null;
  }
}

export function sealTerminalTicket(
  ticket: TerminalTicket,
  secret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(TICKET_ALGORITHM, ticketKey(secret), iv, {
    authTagLength: TICKET_AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(ticket), "utf-8"),
    cipher.final(),
  ]);

  return [
    TICKET_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function ticketKey(secret: string): Buffer {
  return createHash("sha256")
    .update(`sandbox-terminal-ticket:${secret}`)
    .digest();
}

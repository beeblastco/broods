/**
 * Short-lived sandbox terminal tickets. account-manage mints one when the
 * dashboard opens a live terminal; the public gateway decrypts it to learn the
 * upstream PTY WebSocket target. The provider credential rides inside the
 * AES-256-GCM ciphertext, so the browser only ever holds an opaque token.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isPlainObject } from "./object.ts";

const TICKET_ALGORITHM = "aes-256-gcm";
const TICKET_VERSION = "st1";

export const TERMINAL_TICKET_TTL_MS = 2 * 60 * 1000;
export const TERMINAL_WEBSOCKET_PATH = "/v1/sandboxes/terminal/ws";

export interface TerminalTicket {
  /** Upstream PTY WebSocket URL (ws:// or wss://). */
  url: string;
  /** Authorization header value for the upstream connection. */
  authorization: string;
  /** Header the credential is sent in; defaults to `authorization` (workdir). MicroVM shells use `X-aws-proxy-auth`. */
  authorizationHeader?: string;
  /** Owning account, kept for gateway-side logging/limits. */
  accountId: string;
  /** Unix ms after which the ticket is rejected. */
  expiresAt: number;
}

// The ticket key is derived, not the raw service secret, so a leaked ticket key
// context can never stand in for service-to-service auth.
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`sandbox-terminal-ticket:${secret}`).digest();
}

export function sealTerminalTicket(ticket: TerminalTicket, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(TICKET_ALGORITHM, ticketKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(ticket), "utf-8"), cipher.final()]);

  return [
    TICKET_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts and validates a ticket. Returns null (never throws) on any tamper,
 * wrong-secret, or expiry failure so callers can try their other stage secrets.
 */
export function openTerminalTicket(token: string, secret: string, now = Date.now()): TerminalTicket | null {
  const [version, iv, tag, ciphertext, extra] = token.split(".");
  if (version !== TICKET_VERSION || !iv || !tag || !ciphertext || extra !== undefined) return null;
  try {
    const decipher = createDecipheriv(TICKET_ALGORITHM, ticketKey(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!isPlainObject(parsed)) return null;
    const { url, authorization, authorizationHeader, accountId, expiresAt } = parsed;
    if (typeof url !== "string" || typeof authorization !== "string" || typeof accountId !== "string") return null;
    if (authorizationHeader !== undefined && typeof authorizationHeader !== "string") return null;
    if (typeof expiresAt !== "number" || expiresAt <= now) return null;

    return { url, authorization, accountId, expiresAt, ...(authorizationHeader ? { authorizationHeader } : {}) };
  } catch {
    return null;
  }
}

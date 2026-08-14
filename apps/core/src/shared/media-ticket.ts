/**
 * Durable workspace media links. A channel tool seals one when it hands a
 * workspace file to a chat provider; the media route opens it to learn which
 * file to stream. Providers store the URL and fetch it lazily — Zalo re-fetches
 * every time a viewer opens the photo — so the ticket carries no expiry.
 * Rotating the service secret is what revokes every issued link.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { isPlainObject } from "./object.ts";

const TICKET_ALGORITHM = "aes-256-gcm";
const TICKET_VERSION = "ml1";

export const MEDIA_PATH_PREFIX = "/media/";

export interface MediaTicket {
  accountId: string;
  workspaceId: string;
  /** Filesystem namespace, which already carries any workspace isolation suffix. */
  namespace: string;
  /** File path relative to the workspace root. */
  path: string;
}

// Derived, not the raw service secret, so a leaked media key can never stand in
// for service-to-service auth.
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`workspace-media-link:${secret}`).digest();
}

export function sealMediaTicket(ticket: MediaTicket, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(TICKET_ALGORITHM, ticketKey(secret), iv);
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

/**
 * Decrypts and validates a ticket. Returns null (never throws) on any tamper or
 * wrong-secret failure, so the route answers 404 rather than leaking the reason.
 */
export function openMediaTicket(
  token: string,
  secret: string,
): MediaTicket | null {
  const [version, iv, tag, ciphertext, extra] = token.split(".");
  if (
    version !== TICKET_VERSION ||
    !iv ||
    !tag ||
    !ciphertext ||
    extra !== undefined
  )
    return null;
  try {
    const decipher = createDecipheriv(
      TICKET_ALGORITHM,
      ticketKey(secret),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!isPlainObject(parsed)) return null;
    const { accountId, workspaceId, namespace, path } = parsed;
    if (
      typeof accountId !== "string" ||
      typeof workspaceId !== "string" ||
      typeof namespace !== "string" ||
      typeof path !== "string"
    )
      return null;

    return {
      accountId: accountId,
      workspaceId: workspaceId,
      namespace: namespace,
      path: path,
    };
  } catch {
    return null;
  }
}

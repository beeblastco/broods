/**
 * Durable media links. A channel tool seals one when it hands a workspace file
 * to a chat provider, and inbound media seals one for the copy kept in the
 * attachment store; the media route opens it to learn which file to stream.
 * Providers store the URL and fetch it lazily, and Zalo re-fetches every time a
 * viewer opens the photo, so the ticket carries no expiry. Dropping a secret from
 * `MEDIA_TICKET_SECRET` is what revokes every link sealed with it.
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

export const MEDIA_PATH_PREFIX = "/v1/media/";

// Root of the attachment store in the managed filesystem bucket. Workspace
// mounts are keyed by an `fs-` namespace, so nothing under here is ever mounted
// and no sandbox tool can delete it.
const ATTACHMENT_STORE_ROOT = "attachments/";

/** A file in the attachment store: inbound media, kept for the conversation. */
export interface AttachmentMediaTicket {
  accountId: string;
  /** Same path the agent's workspace copy was saved under. */
  path: string;
}

/** A file in a workspace, sent out by a channel tool. */
export interface WorkspaceMediaTicket {
  accountId: string;
  workspaceId: string;
  /** Filesystem namespace, which already carries any workspace isolation suffix. */
  namespace: string;
  /** File path relative to the workspace root. */
  path: string;
}

export type MediaTicket = AttachmentMediaTicket | WorkspaceMediaTicket;

export function attachmentStoreKey(ticket: AttachmentMediaTicket): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(ticket.accountId)}/${ticket.path}`;
}

/** Every key of one account's attachment store, for the account delete sweep. */
export function attachmentStorePrefix(accountId: string): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(accountId)}/`;
}

/**
 * Tries every live secret. Returns null (never throws) on any tamper or
 * wrong-secret failure, so the route answers 404 rather than leaking the reason.
 */
export function openMediaTicket(
  token: string,
  secrets: string[],
): MediaTicket | null {
  for (const secret of secrets) {
    const ticket = openWithSecret(token, secret);
    if (ticket) return ticket;
  }

  return null;
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

function openWithSecret(token: string, secret: string): MediaTicket | null {
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
    if (typeof accountId !== "string" || typeof path !== "string") return null;
    if (workspaceId === undefined && namespace === undefined) {
      return { accountId: accountId, path: path };
    }
    if (typeof workspaceId !== "string" || typeof namespace !== "string") {
      return null;
    }

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

// The purpose label keeps this key distinct from every other ticket kind's.
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`workspace-media-link:${secret}`).digest();
}

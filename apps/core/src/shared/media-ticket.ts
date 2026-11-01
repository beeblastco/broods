/**
 * Durable media links. A channel tool seals one when it hands a workspace file
 * to a chat provider, and inbound media seals one for the copy kept in the
 * attachment store; the media route opens it to learn which file to stream.
 * Every ticket expires after `MEDIA_TICKET_TTL_SECONDS`; what an expired or
 * revoked link costs is in apps/docs/docs/internals/channels.md.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { positiveIntegerEnv } from "./env.ts";

const TICKET_ALGORITHM = "aes-256-gcm";
const TICKET_VERSION = "ml2";

export const MEDIA_PATH_PREFIX = "/v1/media/";

/**
 * Default ticket life, overridable with `MEDIA_TICKET_TTL_SECONDS`. The
 * provider fetch at send time and conversation replay reads happen within the
 * active conversation; the viewer-driven Zalo re-fetch window is unbounded, so
 * no finite TTL covers it and a month is the chosen cut.
 */
export const DEFAULT_MEDIA_TICKET_TTL_SECONDS = 30 * 24 * 60 * 60;

// Root of the attachment store in the managed filesystem bucket. Workspace
// mounts are keyed by an `fs-` namespace, so nothing under here is ever mounted
// and no sandbox tool can delete it.
const ATTACHMENT_STORE_ROOT = "attachments/";

// What a ticket seals: one of the two `MediaTicket` shapes plus its expiry in
// epoch seconds.
const ticketPayload = z.union([
  z.strictObject({
    accountId: z.string(),
    workspaceId: z.string(),
    namespace: z.string(),
    path: z.string(),
    exp: z.number(),
  }),
  z.strictObject({
    accountId: z.string(),
    path: z.string(),
    exp: z.number(),
  }),
]);

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

/** A ticket the media route opened, with its expiry in epoch seconds. */
export type OpenedMediaTicket = z.infer<typeof ticketPayload>;

export function attachmentStoreKey(ticket: AttachmentMediaTicket): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(ticket.accountId)}/${ticket.path}`;
}

/** Every key of one account's attachment store, for the account delete sweep. */
export function attachmentStorePrefix(accountId: string): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(accountId)}/`;
}

/**
 * Tries every live secret. Returns null (never throws) on any tamper,
 * wrong-secret or expiry failure, so the route answers 404 rather than leaking
 * the reason.
 */
export function openMediaTicket(
  token: string,
  secrets: string[],
  now = Date.now(),
): OpenedMediaTicket | null {
  for (const secret of secrets) {
    const ticket = openWithSecret(token, secret, now);
    if (ticket) {
      return ticket;
    }
  }

  return null;
}

export function sealMediaTicket(
  ticket: MediaTicket,
  secret: string,
  now = Date.now(),
): string {
  const ttlSeconds = positiveIntegerEnv(
    "MEDIA_TICKET_TTL_SECONDS",
    DEFAULT_MEDIA_TICKET_TTL_SECONDS,
  );
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const iv = randomBytes(12);
  const cipher = createCipheriv(TICKET_ALGORITHM, ticketKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ ...ticket, exp: exp }), "utf-8"),
    cipher.final(),
  ]);

  return [
    TICKET_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function openWithSecret(
  token: string,
  secret: string,
  now: number,
): OpenedMediaTicket | null {
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
    const parsed = ticketPayload.safeParse(JSON.parse(plaintext));

    return parsed.success && parsed.data.exp * 1000 > now ? parsed.data : null;
  } catch {
    return null;
  }
}

// The purpose label keeps this key distinct from every other ticket kind's.
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`workspace-media-link:${secret}`).digest();
}

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

// Zalo re-fetches whenever a viewer opens the message, so no TTL covers it; a month is the cut.
export const DEFAULT_MEDIA_TICKET_TTL_SECONDS = 30 * 24 * 60 * 60;

// Mounts are keyed by an `fs-` namespace, so no sandbox ever mounts or deletes this prefix.
const ATTACHMENT_STORE_ROOT = "attachments/";

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

export interface AttachmentMediaTicket {
  accountId: string;
  path: string;
}

export interface WorkspaceMediaTicket {
  accountId: string;
  workspaceId: string;
  namespace: string;
  path: string;
}

export type MediaTicket = AttachmentMediaTicket | WorkspaceMediaTicket;

export type OpenedMediaTicket = z.infer<typeof ticketPayload>;

export function attachmentStoreKey(ticket: AttachmentMediaTicket): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(ticket.accountId)}/${ticket.path}`;
}

export function attachmentStorePrefix(accountId: string): string {
  return `${ATTACHMENT_STORE_ROOT}${encodeURIComponent(accountId)}/`;
}

// Null, never a throw, on any failure, so the route answers a bare 404 that leaks no reason.
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

function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`workspace-media-link:${secret}`).digest();
}

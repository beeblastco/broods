/**
 * Durable media links. A channel tool seals one when it hands a workspace file
 * to a chat provider, and inbound media seals one for the copy kept in the
 * attachment store; the media route opens it to learn which file to stream.
 * Every ticket expires: seal stamps `exp` from `MEDIA_TICKET_TTL_SECONDS`
 * (default `DEFAULT_MEDIA_TICKET_TTL_SECONDS`), open refuses a ticket past it
 * as "expired", and a legacy pre-expiry token ("ml1") is refused outright, so
 * links sealed before the cutover die with it. Providers that re-fetch lazily
 * (Zalo, on every view) lose an expired link in old chat history; the media
 * route's immutable cache-control lets their CDNs keep bytes fetched in time.
 * Dropping a secret from `MEDIA_TICKET_SECRET` still revokes every link sealed
 * with it at once.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { positiveIntegerEnv } from "./env.ts";
import { isPlainObject } from "./object.ts";

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

/** Why a token did not open: authenticated but past `exp`, or anything else. */
export type MediaTicketRefusal = "expired" | "invalid";

export type MediaTicketOutcome =
  | { ticket: MediaTicket }
  | { refusal: MediaTicketRefusal };

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
 * the reason; `resolveMediaTicket` names it for logs and tests.
 */
export function openMediaTicket(
  token: string,
  secrets: string[],
  now = Date.now(),
): MediaTicket | null {
  const outcome = resolveMediaTicket(token, secrets, now);

  return "ticket" in outcome ? outcome.ticket : null;
}

/**
 * `openMediaTicket` with the refusal named: "expired" only when a live secret
 * authenticated the token, "invalid" for every tamper, wrong-secret or legacy
 * no-expiry token. The route's answer stays 404 either way.
 */
export function resolveMediaTicket(
  token: string,
  secrets: string[],
  now = Date.now(),
): MediaTicketOutcome {
  let expired = false;
  for (const secret of secrets) {
    const outcome = openWithSecret(token, secret, now);
    if (outcome === "expired") {
      expired = true;
    } else if (outcome !== "invalid") {
      return { ticket: outcome };
    }
  }

  return { refusal: expired ? "expired" : "invalid" };
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
): MediaTicket | MediaTicketRefusal {
  const [version, iv, tag, ciphertext, extra] = token.split(".");
  if (
    version !== TICKET_VERSION ||
    !iv ||
    !tag ||
    !ciphertext ||
    extra !== undefined
  )
    return "invalid";
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
    if (!isPlainObject(parsed)) return "invalid";
    const { accountId, workspaceId, namespace, path, exp } = parsed;
    if (
      typeof accountId !== "string" ||
      typeof path !== "string" ||
      typeof exp !== "number"
    )
      return "invalid";
    if (exp * 1000 <= now) return "expired";
    if (workspaceId === undefined && namespace === undefined) {
      return { accountId: accountId, path: path };
    }
    if (typeof workspaceId !== "string" || typeof namespace !== "string") {
      return "invalid";
    }

    return {
      accountId: accountId,
      workspaceId: workspaceId,
      namespace: namespace,
      path: path,
    };
  } catch {
    return "invalid";
  }
}

// The purpose label keeps this key distinct from every other ticket kind's.
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(`workspace-media-link:${secret}`).digest();
}

/**
 * Browser tickets (`bbt_…`): what an end user's browser extension opens its
 * socket to a `scope: "user"` machine sandbox with. The customer's backend
 * seals one with the stage's `bsig_` signing secret, the same secret that
 * seals user tokens, under its own key context, so a user token never opens a
 * socket and a ticket never authorizes a run. Core opens it at the socket
 * upgrade and on every credential refresh. The SDK bundles this file to sign
 * tickets server side, so it imports nothing but the signed-ticket format.
 */

import { openSignedTicket, sealSignedTicket } from "./stageSessionTicket";
import { USER_ID_PATTERN, USER_TOKEN_SECRET_PREFIX } from "./userToken";

export const BROWSER_TICKET_PREFIX = "bbt_";
export const BROWSER_TICKET_DEFAULT_TTL_MS = 10 * 60 * 1000;
/** A ticket naming a later expiry is refused: it is a bearer for its whole life. */
export const BROWSER_TICKET_MAX_TTL_MS = 15 * 60 * 1000;

const KEY_CONTEXT = "broods-browser-ticket:";
const MAX_ID_LENGTH = 128;
/** The signer's clock may run ahead of core's by this much. */
const CLOCK_SKEW_MS = 60 * 1000;

export interface BrowserTicket {
  /** The customer's own id for the signed-in user, as in their user token. */
  userId: string;
  /** Name of the `scope: "user"` machine sandbox this browser serves. */
  sandbox: string;
  /** Unix ms after which the ticket is refused. */
  expiresAt: number;
  /** One id per ticket, so core opens a socket with it at most once. */
  jti: string;
}

/**
 * Seal a ticket with the stage's signing secret. Server side only: anyone
 * holding the secret can open a browser socket as any user of the stage.
 * @throws when the secret is not a `bsig_` secret or a field is out of range
 */
export async function sealBrowserTicket(
  ticket: BrowserTicket,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!secret.startsWith(USER_TOKEN_SECRET_PREFIX)) {
    throw new Error(
      `The browser ticket signing secret must start with ${USER_TOKEN_SECRET_PREFIX}. It is not the bsk_ runtime key.`,
    );
  }
  const checked = parseBrowserTicket(ticket, now);
  // The skew allowance is for verifying, never for minting.
  if (!checked || ticket.expiresAt > now + BROWSER_TICKET_MAX_TTL_MS) {
    throw new Error(
      `Invalid browser ticket: userId must match ${USER_ID_PATTERN.source}, sandbox and jti must be 1 to ${MAX_ID_LENGTH} characters, and expiresAt must be in the next ${BROWSER_TICKET_MAX_TTL_MS / 60_000} minutes.`,
    );
  }

  return await sealSignedTicket(
    BROWSER_TICKET_PREFIX,
    KEY_CONTEXT,
    checked,
    secret,
  );
}

/** Verify a ticket's signature, shape and expiry; null for anything else. */
export async function openBrowserTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<BrowserTicket | null> {
  return parseBrowserTicket(
    await openSignedTicket(BROWSER_TICKET_PREFIX, KEY_CONTEXT, token, secret),
    now,
  );
}

function isShortId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
  );
}

function parseBrowserTicket(
  decoded: unknown,
  now: number,
): BrowserTicket | null {
  if (!decoded || typeof decoded !== "object") return null;
  const { userId, sandbox, expiresAt, jti } = decoded as Partial<
    Record<keyof BrowserTicket, unknown>
  >;
  if (
    typeof userId !== "string" ||
    !USER_ID_PATTERN.test(userId) ||
    !isShortId(sandbox) ||
    !isShortId(jti) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + BROWSER_TICKET_MAX_TTL_MS + CLOCK_SKEW_MS
  ) {
    return null;
  }

  return { userId: userId, sandbox: sandbox, expiresAt: expiresAt, jti: jti };
}

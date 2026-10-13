/**
 * End-user tokens (`buat_…`) and the stage signing secret (`bsig_…`) that
 * seals them. The `bsk_` runtime key sits in a customer's frontend, so it
 * proves only "a visitor of this site". The customer's backend holds the
 * stage's signing secret and seals a short-lived token naming its signed-in
 * user; core opens it and puts every conversation that request touches under
 * that user's namespace (`bsu:<userId>:<key>`), so a visitor can no longer
 * name another user's conversation. Same signed-ticket format as the stage
 * session ticket, under its own key context. The SDK bundles this file to
 * sign tokens server side, so it imports nothing but that format.
 */

import { openSignedTicket, sealSignedTicket } from "./stageSessionTicket";

/** A sealed end-user token. Sent beside the runtime key, never as a bearer. */
export const USER_TOKEN_PREFIX = "buat_";
/** The stage's signing secret. Lives on the customer's server only. */
export const USER_TOKEN_SECRET_PREFIX = "bsig_";
/** The HTTP header a token rides on. */
export const USER_TOKEN_HEADER = "x-broods-user-token";
/** `Sec-WebSocket-Protocol` entry prefix that carries a token on a socket upgrade. */
export const USER_TOKEN_SUBPROTOCOL_PREFIX = "broods.user.";
/**
 * Namespace every conversation and event id of a token-carrying request
 * lives under. Reserved, so a request without a token cannot name one.
 */
export const USER_CONVERSATION_PREFIX = "bsu:";
export const USER_TOKEN_DEFAULT_TTL_MS = 10 * 60 * 1000;
/** A token naming a later expiry is refused: it is a bearer for its whole life. */
export const USER_TOKEN_MAX_TTL_MS = 60 * 60 * 1000;

const KEY_CONTEXT = "broods-user-token:";
/** No `:` so `bsu:<userId>:` splits one way only. Emails and UUIDs fit. */
const USER_ID_PATTERN = /^[A-Za-z0-9._@+=-]{1,128}$/;
const MAX_CONVERSATIONS = 100;
const MAX_CONVERSATION_KEY_LENGTH = 256;
/** The signer's clock may run ahead of core's by this much. */
const CLOCK_SKEW_MS = 60 * 1000;

export interface UserToken {
  /** The customer's own id for the signed-in user. */
  userId: string;
  /**
   * The conversation keys this user may use, without the namespace. Absent
   * means any key under the user's namespace.
   */
  conversations?: string[];
  /** Unix ms after which the token is refused. */
  expiresAt: number;
}

/**
 * Seal a token with the stage's signing secret. Server side only: anyone
 * holding the secret can sign as any user of the stage.
 * @throws when the secret is not a `bsig_` secret or a field is out of range
 */
export async function sealUserToken(
  token: UserToken,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!secret.startsWith(USER_TOKEN_SECRET_PREFIX)) {
    throw new Error(
      `The user token signing secret must start with ${USER_TOKEN_SECRET_PREFIX}. It is not the bsk_ runtime key.`,
    );
  }
  const checked = parseUserToken(token, now);
  // The skew allowance is for verifying, never for minting.
  if (!checked || token.expiresAt > now + USER_TOKEN_MAX_TTL_MS) {
    throw new Error(
      `Invalid user token: userId must match ${USER_ID_PATTERN.source}, conversations must be at most ${MAX_CONVERSATIONS} non-empty keys, and expiresAt must be in the next ${USER_TOKEN_MAX_TTL_MS / 60_000} minutes.`,
    );
  }

  return await sealSignedTicket(
    USER_TOKEN_PREFIX,
    KEY_CONTEXT,
    checked,
    secret,
  );
}

/** Verify a token's signature, shape and expiry; null for anything else. */
export async function openUserToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<UserToken | null> {
  return parseUserToken(
    await openSignedTicket(USER_TOKEN_PREFIX, KEY_CONTEXT, token, secret),
    now,
  );
}

/** `bsu:<userId>:`, the namespace a token's conversations live under. */
export function userConversationPrefix(userId: string): string {
  return `${USER_CONVERSATION_PREFIX}${userId}:`;
}

/**
 * The namespaced key a token-carrying request uses for `requested`, which may
 * name the key bare or already namespaced (as core answered it). Null when the
 * token does not let its user use that conversation.
 */
export function userConversationKey(
  token: UserToken,
  requested: string,
): string | null {
  const prefix = userConversationPrefix(token.userId);
  const key = requested.startsWith(prefix)
    ? requested
    : `${prefix}${requested}`;

  return userOwnsConversation(token, key) ? key : null;
}

/** Whether a public conversation key is one the token's user may use. */
export function userOwnsConversation(
  token: UserToken,
  publicConversationKey: string,
): boolean {
  const prefix = userConversationPrefix(token.userId);
  if (!publicConversationKey.startsWith(prefix)) return false;
  const bare = publicConversationKey.slice(prefix.length);

  return (
    bare.length > 0 &&
    (token.conversations === undefined || token.conversations.includes(bare))
  );
}

function parseUserToken(decoded: unknown, now: number): UserToken | null {
  if (!decoded || typeof decoded !== "object") return null;
  const { userId, conversations, expiresAt } = decoded as Partial<
    Record<keyof UserToken, unknown>
  >;
  if (
    typeof userId !== "string" ||
    !USER_ID_PATTERN.test(userId) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + USER_TOKEN_MAX_TTL_MS + CLOCK_SKEW_MS
  ) {
    return null;
  }
  if (conversations === undefined) {
    return { userId: userId, expiresAt: expiresAt };
  }
  if (
    !Array.isArray(conversations) ||
    conversations.length > MAX_CONVERSATIONS ||
    !conversations.every(
      (key): key is string =>
        typeof key === "string" &&
        key.trim() === key &&
        key.length > 0 &&
        key.length <= MAX_CONVERSATION_KEY_LENGTH,
    )
  ) {
    return null;
  }

  return { userId: userId, conversations: conversations, expiresAt: expiresAt };
}

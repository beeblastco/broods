// A `bsk_` key only proves "a visitor": the customer's backend seals a `buat_` token with the
// stage's `bsig_` secret to pin the request to one user's `bsu:<userId>:` conversations.
// The SDK bundles this file to sign server side, so it imports only the ticket format.

import { openSignedTicket, sealSignedTicket } from "./stageSessionTicket";

export const USER_TOKEN_PREFIX = "buat_";
export const USER_TOKEN_SECRET_PREFIX = "bsig_";
export const USER_TOKEN_HEADER = "x-broods-user-token";
export const USER_TOKEN_SUBPROTOCOL_PREFIX = "broods.user.";
/** Reserved: a request without a token cannot name a conversation under it. */
export const USER_CONVERSATION_PREFIX = "bsu:";
export const USER_TOKEN_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const USER_TOKEN_MAX_TTL_MS = 60 * 60 * 1000;

const KEY_CONTEXT = "broods-user-token:";
/** No `:`, so `bsu:<userId>:` splits one way only. */
const USER_ID_PATTERN = /^[A-Za-z0-9._@+=-]{1,128}$/;
const MAX_CONVERSATIONS = 100;
const MAX_CONVERSATION_KEY_LENGTH = 256;
const CLOCK_SKEW_MS = 60 * 1000;

export interface UserToken {
  userId: string;
  /** Bare keys; absent allows any key under the user's namespace. */
  conversations?: string[];
  expiresAt: number;
}

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

export function userConversationPrefix(userId: string): string {
  return `${USER_CONVERSATION_PREFIX}${userId}:`;
}

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

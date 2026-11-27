// A `bsk_` key only proves "a visitor": the customer's backend seals a `buat_` token with the
// stage's `bsig_` secret to pin the request to one user's `bsu:<userId>:` conversations.
// The SDK bundles this file to sign server side, so it imports only the ticket format.

import {
  base64UrlToBytes,
  bytesToBase64Url,
  openSignedTicket,
  sealSignedTicket,
} from "./stageSessionTicket";

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
const CREDENTIAL_PATTERN = /^[\x21-\x7e]{1,512}$/;
const CLOCK_SKEW_MS = 60 * 1000;
const CREDENTIAL_KEY_INFO = "broods-user-token-credential";
const ENCODER = new TextEncoder();
const GCM_IV_BYTES = 12;

export interface UserToken {
  userId: string;
  /** Bare keys; absent allows any key under the user's namespace. */
  conversations?: string[];
  /** The user's own bearer, for the agent's hosted MCP servers only; the minter vouches for it. */
  credential?: string;
  expiresAt: number;
}

// The token is only signed, so its credential rides as AES-GCM ciphertext, never in clear.
interface UserTokenPayload extends Omit<UserToken, "credential"> {
  credentialSealed?: string;
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
      `Invalid user token: userId must match ${USER_ID_PATTERN.source}, conversations must be at most ${MAX_CONVERSATIONS} non-empty keys, credential must be 1 to 512 printable ASCII characters without spaces, and expiresAt must be in the next ${USER_TOKEN_MAX_TTL_MS / 60_000} minutes.`,
    );
  }

  const { credential, ...fields } = checked;
  const payload: UserTokenPayload =
    credential === undefined
      ? fields
      : {
          ...fields,
          credentialSealed: await sealCredential(credential, secret),
        };

  return await sealSignedTicket(
    USER_TOKEN_PREFIX,
    KEY_CONTEXT,
    payload,
    secret,
  );
}

export async function openUserToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<UserToken | null> {
  const decoded = await openSignedTicket(
    USER_TOKEN_PREFIX,
    KEY_CONTEXT,
    token,
    secret,
  );
  if (!decoded || typeof decoded !== "object") return null;
  const { credentialSealed, ...fields } = decoded as {
    credentialSealed?: unknown;
  };
  const credential =
    credentialSealed === undefined
      ? undefined
      : await openCredential(credentialSealed, secret);
  if (credential === null) return null;

  return parseUserToken({ ...fields, credential: credential }, now);
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
  const { userId, conversations, credential, expiresAt } = decoded as Partial<
    Record<keyof UserToken, unknown>
  >;
  if (
    typeof userId !== "string" ||
    !USER_ID_PATTERN.test(userId) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + USER_TOKEN_MAX_TTL_MS + CLOCK_SKEW_MS ||
    (credential !== undefined &&
      (typeof credential !== "string" || !CREDENTIAL_PATTERN.test(credential)))
  ) {
    return null;
  }
  const checked: UserToken = {
    userId: userId,
    ...(credential !== undefined ? { credential: credential } : {}),
    expiresAt: expiresAt,
  };
  if (conversations === undefined) return checked;
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

  return { ...checked, conversations: conversations };
}

async function credentialKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: ENCODER.encode(CREDENTIAL_KEY_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function openCredential(
  sealed: unknown,
  secret: string,
): Promise<string | null> {
  if (typeof sealed !== "string") return null;
  try {
    const bytes = base64UrlToBytes(sealed);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, GCM_IV_BYTES) },
      await credentialKey(secret),
      bytes.slice(GCM_IV_BYTES),
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

async function sealCredential(
  credential: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    await credentialKey(secret),
    ENCODER.encode(credential),
  );
  const sealed = new Uint8Array(GCM_IV_BYTES + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), GCM_IV_BYTES);

  return bytesToBase64Url(sealed);
}

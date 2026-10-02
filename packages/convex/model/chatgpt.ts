/**
 * Sign in with ChatGPT: the OpenAI endpoints, scopes and limits the `chatgpt`
 * model provider is built on. Plain data so the CLI (sign-in), the config plane
 * (store, revoke) and core (refresh, inference) read one copy.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;

/** The API the access token is minted for, sent on every token request. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";

/** The first sign-in registers a client; OpenAI answers with its real id. */
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The grant that lets requests draw on the user's ChatGPT plan. */
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

export const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_DIRECT_SCOPE,
] as const;

/** A verified sign-in for `PUT /v1/account/chatgpt`; `broods login chatgpt` builds it. */
export interface ChatGPTSignIn {
  /** OAuth client OpenAI issued at the first sign-in. */
  clientId: string;
  /** The deployment's `ext_agent_host_id`, kept across sign-ins. */
  hostId: string;
  email?: string;
  scopes: string[];
  /** ISO 8601 access-token expiry. */
  expiresAt: string;
  accessToken: string;
  refreshToken: string;
}

/** The account's sign-in as `/v1/account/chatgpt` answers it: never the tokens. */
export type ChatGPTConnection =
  | { connected: false }
  | ({ connected: true; updatedAt: string } & Omit<
      ChatGPTSignIn,
      "accessToken" | "refreshToken"
    >);

/** Where a user reviews and limits what apps draw from their plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * Hosted, paid services need OpenAI's approval before offering plan usage, so
 * the managed service refuses new sign-ins until that approval exists.
 */
export const CHATGPT_MANAGED_SERVICE_REFUSAL =
  "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.";

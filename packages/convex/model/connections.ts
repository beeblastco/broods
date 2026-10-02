/**
 * Connections: external accounts an agent acts through, one of each type per
 * Broods account. `broods connect <type>` opens the provider's sign-in; the
 * deployment trades the code, checks the ID token and keeps the tokens, and
 * core refreshes them from then on. `chatgpt` backs the `chatgpt` model
 * provider; more types are tracked in an issue. Plain data, so the CLI, the config plane, core and the dashboard read one copy.
 */

export const CONNECTION_TYPE_NAMES = ["chatgpt"] as const;

const CHATGPT_ISSUER = "https://auth.openai.com";

/** The API a ChatGPT access token is minted for, sent on every token request. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";

/** The first ChatGPT sign-in registers a client; OpenAI answers with its real id. */
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The grant that lets requests draw on the user's ChatGPT plan. */
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

/** The name users see on OpenAI's consent screen and in ChatGPT settings. */
export const CHATGPT_AGENT_NAME = "Broods";

export type ConnectionType = (typeof CONNECTION_TYPE_NAMES)[number];

export interface ConnectionTypeMeta {
  label: string;
  /** What the connection is for, in the CLI and the dashboard. */
  description: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a disconnect revokes the refresh token; absent when there is none. */
  revokeUrl?: string;
  /** Keys that sign the ID token the deployment checks. */
  jwksUrl: string;
  /** The ID token's `iss`. */
  issuer: RegExp;
  scopes: readonly string[];
  /** The API tokens are minted for, sent on every authorize and token request. */
  resource?: string;
  /** A grant without this scope is refused before it is stored. */
  requiredScope?: string;
  /** Why the managed service refuses this type; self-hosted deployments only. */
  selfHostedOnly?: string;
  /** Lists the models a sign-in may call, so `broods connect` can print them. */
  modelsUrl?: string;
  /** Where a user reviews what an app draws from their plan. */
  usageUrl?: string;
}

/** Starts a sign-in: `POST /v1/account/connections/{type}/start`. */
export interface ConnectionStart {
  /** The loopback address the provider redirects back to. */
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

/** The provider's consent screen, plus the host id the PUT echoes back. */
export interface ConnectionStartResult {
  authorizeUrl: string;
  hostId: string;
}

/** Finishes a sign-in: `PUT /v1/account/connections/{type}` with the redirect's code. */
export interface ConnectionCode {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
  /** The client OpenAI issued on the redirect. */
  clientId: string;
  hostId: string;
}

/** A connection as the API answers it: never its tokens. */
export interface Connection {
  type: ConnectionType;
  clientId: string;
  /** The deployment's `ext_agent_host_id`, kept across sign-ins. */
  hostId: string;
  email?: string;
  scopes: string[];
  /** ISO 8601 access-token expiry; Broods refreshes it before then. */
  expiresAt: string;
  updatedAt: string;
  /** Answered by a sign-in only: the models the plan may call. */
  models?: string[];
}

// https://developers.openai.com/siwc/token-sharing-open-source
export const CONNECTION_TYPES: Readonly<
  Record<ConnectionType, ConnectionTypeMeta>
> = {
  chatgpt: {
    label: "ChatGPT plan",
    description: "Run agents on model.provider chatgpt with your ChatGPT plan",
    authorizeUrl: `${CHATGPT_ISSUER}/api/accounts/authorize`,
    tokenUrl: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
    revokeUrl: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`,
    jwksUrl: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
    issuer: /^https:\/\/auth\.openai\.com$/,
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      CHATGPT_DIRECT_SCOPE,
    ],
    resource: CHATGPT_RESOURCE,
    requiredScope: CHATGPT_DIRECT_SCOPE,
    // Hosted, paid services need OpenAI's approval before offering plan usage.
    selfHostedOnly:
      "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.",
    modelsUrl: `${CHATGPT_RESOURCE}/models`,
    usageUrl: "https://chatgpt.com/settings/usage",
  },
};

/** Narrows a request path, body or CLI argument to a known connection type. */
export function isConnectionType(value: unknown): value is ConnectionType {
  return CONNECTION_TYPE_NAMES.some((name) => name === value);
}

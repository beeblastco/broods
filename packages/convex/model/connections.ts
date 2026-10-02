/**
 * Connections: external accounts an agent acts through, one of each type per
 * Broods account. `broods connect <type>` opens the provider's sign-in; the
 * deployment exchanges the code on its own OAuth app, checks the ID token and
 * stores the tokens, and core refreshes them from then on. `chatgpt` backs
 * the `chatgpt` model provider; `google` and `microsoft` back MCP servers
 * (Gmail, Outlook) through `config.mcp.<server>.oauth.connection`. Plain data,
 * so the CLI, the config plane, core and the dashboard read one copy. A new
 * type is one entry in CONNECTION_TYPES.
 */

export const CONNECTION_TYPE_NAMES = [
  "chatgpt",
  "google",
  "microsoft",
] as const;

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

export type ConnectionUse = ConnectionTypeMeta["usableBy"];

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
  /** The ID token's `iss`; Microsoft's names the user's tenant. */
  issuer: RegExp;
  scopes: readonly string[];
  /** Extra authorize parameters the provider needs to issue a refresh token. */
  authorizeParams?: Readonly<Record<string, string>>;
  /**
   * Where the OAuth client comes from: `dynamic` registers one at the first
   * sign-in (Sign in with ChatGPT, with a deployment host id); `deployment`
   * is the deployment's own app, read from these environment variables.
   */
  client:
    | { kind: "dynamic" }
    | { kind: "deployment"; idEnv: string; secretEnv?: string };
  /** The API tokens are minted for, sent on every authorize and token request. */
  resource?: string;
  /** The provider wants the granted scopes repeated on every refresh. */
  refreshScopes?: boolean;
  /** A grant without this scope is refused before it is stored. */
  requiredScope?: string;
  /** Why the managed service refuses this type; self-hosted deployments only. */
  selfHostedOnly?: string;
  /** Lists the models a sign-in may call, so `broods connect` can print them. */
  modelsUrl?: string;
  /** Where a user reviews what an app draws from their plan. */
  usageUrl?: string;
  /** What may send its token: the `model` provider, or `mcp` servers. */
  usableBy: "model" | "mcp";
}

/** Starts a sign-in: `POST /v1/account/connections/{type}/start`. */
export interface ConnectionStart {
  /** The loopback address the provider redirects back to. */
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

/** The provider's consent screen, plus the host id a registering type echoes back. */
export interface ConnectionStartResult {
  authorizeUrl: string;
  hostId?: string;
}

/** Finishes a sign-in: `PUT /v1/account/connections/{type}` with the redirect's code. */
export interface ConnectionCode {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
  /** The client a registering type was issued, from the redirect. */
  clientId?: string;
  hostId?: string;
}

/** A connection as the API answers it: never its tokens. */
export interface Connection {
  type: ConnectionType;
  clientId: string;
  /** `chatgpt` only: the deployment's `ext_agent_host_id`, kept across sign-ins. */
  hostId?: string;
  email?: string;
  scopes: string[];
  /** ISO 8601 access-token expiry; Broods refreshes it before then. */
  expiresAt: string;
  updatedAt: string;
  /** Answered by a sign-in only: the models the plan may call. */
  models?: string[];
}

// https://developers.openai.com/siwc/token-sharing-open-source
// https://developers.google.com/identity/protocols/oauth2/native-app
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
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
    client: { kind: "dynamic" },
    resource: CHATGPT_RESOURCE,
    requiredScope: CHATGPT_DIRECT_SCOPE,
    // Hosted, paid services need OpenAI's approval before offering plan usage.
    selfHostedOnly:
      "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.",
    modelsUrl: `${CHATGPT_RESOURCE}/models`,
    usageUrl: "https://chatgpt.com/settings/usage",
    usableBy: "model",
  },
  google: {
    label: "Google",
    description: "Gmail for MCP servers",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: /^(https:\/\/)?accounts\.google\.com$/,
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
    authorizeParams: { access_type: "offline", prompt: "consent" },
    client: {
      kind: "deployment",
      idEnv: "GOOGLE_OAUTH_CLIENT_ID",
      secretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    },
    usableBy: "mcp",
  },
  microsoft: {
    label: "Microsoft",
    description: "Outlook mail for MCP servers",
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    issuer: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/,
    scopes: [
      "openid",
      "email",
      "offline_access",
      "https://graph.microsoft.com/Mail.ReadWrite",
    ],
    client: { kind: "deployment", idEnv: "MICROSOFT_OAUTH_CLIENT_ID" },
    refreshScopes: true,
    usableBy: "mcp",
  },
};

/** Narrows a request path, body or CLI argument to a known connection type. */
export function isConnectionType(value: unknown): value is ConnectionType {
  return CONNECTION_TYPE_NAMES.some((name) => name === value);
}

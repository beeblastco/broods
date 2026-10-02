/**
 * Connections: external accounts an agent acts through, signed in once per
 * Broods account with `broods connect <type>` and refreshed by core from then
 * on. `chatgpt` backs the `chatgpt` model provider; `google` and `microsoft`
 * back MCP servers (Gmail, Outlook, Calendar, Drive) through
 * `config.mcp.<server>.oauth.connection`. Plain data, so the CLI (sign-in),
 * the config plane (store, revoke), core (refresh) and the dashboard read one
 * copy. A new type is one entry in CONNECTION_TYPES.
 */

export const CONNECTION_TYPE_NAMES = [
  "chatgpt",
  "google",
  "microsoft",
] as const;

export type ConnectionType = (typeof CONNECTION_TYPE_NAMES)[number];

export function isConnectionType(value: unknown): value is ConnectionType {
  return CONNECTION_TYPE_NAMES.some((name) => name === value);
}

export interface ConnectionTypeMeta {
  label: string;
  /** What the connection is for, in the CLI and the dashboard. */
  description: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a disconnect revokes the refresh token; absent when there is none. */
  revokeUrl?: string;
  /** Keys that sign the ID token `broods connect` verifies. */
  jwksUrl: string;
  /** The ID token's `iss`; Microsoft's names the user's tenant. */
  issuer: RegExp;
  /** Requested when `broods connect` gets no `--scope`. */
  defaultScopes: readonly string[];
  /** Extra authorize parameters the provider needs to issue a refresh token. */
  authorizeParams?: Readonly<Record<string, string>>;
  /** `chatgpt` registers its own client; the others run on the developer's OAuth app. */
  client: "dynamic" | "own";
  /** Whether the developer's OAuth app secret rides every refresh. */
  needsClientSecret: boolean;
}

/** A verified sign-in for `PUT /v1/account/connections/{name}`; `broods connect` builds it. */
export interface ConnectionSignIn {
  type: ConnectionType;
  /** OAuth client: the one OpenAI issued, or the developer's own app. */
  clientId: string;
  /** The developer's OAuth app secret, for types whose refresh needs it. */
  clientSecret?: string;
  /** `chatgpt` only: the deployment's `ext_agent_host_id`, kept across sign-ins. */
  hostId?: string;
  email?: string;
  scopes: string[];
  /** ISO 8601 access-token expiry. */
  expiresAt: string;
  accessToken: string;
  refreshToken: string;
}

/** A connection as the API answers it: never its tokens or client secret. */
export interface Connection extends Omit<
  ConnectionSignIn,
  "accessToken" | "refreshToken" | "clientSecret"
> {
  name: string;
  updatedAt: string;
}

const CHATGPT_ISSUER = "https://auth.openai.com";

/** The API a ChatGPT access token is minted for, sent on every token request. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";

/** The first ChatGPT sign-in registers a client; OpenAI answers with its real id. */
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The grant that lets requests draw on the user's ChatGPT plan. */
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

/** Where a user reviews and limits what apps draw from their ChatGPT plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * Hosted, paid services need OpenAI's approval before offering plan usage, so
 * the managed service refuses new ChatGPT sign-ins until that approval exists.
 */
export const CHATGPT_MANAGED_SERVICE_REFUSAL =
  "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.";

/** Lowercase letters, digits and dashes, so a name is safe in a URL path. */
export const CONNECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      CHATGPT_DIRECT_SCOPE,
    ],
    client: "dynamic",
    needsClientSecret: false,
  },
  google: {
    label: "Google",
    description: "Gmail, Calendar and Drive for MCP servers",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: /^(https:\/\/)?accounts\.google\.com$/,
    defaultScopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    authorizeParams: { access_type: "offline", prompt: "consent" },
    client: "own",
    needsClientSecret: true,
  },
  microsoft: {
    label: "Microsoft",
    description: "Outlook mail and calendar for MCP servers",
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    issuer: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/,
    defaultScopes: [
      "openid",
      "email",
      "offline_access",
      "https://graph.microsoft.com/Mail.ReadWrite",
    ],
    client: "own",
    needsClientSecret: false,
  },
};

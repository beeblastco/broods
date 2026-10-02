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

const CHATGPT_ISSUER = "https://auth.openai.com";

/** The API a ChatGPT access token is minted for, sent on every token request. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";

/** The first ChatGPT sign-in registers a client; OpenAI answers with its real id. */
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The `chatgpt` model provider reads the connection stored under this name. */
export const CHATGPT_CONNECTION_NAME = "chatgpt";

/** The grant that lets requests draw on the user's ChatGPT plan. */
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

/** Where a user reviews and limits what apps draw from their ChatGPT plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** Lowercase letters, digits and dashes, so a name is safe in a URL path. */
export const CONNECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  /** Keys that sign the ID token `broods connect` verifies. */
  jwksUrl: string;
  /** The ID token's `iss`; Microsoft's names the user's tenant. */
  issuer: RegExp;
  /** Requested when `broods connect` gets no `--scope`. */
  defaultScopes: readonly string[];
  /** Extra authorize parameters the provider needs to issue a refresh token. */
  authorizeParams?: Readonly<Record<string, string>>;
  /**
   * `dynamic` registers a client at the first sign-in (Sign in with ChatGPT,
   * with a deployment host id); `own` runs on the developer's OAuth app.
   */
  client: "dynamic" | "own";
  /** Whether the developer's OAuth app secret rides every refresh. */
  needsClientSecret: boolean;
  /** The API tokens are minted for, sent on every authorize and token request. */
  resource?: string;
  /** The provider wants the granted scopes repeated on every refresh. */
  refreshScopes?: boolean;
  /** A grant without this scope is refused before it is stored. */
  requiredScope?: string;
  /** Why the managed service refuses this type; self-hosted deployments only. */
  selfHostedOnly?: string;
  /** What may send its token: the `model` provider, or `mcp` servers. */
  usableBy: "model" | "mcp";
  /** The one name this type is stored under, because something reads it by name. */
  fixedName?: string;
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
    resource: CHATGPT_RESOURCE,
    requiredScope: CHATGPT_DIRECT_SCOPE,
    // Hosted, paid services need OpenAI's approval before offering plan usage.
    selfHostedOnly:
      "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.",
    usableBy: "model",
    fixedName: CHATGPT_CONNECTION_NAME,
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
    usableBy: "mcp",
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
    refreshScopes: true,
    usableBy: "mcp",
  },
};

/**
 * The `broods connect` command that signs a connection in, with the client
 * flags its type needs; core's errors and the dashboard both print it.
 */
export function connectCommand(type: string, name: string = type): string {
  const meta = isConnectionType(type) ? CONNECTION_TYPES[type] : undefined;
  const nameFlag = name === type ? "" : ` --name ${name}`;
  const clientFlags =
    meta?.client === "own"
      ? ` --client-id <id>${meta.needsClientSecret ? " --client-secret <secret>" : ""}`
      : "";

  return `broods connect ${type}${nameFlag}${clientFlags}`;
}

/** Narrows a request body or CLI argument to a known connection type. */
export function isConnectionType(value: unknown): value is ConnectionType {
  return CONNECTION_TYPE_NAMES.some((name) => name === value);
}

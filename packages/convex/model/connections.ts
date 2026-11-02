export const CONNECTION_TYPE_NAMES = ["chatgpt"] as const;

const CHATGPT_ISSUER = "https://auth.openai.com";

const CHATGPT_RESOURCE = "https://api.openai.com/v1";

// The first ChatGPT sign-in registers a client; OpenAI answers with its real id.
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

export const CHATGPT_AGENT_NAME = "Broods";

export type ConnectionType = (typeof CONNECTION_TYPE_NAMES)[number];

export interface ConnectionTypeMeta {
  label: string;
  description: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  jwksUrl: string;
  issuer: string;
  scopes: readonly string[];
  resource?: string;
  requiredScope?: string;
  /** Why the managed service refuses this type. */
  selfHostedOnly?: string;
  managedOptIn?: string;
  modelsUrl?: string;
  usageUrl?: string;
}

export interface ConnectionStart {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export interface ConnectionStartResult {
  authorizeUrl: string;
  clientId: string;
  hostId: string;
}

export interface ConnectionCode {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
  /** The client OpenAI issued on the redirect, else the one `start` answered. */
  clientId: string;
  hostId: string;
}

export interface Connection {
  type: ConnectionType;
  clientId: string;
  hostId: string;
  email?: string;
  scopes: string[];
  expiresAt: string;
  updatedAt: string;
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
    issuer: CHATGPT_ISSUER,
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
    selfHostedOnly:
      "ChatGPT plan usage is only available on self-hosted Broods for now. Use an OpenAI API key with the `openai` provider instead.",
    // Set to `true` on a deployment OpenAI approved for hosted use; plan limits stay on.
    managedOptIn: "CHATGPT_PLAN_ENABLED",
    modelsUrl: `${CHATGPT_RESOURCE}/models`,
    usageUrl: "https://chatgpt.com/settings/usage",
  },
};

export function isConnectionType(value: unknown): value is ConnectionType {
  return CONNECTION_TYPE_NAMES.some((name) => name === value);
}

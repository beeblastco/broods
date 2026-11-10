import type { JWTVerifyGetKey } from "jose";
import type { AuthContext } from "../../shared/auth.ts";
import { getHarnessPublicUrl, optionalEnv } from "../../shared/env.ts";
import { errorResponse } from "../../shared/http.ts";
import { getStorage } from "../../shared/storage.ts";

export const MCP_PATH = "/mcp";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

let keySet: { domain: string; keys: JWTVerifyGetKey } | null = null;

export type AuthKitAuth =
  | { kind: "signed-in"; auth: Extract<AuthContext, { kind: "account" }> }
  | { kind: "refused"; message: string }
  | { kind: "invalid" };

/** Answers `/.well-known/oauth-protected-resource[/mcp]`, which MCP clients read after a 401. */
export function handleProtectedResourceRequest(): Response {
  const config = authKitConfig();
  if (!config) {
    return errorResponse(404, "This deployment has no OAuth sign-in for /mcp");
  }

  return Response.json({
    resource: config.resource,
    authorization_servers: [config.domain],
    bearer_methods_supported: ["header"],
    resource_name: "Broods",
  });
}

/** The 401 for `/mcp`: points an OAuth-capable client at AuthKit when it is configured. */
export function mcpUnauthorized(invalidToken: boolean): Response {
  const config = authKitConfig();
  const refused = errorResponse(
    401,
    config
      ? "Sign in through OAuth, or send Authorization: Bearer <account key or runtime key>."
      : "Send Authorization: Bearer <key>, with a runtime key for a stage's public agents or an account key for every agent.",
  );
  const challenge = ['Bearer realm="broods"'];
  if (invalidToken) challenge.push('error="invalid_token"');
  if (config) challenge.push(`resource_metadata="${config.metadataUrl}"`);
  refused.headers.set("WWW-Authenticate", challenge.join(", "));

  return refused;
}

/** An AuthKit access token for `/mcp`, signed in as the account `broods login` would give. */
export async function resolveAuthKitAuth(
  token: string,
  org: string | undefined,
): Promise<AuthKitAuth> {
  const config = authKitConfig();
  if (!config || !JWT_SHAPE.test(token)) return { kind: "invalid" };
  let subject: string | undefined;
  try {
    subject = await verifiedSubject(token, config);
  } catch {
    return { kind: "invalid" };
  }
  if (!subject) return { kind: "invalid" };
  const login = await getStorage().accounts.getForUser(subject, org);
  if ("refused" in login) return { kind: "refused", message: login.refused };

  return {
    kind: "signed-in",
    auth: { kind: "account", account: login.account },
  };
}

export function routesToProtectedResource(path: string): boolean {
  return (
    path === PROTECTED_RESOURCE_PATH ||
    path === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`
  );
}

function authKitConfig(): {
  domain: string;
  resource: string;
  metadataUrl: string;
} | null {
  const domain = optionalEnv("WORKOS_AUTHKIT_DOMAIN")?.replace(/\/+$/, "");
  const base = getHarnessPublicUrl();
  if (!domain || !base) return null;

  return {
    domain: domain.startsWith("https://") ? domain : `https://${domain}`,
    resource: `${base}${MCP_PATH}`,
    metadataUrl: `${base}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
  };
}

async function verifiedSubject(
  token: string,
  config: { domain: string; resource: string },
): Promise<string | undefined> {
  // Lazy: the Teams SDK `require`s jose as core loads, which fails once jose is ESM-loaded.
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  // jose caches the fetched keys and refetches on an unknown `kid`.
  if (keySet?.domain !== config.domain) {
    keySet = {
      domain: config.domain,
      keys: createRemoteJWKSet(new URL("/oauth2/jwks", config.domain)),
    };
  }
  const { payload } = await jwtVerify(token, keySet.keys, {
    issuer: config.domain,
    audience: config.resource,
  });

  return payload.sub;
}

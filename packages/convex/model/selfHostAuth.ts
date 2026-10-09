/**
 * The self-hosted sign-in, shared by the dashboard that issues its session
 * token, the Convex auth config that trusts it, and the local stack that makes
 * the key pair. A self-hosted stack has one user, the admin, who signs in with
 * the stack's ADMIN_ACCOUNT_SECRET; no identity provider and no internet.
 */

// Convex wants a URL-shaped issuer; it is never fetched, the key set is inline.
export const SELF_HOST_ISSUER = "https://self-host.broods.local";
export const SELF_HOST_AUDIENCE = "broods-dashboard";
export const SELF_HOST_ALGORITHM = "ES256";
export const SELF_HOST_KEY_ID = "broods-self-host";

/** The one user a self-hosted stack has; the session token carries these claims. */
export const SELF_HOST_ADMIN = {
  email: "admin@broods.local",
  firstName: "Admin",
  subject: "self-host-admin",
} as const;

/** The public half of a private JWK: everything but `d`. */
export function publicJwk<Jwk extends { d?: string }>(
  privateJwk: Jwk,
): Omit<Jwk, "d"> {
  const { d: _d, ...publicKey } = privateJwk;

  return publicKey;
}

export type AuthProvider = "self-host" | "workos";

/**
 * Which sign-in this deployment trusts, from BROODS_AUTH_PROVIDER. Every
 * deployment sets it: the deploy evaluates auth.config.ts on the backend,
 * where reading an unset variable fails the deploy, so the config cannot
 * probe for an optional variable and branch on it. Each branch then reads
 * only its own variables.
 */
export function authProvider(): AuthProvider {
  const value = process.env.BROODS_AUTH_PROVIDER;
  if (value === "self-host" || value === "workos") return value;
  throw new Error(
    `BROODS_AUTH_PROVIDER must be "workos" or "self-host", got ${JSON.stringify(value)}`,
  );
}

/** The key set a self-hosted deployment trusts: the public half of the dashboard's BROODS_SESSION_SIGNING_KEY. */
export function selfHostJwks(): string {
  const jwks = process.env.BROODS_SESSION_JWKS;
  if (!jwks) throw new Error("BROODS_SESSION_JWKS is not set");

  return jwks;
}

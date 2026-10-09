/**
 * Which sign-in a deployment trusts, and the self-hosted one: shared by the
 * dashboard that issues its session token, the Convex auth config that trusts
 * it, and the local stack that makes the key pair. A self-hosted stack has one
 * user, the admin, who signs in with the stack's ADMIN_ACCOUNT_SECRET; no
 * identity provider and no internet.
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

/** Which sign-in this deployment trusts, from BROODS_AUTH_PROVIDER; every deployment sets it. */
export function authProvider(): "self-host" | "workos" {
  const value = process.env.BROODS_AUTH_PROVIDER;
  if (value === "self-host" || value === "workos") return value;
  throw new Error(
    `BROODS_AUTH_PROVIDER must be "workos" or "self-host", got ${JSON.stringify(value)}`,
  );
}

/** The key set a self-hosted deployment trusts: the public half of the dashboard's signing key. */
export function selfHostJwks(): string {
  const jwks = process.env.BROODS_SESSION_JWKS;
  if (!jwks) throw new Error("BROODS_SESSION_JWKS is not set");

  return jwks;
}

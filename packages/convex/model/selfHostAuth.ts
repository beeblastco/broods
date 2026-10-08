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

/**
 * The key set Convex trusts on a self-hosted deployment, or undefined on the
 * managed service. Read through here so every check agrees on what "set" is.
 */
export function selfHostJwks(): string | undefined {
  return process.env.BROODS_SESSION_JWKS || undefined;
}

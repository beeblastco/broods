// Convex wants a URL-shaped issuer; it is never fetched, the key set is inline.
export const SELF_HOST_ISSUER = "https://self-host.broods.local";
export const SELF_HOST_AUDIENCE = "broods-dashboard";
export const SELF_HOST_ALGORITHM = "ES256";
export const SELF_HOST_KEY_ID = "broods-self-host";

export const SELF_HOST_ADMIN = {
  email: "admin@broods.local",
  firstName: "Admin",
  subject: "self-host-admin",
} as const;

export function publicJwk<Jwk extends { d?: string }>(
  privateJwk: Jwk,
): Omit<Jwk, "d"> {
  const { d: _d, ...publicKey } = privateJwk;

  return publicKey;
}

export function authProvider(): "self-host" | "workos" {
  const value = process.env.BROODS_AUTH_PROVIDER;
  if (value === "self-host" || value === "workos") return value;
  throw new Error(
    `BROODS_AUTH_PROVIDER must be "workos" or "self-host", got ${JSON.stringify(value)}. Set it on the deployment: npx convex env set BROODS_AUTH_PROVIDER workos`,
  );
}

export function selfHostJwks(): string {
  const jwks = process.env.BROODS_SESSION_JWKS;
  if (!jwks) throw new Error("BROODS_SESSION_JWKS is not set");

  return jwks;
}

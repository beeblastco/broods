import {
  SELF_HOST_ADMIN,
  SELF_HOST_AUDIENCE,
  SELF_HOST_ISSUER,
} from "@broods/convex/model/selfHostAuth";
import { SignJWT, importJWK, jwtVerify, type JWK } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "@/app/lib/session";

/** httpOnly cookie holding the session token; the token is also what Convex verifies. */
export const SESSION_COOKIE = "broods-session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const KEY_ID = "broods-self-host";

/**
 * Self-hosted when the stack hands the dashboard a session signing key
 * (`BROODS_SESSION_SIGNING_KEY`, a private ES256 JWK). The admin then signs
 * in with ADMIN_ACCOUNT_SECRET instead of WorkOS.
 */
export const selfHosted = Boolean(process.env.BROODS_SESSION_SIGNING_KEY);

type SigningKey = Awaited<ReturnType<typeof importJWK>>;

let signingKeys:
  | Promise<{ privateKey: SigningKey; publicKey: SigningKey }>
  | undefined;

/** Whether `key` is the stack's admin secret. Compares digests, in constant time. */
export function adminKeyMatches(key: string): boolean {
  const secret = process.env.ADMIN_ACCOUNT_SECRET;
  if (!secret) return false;

  return timingSafeEqual(digest(key), digest(secret));
}

/** The signed-in admin, or null when `token` is missing, expired or not ours. */
export async function sessionUser(
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    await jwtVerify(token, (await keys()).publicKey, {
      audience: SELF_HOST_AUDIENCE,
      issuer: SELF_HOST_ISSUER,
    });
  } catch {
    return null;
  }

  return {
    email: SELF_HOST_ADMIN.email,
    firstName: SELF_HOST_ADMIN.firstName,
    id: SELF_HOST_ADMIN.subject,
    lastName: null,
    profilePictureUrl: null,
  };
}

/** A session token for the admin, signed with the stack's key. */
export async function signSessionToken(): Promise<string> {
  return new SignJWT({
    email: SELF_HOST_ADMIN.email,
    given_name: SELF_HOST_ADMIN.firstName,
  })
    .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
    .setIssuer(SELF_HOST_ISSUER)
    .setAudience(SELF_HOST_AUDIENCE)
    .setSubject(SELF_HOST_ADMIN.subject)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign((await keys()).privateKey);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// The public half is the private JWK without `d`.
function keys(): Promise<{ privateKey: SigningKey; publicKey: SigningKey }> {
  signingKeys ??= (async () => {
    const jwk: JWK = JSON.parse(process.env.BROODS_SESSION_SIGNING_KEY ?? "");
    const { d: _d, ...publicJwk } = jwk;

    return {
      privateKey: await importJWK(jwk, "ES256"),
      publicKey: await importJWK(publicJwk, "ES256"),
    };
  })();

  return signingKeys;
}

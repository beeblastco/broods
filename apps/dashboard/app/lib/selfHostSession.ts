import {
  SELF_HOST_ADMIN,
  SELF_HOST_ALGORITHM,
  SELF_HOST_AUDIENCE,
  SELF_HOST_ISSUER,
  SELF_HOST_KEY_ID,
  publicJwk,
} from "@broods/convex/model/selfHostAuth";
import { SignJWT, importJWK, jwtVerify, type JWK } from "jose";
import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "@/app/lib/session";

/** httpOnly cookie holding the session token; the token is also what Convex verifies. */
export const SESSION_COOKIE = "broods-session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Self-hosted when the stack hands the dashboard a session signing key
 * (`BROODS_SESSION_SIGNING_KEY`, a private ES256 JWK). The admin then signs
 * in with ADMIN_ACCOUNT_SECRET instead of WorkOS.
 */
export const selfHosted = Boolean(process.env.BROODS_SESSION_SIGNING_KEY);

const ADMIN: SessionUser = {
  email: SELF_HOST_ADMIN.email,
  firstName: SELF_HOST_ADMIN.firstName,
  id: SELF_HOST_ADMIN.subject,
  lastName: null,
  profilePictureUrl: null,
};

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

/** The signed-in admin and their token from this request's cookie, or null. */
export async function currentSession(): Promise<{
  token: string;
  user: SessionUser;
} | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token))) return null;

  return { token: token, user: ADMIN };
}

/** The admin-key page, coming back to `returnTo`; `rejected` shows the wrong-key error. */
export function keyPageUrl(base: URL, returnTo: string, rejected = false): URL {
  const keyPage = new URL("/auth/key", base);
  keyPage.searchParams.set("returnTo", returnTo);
  if (rejected) keyPage.searchParams.set("error", "1");

  return keyPage;
}

/** A session token for the admin, signed with the stack's key. */
export async function signSessionToken(): Promise<string> {
  return new SignJWT({
    email: SELF_HOST_ADMIN.email,
    given_name: SELF_HOST_ADMIN.firstName,
  })
    .setProtectedHeader({ alg: SELF_HOST_ALGORITHM, kid: SELF_HOST_KEY_ID })
    .setIssuer(SELF_HOST_ISSUER)
    .setAudience(SELF_HOST_AUDIENCE)
    .setSubject(SELF_HOST_ADMIN.subject)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign((await keys()).privateKey);
}

/** Whether `token` is an unexpired session token signed with the stack's key. */
export async function verifySessionToken(
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, (await keys()).publicKey, {
      audience: SELF_HOST_AUDIENCE,
      issuer: SELF_HOST_ISSUER,
    });

    return true;
  } catch {
    return false;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function keys(): Promise<{ privateKey: SigningKey; publicKey: SigningKey }> {
  signingKeys ??= (async () => {
    const jwk: JWK = JSON.parse(process.env.BROODS_SESSION_SIGNING_KEY ?? "");

    return {
      privateKey: await importJWK(jwk, SELF_HOST_ALGORITHM),
      publicKey: await importJWK(publicJwk(jwk), SELF_HOST_ALGORITHM),
    };
  })();

  return signingKeys;
}

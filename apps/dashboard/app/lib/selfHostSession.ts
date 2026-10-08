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
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "@/app/lib/session";

/** httpOnly cookie holding the session token, which only the dashboard accepts. */
export const SESSION_COOKIE = "broods-session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
// The session token's audience. Convex trusts only SELF_HOST_AUDIENCE, so the
// cookie's token is useless to it; the browser gets short Convex tokens.
const SESSION_AUDIENCE = "broods-dashboard-session";
// A Convex token copied before sign-out dies within this.
const CONVEX_TOKEN_TTL_SECONDS = 15 * 60;
// Long enough that guessing it through the sign-in form is hopeless.
const MIN_ADMIN_SECRET_LENGTH = 32;

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

const ADMIN_SECRET = process.env.ADMIN_ACCOUNT_SECRET?.trim() ?? "";

// Checked at startup, so a malformed key or a guessable secret fails the
// server loudly instead of every sign-in.
const SIGNING_JWK: JWK | null = selfHosted
  ? JSON.parse(process.env.BROODS_SESSION_SIGNING_KEY ?? "")
  : null;
if (selfHosted && ADMIN_SECRET.length < MIN_ADMIN_SECRET_LENGTH) {
  throw new Error(
    `ADMIN_ACCOUNT_SECRET must be at least ${MIN_ADMIN_SECRET_LENGTH} characters on a self-hosted dashboard`,
  );
}

type SigningKey = Awaited<ReturnType<typeof importJWK>>;

let signingKeys:
  | Promise<{ privateKey: SigningKey; publicKey: SigningKey }>
  | undefined;

/**
 * Whether `key` is the stack's admin secret, both trimmed: a pasted key often
 * carries a newline. Compares digests, in constant time.
 */
export function adminKeyMatches(key: string): boolean {
  if (!ADMIN_SECRET) return false;

  return timingSafeEqual(digest(key.trim()), digest(ADMIN_SECRET));
}

/**
 * The signed-in admin from this request's session cookie, with a fresh
 * short-lived token for Convex, or null when signed out.
 */
export async function currentSession(): Promise<{
  token: string;
  user: SessionUser;
} | null> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(session))) return null;

  return {
    token: await signToken(SELF_HOST_AUDIENCE, CONVEX_TOKEN_TTL_SECONDS),
    user: ADMIN,
  };
}

/** The admin-key page, coming back to `returnTo`; `rejected` shows the wrong-key error. */
export function keyPagePath(returnTo: string, rejected = false): string {
  const query = new URLSearchParams({ returnTo: returnTo });
  if (rejected) query.set("error", "1");

  return `/auth/key?${query}`;
}

/**
 * A redirect to a same-origin `path`, as a relative Location: behind a proxy
 * the request URL can carry the server's bind host, not the public one.
 */
export function redirectToPath(path: string, status = 307): NextResponse {
  return new NextResponse(null, {
    headers: { Location: path },
    status: status,
  });
}

/** A session token for the cookie, signed with the stack's key. */
export async function signSessionToken(): Promise<string> {
  return signToken(SESSION_AUDIENCE, SESSION_TTL_SECONDS);
}

/** Whether `token` is an unexpired session token signed with the stack's key. */
export async function verifySessionToken(
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, (await keys()).publicKey, {
      audience: SESSION_AUDIENCE,
      issuer: SELF_HOST_ISSUER,
    });

    return true;
  } catch {
    return false;
  }
}

// SHA-256, so `timingSafeEqual` compares equal lengths whatever was typed.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// The imported signing key and its public half, once per process.
function keys(): Promise<{ privateKey: SigningKey; publicKey: SigningKey }> {
  signingKeys ??= (async () => {
    const jwk = SIGNING_JWK ?? {};

    return {
      privateKey: await importJWK(jwk, SELF_HOST_ALGORITHM),
      publicKey: await importJWK(publicJwk(jwk), SELF_HOST_ALGORITHM),
    };
  })();

  return signingKeys;
}

// An admin token for `audience`, valid for `ttlSeconds`.
async function signToken(
  audience: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({
    email: SELF_HOST_ADMIN.email,
    given_name: SELF_HOST_ADMIN.firstName,
  })
    .setProtectedHeader({ alg: SELF_HOST_ALGORITHM, kid: SELF_HOST_KEY_ID })
    .setIssuer(SELF_HOST_ISSUER)
    .setAudience(audience)
    .setSubject(SELF_HOST_ADMIN.subject)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign((await keys()).privateKey);
}

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

export const SESSION_COOKIE = "broods-session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
// Convex trusts only SELF_HOST_AUDIENCE, so the cookie's token is useless to it.
const SESSION_AUDIENCE = "broods-dashboard-session";
// A Convex token copied before sign-out dies within this.
const CONVEX_TOKEN_TTL_SECONDS = 15 * 60;
const MIN_ADMIN_SECRET_LENGTH = 32;

export const selfHosted = Boolean(process.env.BROODS_SESSION_SIGNING_KEY);

const ADMIN: SessionUser = {
  email: SELF_HOST_ADMIN.email,
  firstName: SELF_HOST_ADMIN.firstName,
  id: SELF_HOST_ADMIN.subject,
  lastName: null,
  profilePictureUrl: null,
};

const ADMIN_SECRET = process.env.ADMIN_ACCOUNT_SECRET?.trim() ?? "";

// Checked at startup, so a bad key or a guessable secret fails the server, not each sign-in.
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

export function adminKeyMatches(key: string): boolean {
  if (!ADMIN_SECRET) return false;

  return timingSafeEqual(digest(key.trim()), digest(ADMIN_SECRET));
}

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

export function keyPagePath(returnTo: string, rejected = false): string {
  const query = new URLSearchParams({ returnTo: returnTo });
  if (rejected) query.set("error", "1");

  return `/auth/key?${query}`;
}

// Relative Location: behind a proxy the request URL can carry the bind host, not the public one.
export function redirectToPath(path: string, status = 307): NextResponse {
  return new NextResponse(null, {
    headers: { Location: path },
    status: status,
  });
}

export async function signSessionToken(): Promise<string> {
  return signToken(SESSION_AUDIENCE, SESSION_TTL_SECONDS);
}

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

// `timingSafeEqual` throws on unequal lengths, so compare fixed-size digests.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

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

/**
 * Bearer-token auth: admin secret, service token (for cherry-coke
 * server-side actions), and account-secret hash lookup. Persistence is
 * reached via `getStorage().accounts.*` so the auth path is identical
 * across DynamoDB and Convex modes.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "./env.ts";
import {
  hashAccountSecret,
  type AccountRecord,
} from "./storage/accounts.ts";
import { getStorage } from "./storage/index.ts";

export type AuthContext =
  | { kind: "admin" }
  | { kind: "account"; account: AccountRecord; viaServiceToken?: boolean };

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token, ...rest] = authorization.trim().split(/\s+/);
  if (rest.length > 0 || !scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

export async function resolveBearerAuth(headers: Record<string, string>): Promise<AuthContext | null> {
  const token = extractBearerToken(headers.authorization);
  if (!token) return null;

  const adminSecret = optionalEnv("ADMIN_ACCOUNT_SECRET");
  if (adminSecret && timingSafeStringEqual(token, adminSecret)) {
    return { kind: "admin" };
  }

  // Service-token branch: used by cherry-coke server-side actions. Must
  // accompany an X-Account-Id header. The token is shared between all
  // SaaS callers; the account scope comes from the header.
  const serviceSecret = optionalEnv("SERVICE_AUTH_SECRET");
  if (serviceSecret && timingSafeStringEqual(token, serviceSecret)) {
    const accountId = headers["x-account-id"] ?? headers["X-Account-Id"];
    if (!accountId) return null;
    const account = await getStorage().accounts.getById(accountId);
    if (!account || account.status !== "active") return null;
    return { kind: "account", account, viaServiceToken: true };
  }

  const account = await getStorage().accounts.getBySecretHash(hashAccountSecret(token));
  if (!account || account.status !== "active") return null;
  return { kind: "account", account };
}

// Hashing both sides keeps the comparison constant-time regardless of length.
export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

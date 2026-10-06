/**
 * Bearer-token auth: admin secret, service token (for cherry-coke
 * server-side actions), assume-role session (bsts_), stage session ticket
 * (bdts_), runtime key (bsk_, whose lastUsedAt is written here, throttled),
 * and account-key hash lookup (bask_). Each prefix goes straight to its one
 * lookup; any other token is refused without one.
 * Persistence is reached via `getStorage()` so the auth path is identical
 * through the Convex-backed store.
 */

import {
  ACCOUNT_KEY_PREFIX,
  RUNTIME_KEY_PREFIX,
} from "@broods/convex/model/accountSecrets";
import type { RolePrincipal } from "@broods/convex/model/apiAuthorization";
import { ROLE_SESSION_TOKEN_PREFIX } from "@broods/convex/model/roleRules";
import { VIA_GATEWAY_HEADER } from "@broods/convex/model/serviceBridge";
import {
  openStageSessionTicket,
  STAGE_SESSION_TICKET_PREFIX,
} from "@broods/convex/model/stageSessionTicket";
import { createHash, timingSafeEqual } from "node:crypto";
import { hashAccountSecret, type AccountRecord } from "./domain/accounts.ts";
import { optionalEnv, requireEnv } from "./env.ts";
import { waitUntil } from "./in-flight.ts";
import { getStorage } from "./storage.ts";

const KEY_LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

// Last lastUsedAt write per runtime key hash. Core runs single replica, so
// this in-process map is the whole throttle.
const keyLastUsedWrites = new Map<string, number>();

export type AuthContext =
  | { kind: "admin" }
  | { kind: "account"; account: AccountRecord; viaServiceToken?: boolean }
  | {
      // Project + stage scoped runtime key. It does not bind to a single
      // agent. The agent is chosen per request by id and loaded against this
      // account, so any deployed agent in the stage is reachable.
      kind: "deployment";
      account: AccountRecord;
      endpointId: string;
      projectSlug: string;
      stageSlug: string;
      // Set for a member-minted bdts_ ticket, unset for the embeddable key.
      stageTicket?: true;
    }
  | {
      // Short-lived assume-role session minted by the config plane. What it
      // may do is decided per request by `authorize()` over `role.policy`.
      kind: "role";
      account: AccountRecord;
      role: RolePrincipal;
    };

/**
 * Whether a runtime key's lastUsedAt write is due, recording `now` when it
 * is. `resolveBearerAuth` calls it so a key costs one Convex write per
 * interval instead of one per request.
 */
export function claimLastUsedWrite(
  writes: Map<string, number>,
  apiKeyHash: string,
  now: number,
  intervalMs: number = KEY_LAST_USED_WRITE_INTERVAL_MS,
): boolean {
  const last = writes.get(apiKeyHash);
  if (last !== undefined && now - last < intervalMs) return false;
  // Expired entries would be claimed again anyway, so drop them to keep the
  // map to keys used within the last interval.
  for (const [hash, at] of writes) {
    if (now - at >= intervalMs) writes.delete(hash);
  }
  writes.set(apiKeyHash, now);

  return true;
}

export function extractBearerToken(
  authorization: string | undefined,
): string | null {
  if (!authorization) return null;
  const [scheme, token, ...rest] = authorization.trim().split(/\s+/);
  if (
    rest.length > 0 ||
    !scheme ||
    !token ||
    scheme.toLowerCase() !== "bearer"
  ) {
    return null;
  }

  return token;
}

/** The service token is in-cluster only: never valid on a request through the public door. */
export function isServiceToken(
  headers: Record<string, string>,
  token: string,
): boolean {
  if (headers[VIA_GATEWAY_HEADER] !== undefined) return false;
  const serviceSecret = optionalEnv("SERVICE_AUTH_SECRET");

  return (
    serviceSecret !== undefined && timingSafeStringEqual(token, serviceSecret)
  );
}

export async function resolveBearerAuth(
  headers: Record<string, string>,
  options: { allowDisabledAccountSecret?: boolean } = {},
): Promise<AuthContext | null> {
  const token = extractBearerToken(headers.authorization);
  if (!token) return null;

  // bsts_ is prefix-routed: a role session resolves as a role or not at all.
  if (token.startsWith(ROLE_SESSION_TOKEN_PREFIX)) {
    return await resolveRoleSessionAuth(token);
  }
  // bdts_ likewise: a dashboard stage session is a deployment or nothing.
  if (token.startsWith(STAGE_SESSION_TICKET_PREFIX)) {
    return await resolveStageSessionAuth(token);
  }

  const adminSecret = optionalEnv("ADMIN_ACCOUNT_SECRET");
  if (adminSecret && timingSafeStringEqual(token, adminSecret)) {
    return { kind: "admin" };
  }

  // Service-token branch: used by cherry-coke server-side actions. Must
  // accompany an X-Account-Id header. The token is shared between all
  // SaaS callers; the account scope comes from the header.
  if (isServiceToken(headers, token)) {
    const accountId = headers["x-account-id"] ?? headers["X-Account-Id"];
    if (!accountId) return null;
    const account = await getStorage().accounts.getById(accountId);
    if (!account || account.status !== "active") return null;

    return { kind: "account", account: account, viaServiceToken: true };
  }

  if (token.startsWith(ACCOUNT_KEY_PREFIX)) {
    return await resolveAccountSecretAuth(token, options);
  }
  if (token.startsWith(RUNTIME_KEY_PREFIX)) {
    return await resolveRuntimeKeyAuth(token);
  }

  return null;
}

// Hashing both sides keeps the comparison constant-time regardless of length.
export function timingSafeStringEqual(
  actual: string,
  expected: string,
): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(actualDigest, expectedDigest);
}

/** Resolve an account key to its account; a disabled one only when the caller allows it. */
async function resolveAccountSecretAuth(
  token: string,
  options: { allowDisabledAccountSecret?: boolean },
): Promise<AuthContext | null> {
  const account = await getStorage().accounts.getBySecretHash(
    hashAccountSecret(token),
  );
  if (
    !account ||
    (account.status !== "active" && options.allowDisabledAccountSecret !== true)
  )
    return null;

  return { kind: "account", account: account };
}

/** Resolve a bsts_ token to role auth via the config-plane session store. */
async function resolveRoleSessionAuth(
  token: string,
): Promise<AuthContext | null> {
  const principal = await getStorage().roleSessions.resolveByTokenHash(
    sha256Hex(token),
  );
  if (!principal) return null;
  const account = await getStorage().accounts.getById(principal.accountId);
  if (!account || account.status !== "active") return null;

  return { kind: "role", account: account, role: principal };
}

/** Resolve a runtime key in one lookup, stamping its lastUsedAt (throttled). */
async function resolveRuntimeKeyAuth(
  token: string,
): Promise<AuthContext | null> {
  const apiKeyHash = sha256Hex(token);
  const deployment =
    await getStorage().agentDeployments.getByApiKeyHash(apiKeyHash);
  if (!deployment || deployment.account.status !== "active") return null;
  const now = Date.now();
  if (claimLastUsedWrite(keyLastUsedWrites, apiKeyHash, now)) {
    waitUntil(getStorage().agentDeployments.touchLastUsed(apiKeyHash, now));
  }

  return {
    kind: "deployment",
    account: deployment.account,
    endpointId: deployment.endpointId,
    projectSlug: deployment.projectSlug,
    stageSlug: deployment.stageSlug,
  };
}

/**
 * Resolve a bdts_ ticket the config plane minted for an org member. It is
 * the stage's deployment credential for its lifetime, so it lands on the same
 * `deployment` branch a runtime key does, marked so the embeddable-key limits
 * skip it.
 */
async function resolveStageSessionAuth(
  token: string,
): Promise<AuthContext | null> {
  const ticket = await openStageSessionTicket(
    token,
    requireEnv("STAGE_TICKET_SECRET"),
  );
  if (!ticket) return null;
  const account = await getStorage().accounts.getById(ticket.accountId);
  if (!account || account.status !== "active") return null;

  return {
    kind: "deployment",
    account: account,
    endpointId: ticket.endpointId,
    projectSlug: ticket.projectSlug,
    stageSlug: ticket.stageSlug,
    stageTicket: true,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

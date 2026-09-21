/**
 * Bearer-token auth: admin secret, service token (for cherry-coke
 * server-side actions), assume-role session (fp_sts_), and account-secret
 * hash lookup. Persistence is reached via `getStorage().accounts.*` so the
 * auth path is identical through the Convex-backed account store.
 */

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
import { getStorage } from "./storage.ts";

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
      // Set for a member-minted fp_dts_ ticket, unset for the embeddable key.
      stageTicket?: true;
    }
  | {
      // Short-lived assume-role session minted by the config plane. What it
      // may do is decided per request by `authorize()` over `role.policy`.
      kind: "role";
      account: AccountRecord;
      role: RolePrincipal;
    };

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

/**
 * Whether `token` is the service token on a request that may use it. The token
 * is for in-cluster callers only, so a request the gateway proxied never
 * qualifies, whatever it carries.
 */
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

  // fp_sts_ is prefix-routed: a role session resolves as a role or not at all.
  if (token.startsWith(ROLE_SESSION_TOKEN_PREFIX)) {
    return await resolveRoleSessionAuth(token);
  }
  // fp_dts_ likewise: a dashboard stage session is a deployment or nothing.
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

  const deployment = await getStorage().agentDeployments.getByApiKeyHash(
    sha256Hex(token),
  );
  if (deployment) {
    const account = await getStorage().accounts.getById(deployment.accountId);
    if (!account || account.status !== "active") return null;

    return {
      kind: "deployment",
      account: account,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
    };
  }

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

// Hashing both sides keeps the comparison constant-time regardless of length.
export function timingSafeStringEqual(
  actual: string,
  expected: string,
): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(actualDigest, expectedDigest);
}

/** Resolve an fp_sts_ token to role auth via the config-plane session store. */
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

/**
 * Resolve an fp_dts_ ticket the config plane minted for an org member. It is
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

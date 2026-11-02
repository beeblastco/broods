import {
  ACCOUNT_KEY_PREFIX,
  RUNTIME_KEY_PREFIX,
} from "@broods/convex/model/accountSecrets";
import type { RolePrincipal } from "@broods/convex/model/apiAuthorization";
import { RUN_TOKEN_PREFIX } from "@broods/convex/model/principal";
import { ROLE_SESSION_TOKEN_PREFIX } from "@broods/convex/model/roleRules";
import { VIA_GATEWAY_HEADER } from "@broods/convex/model/serviceBridge";
import {
  openStageSessionTicket,
  STAGE_SESSION_TICKET_PREFIX,
} from "@broods/convex/model/stageSessionTicket";
import {
  openUserToken,
  USER_TOKEN_HEADER,
  type UserToken,
} from "@broods/convex/model/userToken";
import { createHash, timingSafeEqual } from "node:crypto";
import { decryptAccountBlob } from "./convex/account-keys.ts";
import { hashAccountSecret, type AccountRecord } from "./domain/accounts.ts";
import { optionalEnv, requireEnv } from "./env.ts";
import { waitUntil } from "./in-flight.ts";
import { openRunToken } from "./run-token.ts";
import { getStorage } from "./storage.ts";

const KEY_LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

// Core runs single replica, so this in-process map is the whole lastUsedAt throttle.
const keyLastUsedWrites = new Map<string, number>();

export type AuthContext =
  | { kind: "admin" }
  | { kind: "account"; account: AccountRecord; viaServiceToken?: boolean }
  | {
      kind: "deployment";
      account: AccountRecord;
      endpointId: string;
      projectSlug: string;
      stageSlug: string;
      // Set for a member's bdts_ ticket, which the embeddable-key limits skip.
      stageTicket?: StageTicketScope;
      // Every conversation the request touches lives under this user's namespace.
      user?: UserToken;
    }
  | {
      // A bsts_ session or scoped bask_ key; `authorize()` checks each request.
      kind: "role";
      account: AccountRecord;
      role: RolePrincipal;
    }
  | {
      // A brt_ run token: integrations.ts refuses all but its own agent's runs.
      kind: "agent";
      account: AccountRecord;
      agentId: string;
    };

export interface StageTicketScope {
  projectId: string;
  stageId: string;
  sandboxWrite: boolean;
  expiresAt: number;
}

export function claimLastUsedWrite(
  writes: Map<string, number>,
  apiKeyHash: string,
  now: number,
  intervalMs: number = KEY_LAST_USED_WRITE_INTERVAL_MS,
): boolean {
  const last = writes.get(apiKeyHash);
  if (last !== undefined && now - last < intervalMs) return false;
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

  // A prefixed token resolves through its own lookup or not at all.
  if (token.startsWith(ROLE_SESSION_TOKEN_PREFIX)) {
    return await resolveRoleSessionAuth(token);
  }
  if (token.startsWith(STAGE_SESSION_TICKET_PREFIX)) {
    return await resolveStageSessionAuth(token);
  }
  if (token.startsWith(RUN_TOKEN_PREFIX)) {
    return await resolveRunTokenAuth(token);
  }

  const adminSecret = optionalEnv("ADMIN_ACCOUNT_SECRET");
  if (adminSecret && timingSafeStringEqual(token, adminSecret)) {
    return { kind: "admin" };
  }

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
    return await resolveRuntimeKeyAuth(token, headers[USER_TOKEN_HEADER]);
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

async function resolveAccountSecretAuth(
  token: string,
  options: { allowDisabledAccountSecret?: boolean },
): Promise<AuthContext | null> {
  const keyHash = hashAccountSecret(token);
  const account = await getStorage().accounts.getBySecretHash(keyHash);
  if (!account) return await resolveScopedKeyAuth(keyHash);
  if (
    account.status !== "active" &&
    options.allowDisabledAccountSecret !== true
  )
    return null;

  return { kind: "account", account: account };
}

async function resolveScopedKeyAuth(
  keyHash: string,
): Promise<AuthContext | null> {
  const key = await getStorage().accountApiKeys.resolveByKeyHash(keyHash);
  if (!key) return null;
  const now = Date.now();
  if (key.stampDue && claimLastUsedWrite(keyLastUsedWrites, keyHash, now)) {
    waitUntil(getStorage().accountApiKeys.touchLastUsed(key.keyId, now));
  }

  return { kind: "role", account: key.account, role: key.principal };
}

async function resolveRunTokenAuth(token: string): Promise<AuthContext | null> {
  const subject = openRunToken(token);
  if (!subject) return null;
  const account = await getStorage().accounts.getById(subject.accountId);
  if (!account || account.status !== "active") return null;

  return { kind: "agent", account: account, agentId: subject.agentId };
}

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

async function resolveRuntimeKeyAuth(
  token: string,
  userTokenHeader: string | undefined,
): Promise<AuthContext | null> {
  const apiKeyHash = sha256Hex(token);
  const deployment =
    await getStorage().agentDeployments.getByApiKeyHash(apiKeyHash);
  if (!deployment || deployment.account.status !== "active") return null;
  let user: UserToken | undefined;
  // A forged or expired user token refuses the whole credential, key included.
  if (userTokenHeader !== undefined) {
    const secret = deployment.userTokenSecret
      ? (
          await decryptAccountBlob(
            deployment.accountId,
            "agentDeployments:userTokenSecretCiphertext",
            deployment.userTokenSecret,
          )
        ).value
      : undefined;
    const opened =
      typeof secret === "string"
        ? await openUserToken(userTokenHeader.trim(), secret)
        : null;
    if (!opened) return null;
    user = opened;
  }
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
    ...(user ? { user: user } : {}),
  };
}

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
    stageTicket: {
      projectId: ticket.projectId,
      stageId: ticket.stageId,
      sandboxWrite: ticket.sandboxWrite === true,
      expiresAt: ticket.expiresAt,
    },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

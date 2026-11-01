import type { PaginationOptions, PaginationResult } from "convex/server";
import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { cipherFromKeys } from "../../model/accountKeys";
import {
  ACCOUNT_KEY_PREFIX,
  RUNTIME_KEY_PREFIX,
  sha256Hex,
} from "../../model/accountSecrets";
import {
  authorize,
  rolePrincipal,
  type RolePrincipal,
} from "../../model/apiAuthorization";
import { collectEnvPlaceholderNames } from "../../model/agentConfigCodec";
import { stableJson } from "../../model/objects";
import type { StageScopedRef } from "../../model/projectScope";
import type { AuditActor, AuditResource } from "../../model/auditEvents";
import { RUN_TOKEN_PREFIX } from "../../model/principal";
import { ROLE_SESSION_TOKEN_PREFIX } from "../../model/roleRules";
import { VIA_GATEWAY_HEADER } from "../../model/serviceBridge";
import {
  json,
  jsonError,
  methodNotAllowed,
  rateLimitHeaders,
} from "../../model/httpJson";
import { ClientError } from "../../model/clientError";
import type { AccountCipher, WrappedAccountKey } from "../../model/envelope";

export { json, jsonError, methodNotAllowed, rateLimitHeaders };

const AUTH_FAILURE_MAX = 20;
export const AUTH_FAILURE_BUCKETS = 4096;

const MAX_PAGE_SIZE = 1000;

export type ConfigAuth =
  | { kind: "admin" }
  | { kind: "account"; account: Doc<"accounts">; viaServiceToken?: boolean }
  | { kind: "deployment" }
  | {
      kind: "role";
      account: Doc<"accounts">;
      role: RolePrincipal;
      // Set when a scoped account key, not a bsts_ session, carries the role.
      keyId?: Id<"accountApiKeys">;
    };

export async function accountCipherForAction(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  mode: "read" | "write",
): Promise<AccountCipher> {
  const keys: WrappedAccountKey[] =
    mode === "write"
      ? await ctx.runMutation(internal.account.keys.ensure, {
          accountId: accountId,
        })
      : await ctx.runQuery(internal.account.keys.list, {
          accountId: accountId,
        });

  return cipherFromKeys(accountId, keys);
}

export function auditActorForAuth(auth: ConfigAuth): AuditActor {
  if (auth.kind === "admin") return { kind: "admin" };
  if (auth.kind === "deployment") return { kind: "deployKey" };
  if (auth.kind === "role") {
    return auth.keyId
      ? { kind: "accountApiKey", id: auth.keyId }
      : { kind: "role", id: auth.role.roleId };
  }
  if (auth.viaServiceToken === true) return { kind: "service" };

  return { kind: "apiAccountSecret", id: auth.account._id };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

export async function getAccountById(
  ctx: ActionCtx,
  accountId: string,
): Promise<Doc<"accounts"> | null> {
  try {
    const account: Doc<"accounts"> | null = await ctx.runQuery(
      internal.account.accounts.getById,
      {
        accountId: accountId as Id<"accounts">,
      },
    );

    return account;
  } catch {
    return null;
  }
}

export async function collectionPage<Row, Item>(
  key: string,
  req: Request,
  source: {
    all: () => Promise<Row[]>;
    item: (row: Row) => Item | Promise<Item>;
    page: (options: PaginationOptions) => Promise<PaginationResult<Row>>;
  },
): Promise<Response> {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit")?.trim() ?? "";
  const rawCursor = url.searchParams.get("cursor")?.trim() ?? "";

  // No limit and no cursor serves the whole collection: a default page size would
  // silently drop rows for every client that never asked for a page.
  if (rawLimit === "" && rawCursor === "") {
    return json({
      [key]: await Promise.all((await source.all()).map(source.item)),
      hasMore: false,
      nextCursor: null,
    });
  }

  const limit = rawLimit === "" ? MAX_PAGE_SIZE : parsePageLimit(rawLimit);
  if (limit === null) {
    return jsonError(
      400,
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
      { code: "invalid_limit", param: "limit" },
    );
  }

  let cursor: string | null = null;
  if (rawCursor !== "") {
    cursor = decodePageCursor(key, rawCursor);
    if (cursor === null) {
      return jsonError(400, "cursor is not a valid page cursor.", {
        code: "invalid_cursor",
        param: "cursor",
      });
    }
  }

  const page = await source.page({ numItems: limit, cursor: cursor });

  return json({
    [key]: await Promise.all(page.page.map(source.item)),
    hasMore: !page.isDone,
    nextCursor: page.isDone ? null : encodePageCursor(key, page.continueCursor),
  });
}

/** For a list with no index to key a cursor on (`skills`): the cursor is an offset. */
export function paginated<T>(key: string, items: T[], req: Request): Response {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit")?.trim() ?? "";
  const rawCursor = url.searchParams.get("cursor")?.trim() ?? "";

  const limit = rawLimit === "" ? items.length : parsePageLimit(rawLimit);
  if (limit === null) {
    return jsonError(
      400,
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
      { code: "invalid_limit", param: "limit" },
    );
  }

  const offset = rawCursor === "" ? 0 : decodeOffsetCursor(key, rawCursor);
  if (offset === null) {
    return jsonError(400, "cursor is not a valid page cursor.", {
      code: "invalid_cursor",
      param: "cursor",
    });
  }

  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;

  return json({
    [key]: page,
    hasMore: hasMore,
    nextCursor: hasMore ? encodePageCursor(key, String(nextOffset)) : null,
  });
}

export async function parseJsonRequest(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ClientError(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function requireAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" | "role" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "account" && auth.viaServiceToken !== true) return auth;
  if (auth.kind === "role") return auth;

  return jsonError(401, "Unauthorized");
}

export async function requireAdminAuth(
  ctx: ActionCtx,
  req: Request,
): Promise<true | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind !== "admin") return jsonError(403, "Forbidden");

  return true;
}

export async function requireSelfAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" | "role" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "admin")
    return jsonError(400, "Admin must use account-specific endpoints");
  if (auth.kind === "deployment") return jsonError(401, "Unauthorized");
  if (auth.kind === "role") return auth;
  if (auth.viaServiceToken === true) {
    return jsonError(
      400,
      "Service token is not allowed for this account endpoint",
    );
  }

  return auth;
}

/** A run token (`brt_`) is core's credential for one run: refused on its prefix alone. */
export function runTokenRefusal(req: Request): Response | null {
  return bearerToken(req)?.startsWith(RUN_TOKEN_PREFIX)
    ? jsonError(401, "run tokens cannot reach the config plane")
    : null;
}

// Best-effort, through core: it holds the provider credentials. Ephemeral rows are removed
// by their own call; `error` rows are still tried, they may hold a machine.
export async function terminateReservedInstances(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  matches: (instance: Doc<"sandboxInstances">) => boolean,
): Promise<void> {
  const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!url || !secret) return;

  const instances: Doc<"sandboxInstances">[] = await ctx.runQuery(
    internal.sandbox.instances.listForAccount,
    {
      accountId: accountId,
    },
  );
  const baseUrl = url.replace(/\/+$/, "");
  await Promise.all(
    instances
      .filter(
        (instance) =>
          instance.sandboxConfigId !== undefined &&
          instance.status !== "terminating" &&
          instance.ephemeral !== true &&
          matches(instance),
      )
      .map(async (instance) => {
        await fetch(
          `${baseUrl}/v1/sandboxes/${encodeURIComponent(instance.sandboxConfigId as string)}/terminate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secret}`,
              "X-Account-Id": accountId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reservationKey: instance.reservationKey }),
          },
        ).catch(() => undefined);
      }),
  );
}

export async function unauthorizedResponse(
  ctx: ActionCtx,
  req: Request,
): Promise<Response> {
  const result: { blocked: boolean; retryAfterMs?: number } =
    await ctx.runMutation(internal.config.authFailures.recordAuthFailure, {
      key: await authFailureKey(req),
      now: Date.now(),
      windowMs: 5 * 60 * 1000,
      maxFailures: AUTH_FAILURE_MAX,
      blockMs: 15 * 60 * 1000,
    });
  if (!result.blocked) return jsonError(401, "Unauthorized");
  return jsonError(
    429,
    "Too many unauthorized attempts",
    { code: "too_many_auth_failures" },
    rateLimitHeaders(AUTH_FAILURE_MAX, (result.retryAfterMs ?? 0) / 1000),
  );
}

// The config write has already committed: a failed audit write is logged, never a 500
// that a client retry of the POST would turn into a duplicate resource.
export async function writeAudit(
  ctx: ActionCtx,
  event: {
    accountId: Id<"accounts">;
    projectId?: Id<"projects">;
    stageId?: Id<"stages">;
    actor: AuditActor;
    action: string;
    resource: AuditResource;
    summary: string;
    detailsJson?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.audit.ledger.record, {
      accountId: event.accountId,
      projectId: event.projectId,
      stageId: event.stageId,
      actor: event.actor,
      action: event.action,
      resource: event.resource,
      summary: event.summary,
      detailsJson: event.detailsJson,
    });
  } catch (err) {
    console.warn("config audit write failed", {
      action: event.action,
      resourceKind: event.resource.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Keyed by source, never the bearer the caller picks. Through Traefik the rightmost XFF hop
// is the client; a caller on the site port can spoof it, so sources land in a bounded set of
// buckets under an HMAC: nobody can pick addresses that share a victim's bucket.
export async function authFailureKey(req: Request): Promise<string> {
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("SERVICE_AUTH_SECRET is required to count failed logins");
  }
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip =
    forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop() ?? "unknown";
  const encoder = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    algorithm,
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    algorithm,
    key,
    encoder.encode(sourcePrefix(ip)),
  );

  return `source:${new DataView(mac).getUint32(0) % AUTH_FAILURE_BUCKETS}`;
}

// An IPv6 client usually holds a whole /64, so the /64 counts as one source.
function sourcePrefix(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const zeros = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [
    ...headGroups,
    ...Array<string>(zeros).fill("0"),
    ...tailGroups,
  ];

  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

// Constant time: no early exit on the first differing character.
function digestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return diff === 0;
}

async function resolveBearerAuth(
  ctx: ActionCtx,
  req: Request,
): Promise<ConfigAuth | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  // Every credential is prefix-routed: it resolves as its own kind or not at all.
  if (token.startsWith(ROLE_SESSION_TOKEN_PREFIX)) {
    return await resolveRoleSessionAuth(ctx, tokenHash);
  }

  const adminSecret = process.env.ADMIN_ACCOUNT_SECRET;
  if (adminSecret && digestEqual(tokenHash, await sha256Hex(adminSecret))) {
    return { kind: "admin" };
  }

  // In-cluster only: never valid on a request through the public door.
  const serviceSecret = process.env.SERVICE_AUTH_SECRET;
  if (
    serviceSecret &&
    !req.headers.has(VIA_GATEWAY_HEADER) &&
    digestEqual(tokenHash, await sha256Hex(serviceSecret))
  ) {
    const accountId =
      req.headers.get("X-Account-Id") ?? req.headers.get("x-account-id") ?? "";
    const account: Doc<"accounts"> | null = accountId
      ? await getAccountById(ctx, accountId)
      : null;

    return account && account.status === "active"
      ? { kind: "account", account: account, viaServiceToken: true }
      : null;
  }

  if (token.startsWith(RUNTIME_KEY_PREFIX)) {
    const deployment: {
      accountId: Id<"accounts">;
      endpointId: string;
      projectSlug: string;
      stageSlug: string;
    } | null = await ctx.runQuery(internal.agent.deployments.getByApiKeyHash, {
      apiKeyHash: tokenHash,
    });

    return deployment ? { kind: "deployment" } : null;
  }
  if (!token.startsWith(ACCOUNT_KEY_PREFIX)) return null;

  const account: Doc<"accounts"> | null = await ctx.runQuery(
    internal.account.accounts.getBySecretHash,
    { secretHash: tokenHash },
  );
  if (!account) return await resolveScopedKeyAuth(ctx, tokenHash);

  return account.status === "active"
    ? { kind: "account", account: account }
    : null;
}

async function resolveScopedKeyAuth(
  ctx: ActionCtx,
  keyHash: string,
): Promise<ConfigAuth | null> {
  const now = Date.now();
  const key = await ctx.runQuery(internal.account.apiKeys.resolve, {
    keyHash: keyHash,
    now: now,
  });
  if (!key) return null;
  if (key.stampDue) {
    await ctx.scheduler
      .runAfter(0, internal.account.apiKeys.touchLastUsed, {
        keyId: key.keyId,
        usedAt: now,
      })
      .catch((err: unknown) => console.warn("lastUsedAt stamp failed", err));
  }

  return {
    kind: "role",
    account: key.account,
    role: key.principal,
    keyId: key.keyId,
  };
}

async function resolveRoleSessionAuth(
  ctx: ActionCtx,
  tokenHash: string,
): Promise<ConfigAuth | null> {
  const principal: RolePrincipal | null = await ctx.runQuery(
    internal.account.roles.resolveSession,
    { tokenHash: tokenHash },
  );
  if (!principal) return null;
  const account: Doc<"accounts"> | null = await getAccountById(
    ctx,
    principal.accountId,
  );

  return account && account.status === "active"
    ? { kind: "role", account: account, role: principal }
    : null;
}

// A cursor names its collection, so one from `agents` cannot walk `roles`. It can hold any
// code point (an index key the account chose) and `btoa` takes Latin-1: hence the %-encoding.
function decodePageCursor(key: string, cursor: string): string | null {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [cursorKey, value] = decoded;

    return cursorKey === key && typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function decodeOffsetCursor(key: string, cursor: string): number | null {
  const decoded = decodePageCursor(key, cursor);
  const offset = decoded === null ? Number.NaN : Number(decoded);

  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

function encodePageCursor(key: string, cursor: string): string {
  return btoa(encodeURIComponent(JSON.stringify([key, cursor])));
}

function parsePageLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);

  return limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
}

// `${NAME}` resolves into the stored config, so a role may only name env vars it can read.
// An untouched top-level section keeps the names someone who could read them put there.
export function assertRoleMayReadEnv(
  role: RolePrincipal | undefined,
  before: object | undefined,
  after: object,
): void {
  if (!role) return;
  const principal = rolePrincipal(role);
  const previous = new Map<string, unknown>(Object.entries(before ?? {}));
  const refused = new Set<string>();
  for (const [key, section] of Object.entries(after)) {
    if (before && stableJson(previous.get(key)) === stableJson(section))
      continue;
    for (const name of collectEnvPlaceholderNames(section)) {
      if (!authorize(principal, "env:read", { type: "env", id: name }).allow)
        refused.add(name);
    }
  }
  if (refused.size > 0) {
    throw new ClientError(
      `Role may not read the env vars it names: ${[...refused].sort().join(", ")}`,
    );
  }
}

export async function assertRefsInPin(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  role: RolePrincipal | undefined,
  refs: StageScopedRef[],
): Promise<void> {
  if (!role?.projectId || !role.stageId || refs.length === 0) return;
  const outside = await ctx.runQuery(internal.account.roles.refsOutsidePin, {
    accountId: accountId,
    pin: { projectId: role.projectId, stageId: role.stageId },
    refs: refs,
  });
  if (outside.length > 0) {
    throw new ClientError(
      `Role is pinned to one stage; these are outside it: ${outside
        .map((ref) => `${ref.type} ${ref.id}`)
        .join(", ")}`,
    );
  }
}

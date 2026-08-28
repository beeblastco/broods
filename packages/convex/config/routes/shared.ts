/**
 * Shared plumbing for the config-plane HTTP routes: Bearer auth resolution,
 * JSON request/response helpers, audit writes, and the reserved-sandbox
 * teardown used by workspace and sandbox deletes.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../model/accountSecrets";
import type {
  ConfigAuditActor,
  ConfigAuditResource,
} from "../../model/auditEvents";
import type { ApiPrincipal } from "../../model/apiAuthorization";
import type { PolicyDocument } from "../../model/policyRules";
import { ROLE_SESSION_TOKEN_PREFIX } from "../../model/roleRules";

/** The role identity an fp_sts_ session acts as. */
export type RolePrincipalContext = {
  accountId: Id<"accounts">;
  roleId: string;
  name: string;
  policy: PolicyDocument;
  projectId?: Id<"projects">;
  stageId?: Id<"stages">;
  expiresAt: number;
};

export type ConfigAuth =
  | { kind: "admin" }
  | { kind: "account"; account: Doc<"accounts">; viaServiceToken?: boolean }
  | { kind: "deployment" }
  | { kind: "role"; account: Doc<"accounts">; role: RolePrincipalContext };

/**
 * Convert resolved HTTP auth into audit actor metadata.
 * @param auth resolved config HTTP auth
 * @returns actor metadata for audit rows
 */
export function auditActorForAuth(auth: ConfigAuth): ConfigAuditActor {
  if (auth.kind === "admin") return { kind: "admin" };
  if (auth.kind === "deployment") return { kind: "deployKey" };
  if (auth.kind === "role") return { kind: "role", id: auth.role.roleId };
  if (auth.viaServiceToken === true) return { kind: "service" };

  return { kind: "apiAccountSecret", id: auth.account._id };
}

/** Read the account-config encryption secret, failing loudly when unset. */
export function configEncryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required");

  return secret;
}

/**
 * Fetch an account id while treating malformed ids as not found.
 * @param ctx Convex action context
 * @param accountId account id string from the route
 * @returns account document or null
 */
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

/** Serialize a JSON response body with the given status. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 405 response naming the allowed methods, matching core's payload. */
export function methodNotAllowed(allowedMethods: string[]): Response {
  return json(
    { error: "Method not allowed", allowedMethods: allowedMethods },
    405,
  );
}

/**
 * Read and parse a JSON request body with core's empty-body and syntax strings.
 * @param req incoming HTTP request
 * @returns parsed JSON value or empty object
 */
export async function parseJsonRequest(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Extract a Bearer token from a request. Exported for the assume-role route,
 * which resolves its own caller kinds (account secret, CLI token, runtime key).
 * @param req incoming HTTP request
 * @returns token string, or null when absent/malformed
 */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

/**
 * Project role auth into the `authorize()` principal shape.
 * @param auth resolved role auth
 * @returns OPA-style principal document
 */
export function rolePrincipal(
  auth: Extract<ConfigAuth, { kind: "role" }>,
): ApiPrincipal {
  return {
    kind: "role",
    accountId: auth.role.accountId,
    roleId: auth.role.roleId,
    policy: auth.role.policy,
    ...(auth.role.projectId ? { projectId: auth.role.projectId } : {}),
    ...(auth.role.stageId ? { stageId: auth.role.stageId } : {}),
  };
}

/**
 * Resolve the Bearer token to an account or a role session.
 * @param ctx the action context
 * @param req the incoming request
 * @returns account or role auth, or an error response
 */
export async function requireAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" | "role" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "account" && auth.viaServiceToken !== true) return auth;
  if (auth.kind === "role") return auth;

  return json({ error: "Unauthorized" }, 401);
}

/**
 * Require the admin bearer secret for `/accounts*` routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns true or an error response
 */
export async function requireAdminAuth(
  ctx: ActionCtx,
  req: Request,
): Promise<true | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind !== "admin") return json({ error: "Forbidden" }, 403);

  return true;
}

/**
 * Require account-secret or role-session auth for `/v1/account*` routes with
 * core parity. Callers decide what a role session may do on the route.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns active account or role auth, or an error response
 */
export async function requireSelfAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" | "role" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "admin")
    return json({ error: "Admin must use account-specific endpoints" }, 400);
  if (auth.kind === "deployment") return json({ error: "Unauthorized" }, 401);
  if (auth.kind === "role") return auth;
  if (auth.viaServiceToken === true) {
    return json(
      { error: "Service token is not allowed for this account endpoint" },
      400,
    );
  }

  return auth;
}

/**
 * Terminate reserved sandbox instances matching a predicate through core's
 * lifecycle route (which owns the decrypted provider credentials). Best-effort:
 * skips rows without a sandboxConfigId and swallows per-instance failures.
 */
export async function terminateReservedInstances(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  matches: (instance: Doc<"sandboxInstances">) => boolean,
): Promise<void> {
  const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
  const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
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
          instance.status !== "error" &&
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

/**
 * Write one audit event through the internal mutation exposed for HTTP actions.
 * The config write has already committed by the time this runs, so audit
 * failures are logged and swallowed — they must not turn a committed change
 * into a 500 (a client retry of a POST would then duplicate the resource).
 * @param ctx Convex action context
 * @param event sanitized event metadata
 */
export async function writeAudit(
  ctx: ActionCtx,
  event: {
    accountId: Id<"accounts">;
    projectId?: Id<"projects">;
    stageId?: Id<"stages">;
    actor: ConfigAuditActor;
    action: string;
    resource: ConfigAuditResource;
    summary: string;
    detailsJson?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.config.auditEvents.record, {
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

/**
 * Build the failed-auth limiter key from rightmost XFF and token hash prefix.
 * @param req incoming HTTP request
 * @returns limiter key
 */
async function authFailureKey(req: Request): Promise<string> {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip =
    forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop() ?? "unknown";
  const token = bearerToken(req);
  const tokenHashPrefix = token
    ? (await sha256Hex(token)).slice(0, 8)
    : "missing";

  return `${ip}:${tokenHashPrefix}`;
}

/**
 * Compare two already-hashed secrets without comparing plaintext values.
 * @param left first hex digest
 * @param right second hex digest
 * @returns true when digests are equal
 */
function digestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return diff === 0;
}

/**
 * Resolve Bearer auth into admin, account, service-account, deployment, or
 * role-session auth.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns auth context or null for missing/unknown/disabled credentials
 */
async function resolveBearerAuth(
  ctx: ActionCtx,
  req: Request,
): Promise<ConfigAuth | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  // fp_sts_ is prefix-routed: a role session resolves as a role or not at all.
  if (token.startsWith(ROLE_SESSION_TOKEN_PREFIX)) {
    const principal: RolePrincipalContext | null = await ctx.runQuery(
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

  const adminSecret = process.env.ADMIN_ACCOUNT_SECRET;
  if (adminSecret && digestEqual(tokenHash, await sha256Hex(adminSecret))) {
    return { kind: "admin" };
  }

  const serviceSecret =
    process.env.BROODS_SERVICE_AUTH_SECRET ?? process.env.SERVICE_AUTH_SECRET;
  if (serviceSecret && digestEqual(tokenHash, await sha256Hex(serviceSecret))) {
    const accountId =
      req.headers.get("X-Account-Id") ?? req.headers.get("x-account-id") ?? "";
    const account: Doc<"accounts"> | null = accountId
      ? await getAccountById(ctx, accountId)
      : null;

    return account && account.status === "active"
      ? { kind: "account", account: account, viaServiceToken: true }
      : null;
  }

  const deployment: {
    accountId: Id<"accounts">;
    endpointId: string;
    projectSlug: string;
    stageSlug: string;
  } | null = await ctx.runQuery(internal.agent.deployments.getByApiKeyHash, {
    apiKeyHash: tokenHash,
  });
  if (deployment) return { kind: "deployment" };

  const account: Doc<"accounts"> | null = await ctx.runQuery(
    internal.account.accounts.getBySecretHash,
    { secretHash: tokenHash },
  );

  return account && account.status === "active"
    ? { kind: "account", account: account }
    : null;
}

/**
 * Apply failed-auth rate limiting before returning a 401 for unknown credentials.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns 401 or 429 response
 */
export async function unauthorizedResponse(
  ctx: ActionCtx,
  req: Request,
): Promise<Response> {
  const result: { blocked: boolean; retryAfterMs?: number } =
    await ctx.runMutation(internal.config.auditEvents.recordAuthFailure, {
      key: await authFailureKey(req),
      now: Date.now(),
      windowMs: 5 * 60 * 1000,
      maxFailures: 20,
      blockMs: 15 * 60 * 1000,
    });
  if (!result.blocked) return json({ error: "Unauthorized" }, 401);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.retryAfterMs ?? 0) / 1000),
  );

  return new Response(
    JSON.stringify({ error: "Too many unauthorized attempts" }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

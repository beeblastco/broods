/**
 * Public config-plane HTTP surface (epic #85 phase 9): agents, skills, tools,
 * hooks, workspace files, crons, workspaces, sandboxes, and policies served straight
 * from Convex. The gateway forwards these paths here; response shapes match
 * the retired core handlers so the public API contract is unchanged. Auth is
 * the account Bearer secret.
 */

import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createAccountSecret, hashAccountSecret } from "./model/accountSecrets";
import { normalizeAccountHookUpload } from "./model/accountHooks";
import { normalizeAccountToolUpload } from "./model/accountTools";
import {
  ACCOUNT_ENV_VAR_NAME_PATTERN,
  collectEnvPlaceholderNames,
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  substituteAccountEnvPlaceholders,
} from "./model/agentConfigCodec";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
  toPublicAgentResponse,
  type AgentConfig,
} from "./model/agentRules";
import {
  parseCronRunsLimit,
  toCronResponse,
  toCronRunResponse,
} from "./model/cronRules";
import {
  normalizeCreateAgentPolicyInput,
  normalizeUpdateAgentPolicyInput,
  toPublicAgentPolicyResponse,
} from "./model/policyRules";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  toPublicSandboxConfigResponse,
  type SandboxConfig,
} from "./model/sandboxRules";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  toPublicWorkspaceConfigResponse,
  workspaceNamespace,
} from "./model/workspaceRules";
import {
  auditDetailsJson,
  type ConfigAuditActor,
  type ConfigAuditResource,
} from "./model/auditEvents";
import { isPlainObject } from "./model/objects";
import { fetchSlackChannelDirectory } from "./model/slackDirectory";

export const handle = httpAction(async (ctx, req) => {
  try {
    const accountRoute = parseAccountRoute(new URL(req.url).pathname);
    if (accountRoute) return await handleAccountRoute(ctx, req, accountRoute);

    const accountAuth = await requireAccount(ctx, req);
    if (accountAuth instanceof Response) return accountAuth;
    const account = accountAuth.account;
    const actor = auditActorForAuth(accountAuth);
    const route = parseRoute(new URL(req.url).pathname);
    if (!route) return json({ error: "Not found" }, 404);

    switch (route.kind) {
      case "skills":
        return await handleSkillRoute(ctx, req, account._id, actor, route.name);
      case "tools":
        return await handleToolRoute(
          ctx,
          req,
          account._id,
          actor,
          route.toolId,
        );
      case "hooks":
        return await handleHookRoute(
          ctx,
          req,
          account._id,
          actor,
          route.hookId,
        );
      case "workspaceFiles":
        return await handleWorkspaceFilesRoute(
          ctx,
          req,
          account._id,
          actor,
          route.workspaceId,
        );
      case "crons":
        return await handleCronRoute(
          ctx,
          req,
          account._id,
          actor,
          route.cronId,
          route.runs,
        );
      case "workspaces":
        return await handleWorkspaceConfigRoute(
          ctx,
          req,
          account._id,
          actor,
          route.workspaceId,
        );
      case "sandboxes":
        return await handleSandboxConfigRoute(
          ctx,
          req,
          account._id,
          actor,
          route.sandboxId,
        );
      case "policies":
        return await handlePolicyConfigRoute(
          ctx,
          req,
          account._id,
          actor,
          route.policyId,
        );
      case "agents":
        return await handleAgentConfigRoute(
          ctx,
          req,
          account._id,
          actor,
          route.agentId,
        );
      case "agentChannelDirectory":
        return await handleAgentChannelDirectoryRoute(
          ctx,
          req,
          account._id,
          route.agentId,
          route.channelType,
        );
      case "env":
        return await handleAccountEnvVarRoute(
          ctx,
          req,
          account._id,
          actor,
          route.name,
        );
    }
  } catch (err) {
    if (isClientInputError(err)) {
      return json({ error: err.message }, clientErrorStatus(err));
    }
    console.error("config HTTP request failed", err);

    return json({ error: "Internal server error" }, 500);
  }
});

/**
 * Map a client-input error to its HTTP status. Core returned 401 for
 * foreign-account skill paths and 404 for dangling agent references
 * (errorResponseForError); everything else is a plain 400.
 * @param error the recognized client-input error
 * @returns the HTTP status core used for this message
 */
function clientErrorStatus(error: Error): number {
  if (error.message.startsWith("Skill path belongs to another account:"))
    return 401;
  if (error.message.startsWith("Agent name already exists:")) return 409;
  if (
    error.message.startsWith("Skill not found:") ||
    error.message.startsWith("Subagent not found:") ||
    error.message.startsWith("Agent policy not found:")
  ) {
    return 404;
  }

  return 400;
}

type AccountHttpRoute =
  | { kind: "self" }
  | { kind: "selfRotate" }
  | { kind: "adminList" }
  | { kind: "adminRecord"; accountId: string }
  | { kind: "adminRotate"; accountId: string }
  | { kind: "adminUnknown" };

type ConfigAuth =
  | { kind: "admin" }
  | { kind: "account"; account: Doc<"accounts">; viaServiceToken?: boolean }
  | { kind: "deployment" };

type AccountUpdateInput = {
  username?: string;
  description?: string | null;
};

/**
 * Parse account config-plane pathnames, including unknown admin subpaths.
 * @param pathname request pathname
 * @returns parsed account route, or null when not account HTTP
 */
function parseAccountRoute(pathname: string): AccountHttpRoute | null {
  if (pathname === "/v1/account") return { kind: "self" };
  if (pathname === "/v1/account/rotate-secret") return { kind: "selfRotate" };
  if (pathname === "/accounts") return { kind: "adminList" };
  if (!pathname.startsWith("/accounts/")) return null;

  const record = pathname.match(/^\/accounts\/([^/]+)$/);
  if (record?.[1])
    return { kind: "adminRecord", accountId: decodeURIComponent(record[1]) };

  const rotate = pathname.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
  if (rotate?.[1])
    return { kind: "adminRotate", accountId: decodeURIComponent(rotate[1]) };

  return { kind: "adminUnknown" };
}

/**
 * Handle account self-management and admin account config routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @param route parsed account route
 * @returns HTTP response matching core account-management payloads
 */
async function handleAccountRoute(
  ctx: ActionCtx,
  req: Request,
  route: AccountHttpRoute,
): Promise<Response> {
  if (route.kind === "self" || route.kind === "selfRotate") {
    const accountAuth = await requireSelfAccount(ctx, req);
    if (accountAuth instanceof Response) return accountAuth;
    const account = accountAuth.account;
    const actor = auditActorForAuth(accountAuth);

    if (route.kind === "self") {
      if (req.method === "GET")
        return json({ account: toPublicAccount(account) });
      if (req.method === "PATCH")
        return await updateAccountResponse(
          ctx,
          account._id,
          actor,
          await parseJsonRequest(req),
        );

      return methodNotAllowed(["GET", "PATCH"]);
    }

    if (req.method === "POST")
      return await rotateAccountSecretResponse(ctx, account._id, actor);

    return methodNotAllowed(["POST"]);
  }

  const admin = await requireAdminAuth(ctx, req);
  if (admin instanceof Response) return admin;

  if (route.kind === "adminUnknown") return json({ error: "Not found" }, 404);

  if (route.kind === "adminList") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const accounts: Doc<"accounts">[] = await ctx.runQuery(
      internal.accounts.list,
      {},
    );

    return json({
      accounts: accounts.map((account) => toPublicAccount(account)),
    });
  }

  if (route.kind === "adminRecord") {
    if (req.method === "GET") {
      const account: Doc<"accounts"> | null = await getAccountById(
        ctx,
        route.accountId,
      );

      return account
        ? json({ account: toPublicAccount(account) })
        : json({ error: "Account not found" }, 404);
    }
    if (req.method === "PATCH")
      return await updateAccountResponse(
        ctx,
        route.accountId,
        { kind: "admin" },
        await parseJsonRequest(req),
      );

    return methodNotAllowed(["GET", "PATCH"]);
  }

  if (req.method === "POST")
    return await rotateAccountSecretResponse(ctx, route.accountId, {
      kind: "admin",
    });

  return methodNotAllowed(["POST"]);
}

/**
 * Require account-secret auth for `/v1/account*` routes with core parity.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns active account or an error response
 */
async function requireSelfAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "admin")
    return json({ error: "Admin must use account-specific endpoints" }, 400);
  if (auth.kind === "deployment") return json({ error: "Unauthorized" }, 401);
  if (auth.viaServiceToken === true) {
    return json(
      { error: "Service token is not allowed for this account endpoint" },
      400,
    );
  }

  return auth;
}

/**
 * Require the admin bearer secret for `/accounts*` routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns true or an error response
 */
async function requireAdminAuth(
  ctx: ActionCtx,
  req: Request,
): Promise<true | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind !== "admin") return json({ error: "Forbidden" }, 403);

  return true;
}

/**
 * Resolve Bearer auth into admin, account, service-account, or deployment auth.
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
  const tokenHash = await hashAccountSecret(token);

  const adminSecret = process.env.ADMIN_ACCOUNT_SECRET;
  if (
    adminSecret &&
    digestEqual(tokenHash, await hashAccountSecret(adminSecret))
  ) {
    return { kind: "admin" };
  }

  const serviceSecret =
    process.env.BROODS_SERVICE_AUTH_SECRET ?? process.env.SERVICE_AUTH_SECRET;
  if (
    serviceSecret &&
    digestEqual(tokenHash, await hashAccountSecret(serviceSecret))
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

  const deployment: {
    accountId: Id<"accounts">;
    endpointId: string;
    projectSlug: string;
    environmentSlug: string;
  } | null = await ctx.runQuery(internal.agentDeployments.getByApiKeyHash, {
    apiKeyHash: tokenHash,
  });
  if (deployment) return { kind: "deployment" };

  const account: Doc<"accounts"> | null = await ctx.runQuery(
    internal.accounts.getBySecretHash,
    { secretHash: tokenHash },
  );
  return account && account.status === "active"
    ? { kind: "account", account: account }
    : null;
}

/**
 * Extract a Bearer token from a request.
 * @param req incoming HTTP request
 * @returns token string, or null when absent/malformed
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
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
 * Apply failed-auth rate limiting before returning a 401 for unknown credentials.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns 401 or 429 response
 */
async function unauthorizedResponse(
  ctx: ActionCtx,
  req: Request,
): Promise<Response> {
  const result: { blocked: boolean; retryAfterMs?: number } =
    await ctx.runMutation(internal.configHttpAuthFailures.recordFailure, {
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
    ? (await hashAccountSecret(token)).slice(0, 8)
    : "missing";

  return `${ip}:${tokenHashPrefix}`;
}

/**
 * Convert resolved HTTP auth into audit actor metadata.
 * @param auth resolved config HTTP auth
 * @returns actor metadata for audit rows
 */
function auditActorForAuth(auth: ConfigAuth): ConfigAuditActor {
  if (auth.kind === "admin") return { kind: "admin" };
  if (auth.kind === "deployment") return { kind: "deployKey" };
  if (auth.viaServiceToken === true) return { kind: "service" };

  return { kind: "apiAccountSecret", id: auth.account._id };
}

/**
 * Write one audit event through the internal mutation exposed for HTTP actions.
 * The config write has already committed by the time this runs, so audit
 * failures are logged and swallowed — they must not turn a committed change
 * into a 500 (a client retry of a POST would then duplicate the resource).
 * @param ctx Convex action context
 * @param event sanitized event metadata
 */
async function writeAudit(
  ctx: ActionCtx,
  event: {
    accountId: Id<"accounts">;
    projectId?: Id<"projects">;
    environmentId?: Id<"environments">;
    actor: ConfigAuditActor;
    action: string;
    resource: ConfigAuditResource;
    summary: string;
    detailsJson?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.configAuditEvents.record, {
      accountId: event.accountId,
      projectId: event.projectId,
      environmentId: event.environmentId,
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
 * Fetch an account id while treating malformed ids as not found.
 * @param ctx Convex action context
 * @param accountId account id string from the route
 * @returns account document or null
 */
async function getAccountById(
  ctx: ActionCtx,
  accountId: string,
): Promise<Doc<"accounts"> | null> {
  try {
    const account: Doc<"accounts"> | null = await ctx.runQuery(
      internal.accounts.getById,
      {
        accountId: accountId as Id<"accounts">,
      },
    );

    return account;
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON request body with core's empty-body and syntax strings.
 * @param req incoming HTTP request
 * @returns parsed JSON value or empty object
 */
async function parseJsonRequest(req: Request): Promise<unknown> {
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
 * Normalize account metadata patches with core's error strings.
 * @param value raw JSON body
 * @returns normalized account update input
 */
function normalizeAccountUpdateInput(value: unknown): AccountUpdateInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  if ("config" in value)
    throw new Error(
      "Agent config must be updated through /v1/agents/{agentId}",
    );
  const normalized: AccountUpdateInput = {
    ...(value.username !== undefined
      ? { username: requireString(value.username, "username") }
      : {}),
    ...(value.description !== undefined
      ? {
          description:
            value.description === null
              ? null
              : optionalString(value.description, "description"),
        }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("Request body must include username or description");
  }

  return normalized;
}

/**
 * Require a trimmed non-empty string.
 * @param value raw value
 * @param name field name for error messages
 * @returns trimmed string
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

/**
 * Normalize an optional string field, omitting empty strings.
 * @param value raw value
 * @param name field name for error messages
 * @returns trimmed string or undefined
 */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Update an account and return the public response wrapper.
 * @param ctx Convex action context
 * @param accountId account id to update
 * @param input raw update body
 * @returns update response
 */
async function updateAccountResponse(
  ctx: ActionCtx,
  accountId: string,
  actor: ConfigAuditActor,
  input: unknown,
): Promise<Response> {
  const existing = await getAccountById(ctx, accountId);
  if (!existing) return json({ error: "Account not found" }, 404);
  const patch = normalizeAccountUpdateInput(input);
  await ctx.runMutation(internal.accounts.update, {
    accountId: existing._id,
    ...(patch.username !== undefined ? { username: patch.username } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
  });
  const updated: Doc<"accounts"> | null = await ctx.runQuery(
    internal.accounts.getById,
    { accountId: existing._id },
  );
  if (updated) {
    await writeAudit(ctx, {
      accountId: existing._id,
      actor: actor,
      action: "updated",
      resource: { kind: "account", id: existing._id, name: updated.username },
      summary: "Account metadata updated",
      detailsJson: auditDetailsJson({
        changedFields: Object.keys(patch).sort(),
      }),
    });
  }

  return updated
    ? json({ account: toPublicAccount(updated) })
    : json({ error: "Account not found" }, 404);
}

/**
 * Rotate an account secret hash and return the one-time plaintext secret.
 * @param ctx Convex action context
 * @param accountId account id to rotate
 * @returns rotate-secret response
 */
async function rotateAccountSecretResponse(
  ctx: ActionCtx,
  accountId: string,
  actor: ConfigAuditActor,
): Promise<Response> {
  const existing = await getAccountById(ctx, accountId);
  if (!existing) return json({ error: "Account not found" }, 404);
  const secret = createAccountSecret();
  await ctx.runMutation(internal.accounts.update, {
    accountId: existing._id,
    secretHash: await hashAccountSecret(secret),
  });
  const updated: Doc<"accounts"> | null = await ctx.runQuery(
    internal.accounts.getById,
    { accountId: existing._id },
  );
  if (updated) {
    await writeAudit(ctx, {
      accountId: existing._id,
      actor: actor,
      action: "secret-rotated",
      resource: { kind: "account", id: existing._id, name: updated.username },
      summary: "Account secret rotated",
    });
  }

  return updated
    ? json({ account: toPublicAccount(updated), secret: secret })
    : json({ error: "Account not found" }, 404);
}

/**
 * Project an account document to the public account response shape.
 * @param account account document
 * @returns public account record
 */
function toPublicAccount(account: Doc<"accounts">): Record<string, unknown> {
  return {
    accountId: account._id,
    username: account.username,
    ...(account.description ? { description: account.description } : {}),
    status: account.status,
    createdAt: new Date(account.createdAt).toISOString(),
    updatedAt: new Date(account.updatedAt).toISOString(),
  };
}

type ConfigRoute =
  | { kind: "skills"; name?: string }
  | { kind: "tools"; toolId?: string }
  | { kind: "hooks"; hookId?: string }
  | { kind: "workspaceFiles"; workspaceId: string }
  | { kind: "crons"; cronId?: string; runs: boolean }
  | { kind: "workspaces"; workspaceId?: string }
  | { kind: "sandboxes"; sandboxId?: string }
  | { kind: "policies"; policyId?: string }
  | { kind: "agents"; agentId?: string }
  | { kind: "agentChannelDirectory"; agentId: string; channelType: string }
  | { kind: "env"; name?: string };

/**
 * Parse a config-plane pathname into its route parts.
 * @param pathname the request pathname
 * @returns the parsed route, or null when the path is not a config route
 */
function parseRoute(pathname: string): ConfigRoute | null {
  const env = pathname.match(/^\/v1\/env(?:\/([^/]+))?$/);
  if (env)
    return {
      kind: "env",
      ...(env[1] ? { name: decodeURIComponent(env[1]) } : {}),
    };

  const skills = pathname.match(/^\/v1\/skills(?:\/([^/]+))?$/);
  if (skills)
    return {
      kind: "skills",
      ...(skills[1] ? { name: decodeURIComponent(skills[1]) } : {}),
    };

  const tools = pathname.match(/^\/v1\/tools(?:\/([^/]+))?$/);
  if (tools)
    return {
      kind: "tools",
      ...(tools[1] ? { toolId: decodeURIComponent(tools[1]) } : {}),
    };

  const hooks = pathname.match(/^\/v1\/hooks(?:\/([^/]+))?$/);
  if (hooks)
    return {
      kind: "hooks",
      ...(hooks[1] ? { hookId: decodeURIComponent(hooks[1]) } : {}),
    };

  const files = pathname.match(/^\/v1\/workspaces\/([^/]+)\/files$/);
  if (files?.[1])
    return {
      kind: "workspaceFiles",
      workspaceId: decodeURIComponent(files[1]),
    };

  const workspaces = pathname.match(/^\/v1\/workspaces(?:\/([^/]+))?$/);
  if (workspaces)
    return {
      kind: "workspaces",
      ...(workspaces[1]
        ? { workspaceId: decodeURIComponent(workspaces[1]) }
        : {}),
    };

  const sandboxes = pathname.match(/^\/v1\/sandboxes(?:\/([^/]+))?$/);
  if (sandboxes)
    return {
      kind: "sandboxes",
      ...(sandboxes[1] ? { sandboxId: decodeURIComponent(sandboxes[1]) } : {}),
    };

  const policies = pathname.match(/^\/v1\/policies(?:\/([^/]+))?$/);
  if (policies)
    return {
      kind: "policies",
      ...(policies[1] ? { policyId: decodeURIComponent(policies[1]) } : {}),
    };

  const channelDirectory = pathname.match(
    /^\/v1\/agents\/([^/]+)\/channels\/([^/]+)\/directory$/,
  );
  if (channelDirectory?.[1] && channelDirectory[2]) {
    return {
      kind: "agentChannelDirectory",
      agentId: decodeURIComponent(channelDirectory[1]),
      channelType: decodeURIComponent(channelDirectory[2]),
    };
  }

  const agents = pathname.match(/^\/v1\/agents(?:\/([^/]+))?$/);
  if (agents)
    return {
      kind: "agents",
      ...(agents[1] ? { agentId: decodeURIComponent(agents[1]) } : {}),
    };

  const cronRuns = pathname.match(/^\/v1\/crons\/([^/]+)\/runs$/);
  if (cronRuns?.[1])
    return {
      kind: "crons",
      cronId: decodeURIComponent(cronRuns[1]),
      runs: true,
    };

  const crons = pathname.match(/^\/v1\/crons(?:\/([^/]+))?$/);
  if (crons)
    return {
      kind: "crons",
      ...(crons[1] ? { cronId: decodeURIComponent(crons[1]) } : {}),
      runs: false,
    };

  return null;
}

/**
 * Resolve the Bearer token to an account.
 * @param ctx the action context
 * @param req the incoming request
 * @returns the account document, or null when the token is missing or unknown
 */
async function requireAccount(
  ctx: ActionCtx,
  req: Request,
): Promise<Extract<ConfigAuth, { kind: "account" }> | Response> {
  const auth = await resolveBearerAuth(ctx, req);
  if (!auth) return await unauthorizedResponse(ctx, req);
  if (auth.kind === "account" && auth.viaServiceToken !== true) return auth;

  return json({ error: "Unauthorized" }, 401);
}

/**
 * Agent CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleAgentRoute contract.
 */
async function handleAgentConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  agentId?: string,
): Promise<Response> {
  if (!agentId) {
    if (req.method === "GET") {
      const records: Doc<"agents">[] = await ctx.runQuery(
        internal.agents.list,
        { accountId: accountId },
      );
      const agents = await Promise.all(
        records.map(async (record) =>
          toPublicAgentResponse(
            record,
            await decryptAgentConfigForPublicRead(record),
          ),
        ),
      );

      return json({ agents: agents });
    }
    if (req.method === "POST") {
      const input = normalizeCreateAgentInput(await req.json());
      // Names identify agents to config-plane clients (lookup-before-create
      // upserts), so a duplicate must 409 instead of silently forking.
      const duplicate: Doc<"agents"> | null = await ctx.runQuery(
        internal.agents.getByName,
        {
          accountId: accountId,
          name: input.name,
        },
      );
      if (duplicate) {
        return json(
          {
            error: `Agent name already exists: ${input.name}`,
            agentId: duplicate._id,
          },
          409,
        );
      }
      // Before encryption: canonicalization must land in the persisted config.
      canonicalizeAgentSkillPaths(accountId, input.config);
      const config = await prepareAccountAgentConfig(
        ctx,
        accountId,
        input.config,
      );
      await validateAgentReferences(ctx, accountId, input.config);
      const createdId: Id<"agents"> = await ctx.runMutation(
        internal.agents.create,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          encryptedConfig: config.encrypted.ciphertext,
          encryptionIv: config.encrypted.iv,
          encryptionTag: config.encrypted.tag,
          ...(config.source
            ? {
                encryptedSourceConfig: config.source.ciphertext,
                sourceEncryptionIv: config.source.iv,
                sourceEncryptionTag: config.source.tag,
              }
            : {}),
        },
      );
      const created: Doc<"agents"> | null = await ctx.runQuery(
        internal.agents.getById,
        {
          accountId: accountId,
          agentId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created agent");
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: { kind: "agent", id: created._id, name: created.name },
        summary: "Agent created",
        detailsJson: auditDetailsJson({ agentId: created._id }),
      });

      return json(
        {
          accountId: created.accountId,
          agentId: created._id,
          name: created.name,
          ...(created.description ? { description: created.description } : {}),
        },
        201,
      );
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"agents"> | null = await ctx.runQuery(
      internal.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );

    return record
      ? json(
          toPublicAgentResponse(
            record,
            await decryptAgentConfigForPublicRead(record),
          ),
        )
      : json({ error: "Agent not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"agents"> | null = await ctx.runQuery(
      internal.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!existing) return json({ error: "Agent not found" }, 404);
    const existingConfig = await decryptAgentConfigForPublicRead(existing);
    const patch = normalizeUpdateAgentInput(existingConfig, await req.json());
    if (patch.name !== undefined && patch.name !== existing.name) {
      const collision: Doc<"agents"> | null = await ctx.runQuery(
        internal.agents.getByName,
        {
          accountId: accountId,
          name: patch.name,
        },
      );
      if (collision) {
        return json(
          {
            error: `Agent name already exists: ${patch.name}`,
            agentId: collision._id,
          },
          409,
        );
      }
    }
    // Before encryption: canonicalization must land in the persisted config.
    canonicalizeAgentSkillPaths(accountId, patch.config);
    const config = await prepareAccountAgentConfig(
      ctx,
      accountId,
      patch.config,
    );
    await validateAgentReferences(ctx, accountId, patch.config);
    await ctx.runMutation(internal.agents.update, {
      accountId: accountId,
      agentId: agentId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      // Null is dropped, not forwarded: core's adapter has always done
      // `?? undefined` here, so PATCH {description: null} is a no-op
      // for agents (unlike policies, where null clears).
      ...(patch.description !== undefined
        ? { description: patch.description ?? undefined }
        : {}),
      encryptedConfig: config.encrypted.ciphertext,
      encryptionIv: config.encrypted.iv,
      encryptionTag: config.encrypted.tag,
      ...(config.source
        ? {
            encryptedSourceConfig: config.source.ciphertext,
            sourceEncryptionIv: config.source.iv,
            sourceEncryptionTag: config.source.tag,
          }
        : { clearSourceConfig: true }),
    });
    const updated: Doc<"agents"> | null = await ctx.runQuery(
      internal.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "updated",
        resource: { kind: "agent", id: updated._id, name: updated.name },
        summary: "Agent updated",
        detailsJson: auditDetailsJson({ agentId: updated._id }),
      });
    }

    return updated
      ? json(
          toPublicAgentResponse(
            updated,
            await decryptAgentConfigForPublicRead(updated),
          ),
        )
      : json({ error: "Agent not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"agents"> | null = await ctx.runQuery(
      internal.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!existing) return json({ error: "Agent not found" }, 404);
    await ctx.runMutation(internal.agents.remove, {
      accountId: accountId,
      agentId: agentId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "agent", id: existing._id, name: existing.name },
      summary: "Agent deleted",
      detailsJson: auditDetailsJson({ agentId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Lists the live channel directory (id, name, privacy, bot membership) for an
 * agent's configured messaging channel — Slack only for now. The decrypted
 * stored credential is used server-side and never included in the response, so
 * dashboards can offer a pick-a-channel UX without re-collecting tokens.
 */
async function handleAgentChannelDirectoryRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  agentId: string,
  channelType: string,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const record: Doc<"agents"> | null = await ctx.runQuery(
    internal.agents.getById,
    {
      accountId: accountId,
      agentId: agentId,
    },
  );
  if (!record) return json({ error: "Agent not found" }, 404);
  if (channelType !== "slack") {
    return json(
      {
        error: `Channel directory is not supported for ${channelType}`,
        reason: "unsupported_channel_type",
      },
      400,
    );
  }
  // The resolved config (env placeholders substituted), not the public-read
  // source config — this is the same view the runtime uses to post messages.
  const config = await decryptAgentConfig(record);
  const channels = isPlainObject(config.channels) ? config.channels : undefined;
  const slack =
    channels && isPlainObject(channels.slack) ? channels.slack : undefined;
  const botToken =
    typeof slack?.botToken === "string" ? slack.botToken.trim() : "";
  if (!botToken) {
    return json(
      {
        error: "config.channels.slack.botToken is not configured",
        reason: "not_configured",
      },
      409,
    );
  }

  const directory = await fetchSlackChannelDirectory(botToken);
  if (!directory.ok) {
    return json(
      { error: directory.error, reason: directory.reason },
      directory.status,
    );
  }

  return json({ channels: directory.channels, truncated: directory.truncated });
}

/** Account-level environment variable CRUD; values remain write-only. */
async function handleAccountEnvVarRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  name?: string,
): Promise<Response> {
  if (!name) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const variables: Array<{ name: string; updatedAt: number }> =
      await ctx.runQuery(internal.accountEnvVars.list, {
        accountId: accountId,
      });

    return json({
      env: variables.map((variable) => ({
        name: variable.name,
        updatedAt: variable.updatedAt,
      })),
    });
  }
  validateAccountEnvVarName(name);
  if (req.method === "PUT") {
    const body = await req.json();
    if (
      !isPlainObject(body) ||
      typeof body.value !== "string" ||
      body.value.length < 1 ||
      body.value.length > 8192
    ) {
      throw new Error("env value must be a string from 1 to 8192 characters");
    }
    await ctx.runMutation(internal.accountEnvVars.set, {
      accountId: accountId,
      name: name,
      value: body.value,
    });
    // Values never reach the audit log — only the name of what changed.
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "environmentVariable", name: name },
      summary: "Account env var set",
    });

    return json({ name: name });
  }
  if (req.method === "DELETE") {
    const deleted: boolean = await ctx.runMutation(
      internal.accountEnvVars.remove,
      { accountId: accountId, name: name },
    );
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: { kind: "environmentVariable", name: name },
        summary: "Account env var deleted",
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["PUT", "DELETE"]);
}

/**
 * Workspace config CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleWorkspaceRoute contract.
 */
async function handleWorkspaceConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  workspaceId?: string,
): Promise<Response> {
  if (!workspaceId) {
    if (req.method === "GET") {
      const records: Doc<"workspaceConfigs">[] = await ctx.runQuery(
        internal.workspaceConfigs.list,
        { accountId: accountId },
      );

      return json({
        workspaces: records.map((record) =>
          toPublicWorkspaceConfigResponse(record),
        ),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreateWorkspaceConfigInput(await req.json());
      const createdId: Id<"workspaceConfigs"> = await ctx.runMutation(
        internal.workspaceConfigs.create,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          config: input.config,
        },
      );
      const created: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
        internal.workspaceConfigs.getById,
        {
          accountId: accountId,
          workspaceId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created workspace config");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        environmentId: created.environmentId,
        actor: actor,
        action: "created",
        resource: { kind: "workspace", id: created._id, name: created.name },
        summary: "Workspace created",
        detailsJson: auditDetailsJson({ workspaceId: created._id }),
      });

      return json(toPublicWorkspaceConfigResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspaceConfigs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );

    return record
      ? json(toPublicWorkspaceConfigResponse(record))
      : json({ error: "Workspace not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspaceConfigs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (!existing) return json({ error: "Workspace not found" }, 404);
    const patch = normalizeUpdateWorkspaceConfigInput(
      existing.config ?? { storage: { provider: "s3" } },
      await req.json(),
    );
    await ctx.runMutation(internal.workspaceConfigs.update, {
      accountId: accountId,
      workspaceId: workspaceId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description ?? undefined }
        : {}),
      config: patch.config,
    });
    const updated: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspaceConfigs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        environmentId: updated.environmentId,
        actor: actor,
        action: "updated",
        resource: { kind: "workspace", id: updated._id, name: updated.name },
        summary: "Workspace updated",
        detailsJson: auditDetailsJson({ workspaceId: updated._id }),
      });
    }

    return updated
      ? json(toPublicWorkspaceConfigResponse(updated))
      : json({ error: "Workspace not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspaceConfigs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (!existing) return json({ error: "Workspace not found" }, 404);
    if (!existing.config?.storage?.bucket) {
      // Only purge managed workspace files; bring-your-own buckets are
      // customer-owned. A purge failure fails the DELETE (matching core)
      // so the record is never removed while its files linger.
      await ctx.runAction(internal.awsWorkspaceFiles.purge, {
        accountId: accountId,
        workspaceId: existing._id,
      });
    }
    // Tear down any reserved sandbox bound to this workspace's namespace
    // (reservation keys are the namespace or namespace-prefixed).
    const namespace = await workspaceNamespace(accountId, existing._id);
    await terminateReservedInstances(
      ctx,
      accountId,
      (instance) =>
        instance.reservationKey === namespace ||
        instance.reservationKey.startsWith(`${namespace}/`),
    ).catch(() => undefined);
    await ctx.runMutation(internal.workspaceConfigs.remove, {
      accountId: accountId,
      workspaceId: workspaceId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      environmentId: existing.environmentId,
      actor: actor,
      action: "deleted",
      resource: { kind: "workspace", id: existing._id, name: existing.name },
      summary: "Workspace deleted",
      detailsJson: auditDetailsJson({ workspaceId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Sandbox config CRUD: stores encrypted config blobs and redacts secrets on read.
 * Mirrors core's former handleSandboxRoute contract.
 */
async function handleSandboxConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  sandboxId?: string,
): Promise<Response> {
  if (!sandboxId) {
    if (req.method === "GET") {
      const records: Doc<"sandboxConfigs">[] = await ctx.runQuery(
        internal.sandboxConfigs.list,
        { accountId: accountId },
      );
      const sandboxes = await Promise.all(
        records.map(async (record) =>
          toPublicSandboxConfigResponse(
            record,
            await decryptSandboxConfig(record),
          ),
        ),
      );

      return json({ sandboxes: sandboxes });
    }
    if (req.method === "POST") {
      const input = normalizeCreateSandboxConfigInput(await req.json());
      const encrypted = await encryptSandboxConfig(input.config);
      const createdId: Id<"sandboxConfigs"> = await ctx.runMutation(
        internal.sandboxConfigs.create,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          encryptedConfig: encrypted.ciphertext,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
        },
      );
      const created: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
        internal.sandboxConfigs.getById,
        {
          accountId: accountId,
          sandboxId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created sandbox config");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        environmentId: created.environmentId,
        actor: actor,
        action: "created",
        resource: { kind: "sandbox", id: created._id, name: created.name },
        summary: "Sandbox config created",
        detailsJson: auditDetailsJson({ sandboxId: created._id }),
      });

      return json(
        toPublicSandboxConfigResponse(
          created,
          await decryptSandboxConfig(created),
        ),
        201,
      );
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandboxConfigs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );

    return record
      ? json(
          toPublicSandboxConfigResponse(
            record,
            await decryptSandboxConfig(record),
          ),
        )
      : json({ error: "Sandbox not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandboxConfigs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (!existing) return json({ error: "Sandbox not found" }, 404);
    const existingConfig = await decryptSandboxConfig(existing);
    const patch = normalizeUpdateSandboxConfigInput(
      existingConfig,
      await req.json(),
    );
    const encrypted = await encryptSandboxConfig(patch.config);
    await ctx.runMutation(internal.sandboxConfigs.update, {
      accountId: accountId,
      sandboxId: sandboxId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description ?? undefined }
        : {}),
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    });
    const updated: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandboxConfigs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        environmentId: updated.environmentId,
        actor: actor,
        action: "updated",
        resource: { kind: "sandbox", id: updated._id, name: updated.name },
        summary: "Sandbox config updated",
        detailsJson: auditDetailsJson({ sandboxId: updated._id }),
      });
    }

    return updated
      ? json(
          toPublicSandboxConfigResponse(
            updated,
            await decryptSandboxConfig(updated),
          ),
        )
      : json({ error: "Sandbox not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandboxConfigs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (!existing) return json({ error: "Sandbox not found" }, 404);
    await terminateReservedInstances(
      ctx,
      accountId,
      (instance) => instance.sandboxConfigId === existing._id,
    ).catch(() => undefined);
    await ctx.runMutation(internal.sandboxConfigs.remove, {
      accountId: accountId,
      sandboxId: sandboxId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      environmentId: existing.environmentId,
      actor: actor,
      action: "deleted",
      resource: { kind: "sandbox", id: existing._id, name: existing.name },
      summary: "Sandbox config deleted",
      detailsJson: auditDetailsJson({ sandboxId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Agent policy CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handlePolicyRoute contract.
 */
async function handlePolicyConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  policyId?: string,
): Promise<Response> {
  if (!policyId) {
    if (req.method === "GET") {
      const records: Doc<"agentPolicies">[] = await ctx.runQuery(
        internal.agentPolicies.list,
        { accountId: accountId },
      );

      return json({
        policies: records.map((record) => toPublicAgentPolicyResponse(record)),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreateAgentPolicyInput(await req.json());
      const createdId: Id<"agentPolicies"> = await ctx.runMutation(
        internal.agentPolicies.createInternal,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          document: input.document,
        },
      );
      const created: Doc<"agentPolicies"> | null = await ctx.runQuery(
        internal.agentPolicies.getById,
        {
          accountId: accountId,
          policyId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created agent policy");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        environmentId: created.environmentId,
        actor: actor,
        action: "created",
        resource: { kind: "policy", id: created._id, name: created.name },
        summary: "Policy created",
        detailsJson: auditDetailsJson({ policyId: created._id }),
      });

      return json(toPublicAgentPolicyResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agentPolicies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );

    return record
      ? json(toPublicAgentPolicyResponse(record))
      : json({ error: "Policy not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agentPolicies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!existing) return json({ error: "Policy not found" }, 404);
    const patch = normalizeUpdateAgentPolicyInput(await req.json());
    await ctx.runMutation(internal.agentPolicies.updateInternal, {
      accountId: accountId,
      policyId: policyId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.document !== undefined ? { document: patch.document } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const updated: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agentPolicies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        environmentId: updated.environmentId,
        actor: actor,
        action: "updated",
        resource: { kind: "policy", id: updated._id, name: updated.name },
        summary: "Policy updated",
        detailsJson: auditDetailsJson({ policyId: updated._id }),
      });
    }

    return updated
      ? json(toPublicAgentPolicyResponse(updated))
      : json({ error: "Policy not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agentPolicies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!existing) return json({ error: "Policy not found" }, 404);
    await ctx.runMutation(internal.agentPolicies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      environmentId: existing.environmentId,
      actor: actor,
      action: "deleted",
      resource: { kind: "policy", id: existing._id, name: existing.name },
      summary: "Policy deleted",
      detailsJson: auditDetailsJson({ policyId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Skills CRUD: list/create on the collection, get/replace/delete by name.
 * Mirrors core's former handleSkillRoute contract.
 */
async function handleSkillRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  name?: string,
): Promise<Response> {
  if (!name) {
    if (req.method === "GET") {
      const skills = await ctx.runAction(internal.awsSkills.list, {
        accountId: accountId,
      });

      return json({ skills: skills });
    }
    if (req.method === "POST") {
      const skill = await ctx.runAction(internal.awsSkills.createSkill, {
        accountId: accountId,
        input: await req.json(),
      });
      const skillRecord: Record<string, unknown> = isPlainObject(skill)
        ? skill
        : {};
      const skillName =
        typeof skillRecord.name === "string"
          ? skillRecord.name
          : typeof skillRecord.path === "string"
            ? skillRecord.path
            : "skill";
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: {
          kind: "skill",
          id:
            typeof skillRecord.path === "string" ? skillRecord.path : undefined,
          name: skillName,
        },
        summary: "Skill created",
      });

      return json(skill, 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const skill = await ctx.runAction(internal.awsSkills.get, {
      accountId: accountId,
      skillName: name,
    });

    return skill ? json(skill) : json({ error: "Skill not found" }, 404);
  }
  if (req.method === "PUT") {
    const skill = await ctx.runAction(internal.awsSkills.createSkill, {
      accountId: accountId,
      input: await req.json(),
      expectedName: name,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "skill", id: name, name: name },
      summary: "Skill updated",
    });

    return json(skill);
  }
  if (req.method === "DELETE") {
    const deleted = await ctx.runAction(internal.awsSkills.remove, {
      accountId: accountId,
      skillName: name,
    });
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: { kind: "skill", id: name, name: name },
        summary: "Skill deleted",
      });
    }

    return deleted
      ? json({ deleted: true })
      : json({ error: "Skill not found" }, 404);
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

/**
 * Tools CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountTools table.
 * Mirrors core's former handleToolRoute contract.
 */
async function handleToolRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  toolId?: string,
): Promise<Response> {
  if (!toolId) {
    if (req.method === "GET") {
      const records = await ctx.runQuery(internal.accountTools.list, {
        accountId: accountId,
      });

      return json({
        tools: records.map((record) => toPublicAccountTool(record)),
      });
    }
    if (req.method === "POST") {
      const upload = await normalizeAccountToolUpload(await req.json(), {
        requireBundle: true,
      });
      const bundleStorageKey = await ctx.runAction(
        internal.awsBundles.putToolBundle,
        {
          accountId: accountId,
          sha256: upload.sha256,
          bundle: upload.bundle,
        },
      );
      const createdId = await ctx.runMutation(internal.accountTools.create, {
        accountId: accountId,
        name: upload.name,
        description: upload.description,
        inputSchema: upload.inputSchema,
        bundleStorageKey: bundleStorageKey,
        sha256: upload.sha256,
        runtime: upload.runtime,
        ...(upload.defaultConfig !== undefined
          ? { defaultConfig: upload.defaultConfig }
          : {}),
      });
      const created = await ctx.runQuery(internal.accountTools.getById, {
        accountId: accountId,
        toolId: createdId,
      });
      if (created) {
        await writeAudit(ctx, {
          accountId: accountId,
          actor: actor,
          action: "created",
          resource: { kind: "tool", id: created._id, name: created.name },
          summary: "Tool created",
          detailsJson: auditDetailsJson({
            toolId: created._id,
            sha256: created.sha256,
          }),
        });
      }

      return json(toPublicAccountTool(created!), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record = await ctx.runQuery(internal.accountTools.getById, {
      accountId: accountId,
      toolId: toolId,
    });

    return record && record.status === "active"
      ? json(toPublicAccountTool(record))
      : json({ error: "Tool not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing = await ctx.runQuery(internal.accountTools.getById, {
      accountId: accountId,
      toolId: toolId,
    });
    if (!existing || existing.status !== "active")
      return json({ error: "Tool not found" }, 404);
    const upload = await normalizeAccountToolUpload(await req.json(), {
      requireBundle: false,
    });
    const bundleStorageKey =
      upload.bundle !== undefined && upload.sha256 !== undefined
        ? await ctx.runAction(internal.awsBundles.putToolBundle, {
            accountId: accountId,
            sha256: upload.sha256,
            bundle: upload.bundle,
          })
        : undefined;
    await ctx.runMutation(internal.accountTools.update, {
      accountId: accountId,
      toolId: toolId,
      ...(upload.name !== undefined ? { name: upload.name } : {}),
      ...(upload.description !== undefined
        ? { description: upload.description }
        : {}),
      ...(upload.inputSchema !== undefined
        ? { inputSchema: upload.inputSchema }
        : {}),
      ...(bundleStorageKey !== undefined
        ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 }
        : {}),
      ...(upload.runtime !== undefined ? { runtime: upload.runtime } : {}),
      ...(upload.defaultConfig !== undefined
        ? { defaultConfig: upload.defaultConfig }
        : {}),
    });
    const updated = await ctx.runQuery(internal.accountTools.getById, {
      accountId: accountId,
      toolId: toolId,
    });
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "updated",
        resource: { kind: "tool", id: updated._id, name: updated.name },
        summary: "Tool updated",
        detailsJson: auditDetailsJson({
          toolId: updated._id,
          sha256: updated.sha256,
        }),
      });
    }

    return updated
      ? json(toPublicAccountTool(updated))
      : json({ error: "Tool not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing = await ctx.runQuery(internal.accountTools.getById, {
      accountId: accountId,
      toolId: toolId,
    });
    if (!existing || existing.status !== "active")
      return json({ error: "Tool not found" }, 404);
    await ctx.runMutation(internal.accountTools.remove, {
      accountId: accountId,
      toolId: toolId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "tool", id: existing._id, name: existing.name },
      summary: "Tool deleted",
      detailsJson: auditDetailsJson({ toolId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Hooks CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountHooks table.
 */
async function handleHookRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  hookId?: string,
): Promise<Response> {
  if (!hookId) {
    if (req.method === "GET") {
      const records = await ctx.runQuery(internal.accountHooks.list, {
        accountId: accountId,
      });

      return json({
        hooks: records.map((record) => toPublicAccountHook(record)),
      });
    }
    if (req.method === "POST") {
      const upload = await normalizeAccountHookUpload(await req.json(), {
        requireBundle: true,
      });
      const bundleStorageKey = await ctx.runAction(
        internal.awsBundles.putHookBundle,
        {
          accountId: accountId,
          sha256: upload.sha256,
          bundle: upload.bundle,
        },
      );
      const createdId = await ctx.runMutation(internal.accountHooks.create, {
        accountId: accountId,
        name: upload.name,
        ...(upload.description !== undefined
          ? { description: upload.description }
          : {}),
        events: upload.events,
        bundleStorageKey: bundleStorageKey,
        sha256: upload.sha256,
      });
      const created = await ctx.runQuery(internal.accountHooks.getById, {
        accountId: accountId,
        hookId: createdId,
      });
      if (created) {
        await writeAudit(ctx, {
          accountId: accountId,
          actor: actor,
          action: "created",
          resource: { kind: "hook", id: created._id, name: created.name },
          summary: "Hook created",
          detailsJson: auditDetailsJson({
            hookId: created._id,
            sha256: created.sha256,
          }),
        });
      }

      return json(toPublicAccountHook(created!), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record = await ctx.runQuery(internal.accountHooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });

    return record && record.status === "active"
      ? json(toPublicAccountHook(record))
      : json({ error: "Hook not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing = await ctx.runQuery(internal.accountHooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });
    if (!existing || existing.status !== "active")
      return json({ error: "Hook not found" }, 404);
    const upload = await normalizeAccountHookUpload(await req.json(), {
      requireBundle: false,
    });
    const bundleStorageKey =
      upload.bundle !== undefined && upload.sha256 !== undefined
        ? await ctx.runAction(internal.awsBundles.putHookBundle, {
            accountId: accountId,
            sha256: upload.sha256,
            bundle: upload.bundle,
          })
        : undefined;
    await ctx.runMutation(internal.accountHooks.update, {
      accountId: accountId,
      hookId: hookId,
      ...(upload.name !== undefined ? { name: upload.name } : {}),
      ...(upload.description !== undefined
        ? { description: upload.description }
        : {}),
      ...(upload.events !== undefined ? { events: upload.events } : {}),
      ...(bundleStorageKey !== undefined
        ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 }
        : {}),
    });
    const updated = await ctx.runQuery(internal.accountHooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "updated",
        resource: { kind: "hook", id: updated._id, name: updated.name },
        summary: "Hook updated",
        detailsJson: auditDetailsJson({
          hookId: updated._id,
          sha256: updated.sha256,
        }),
      });
    }

    return updated
      ? json(toPublicAccountHook(updated))
      : json({ error: "Hook not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing = await ctx.runQuery(internal.accountHooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });
    if (!existing || existing.status !== "active")
      return json({ error: "Hook not found" }, 404);
    await ctx.runMutation(internal.accountHooks.remove, {
      accountId: accountId,
      hookId: hookId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "hook", id: existing._id, name: existing.name },
      summary: "Hook deleted",
      detailsJson: auditDetailsJson({ hookId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Workspace files: list/presign on GET, upload on POST, rename on PATCH,
 * delete on DELETE. Mirrors core's former handleWorkspaceFilesRoute contract.
 */
async function handleWorkspaceFilesRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  workspaceId: string,
): Promise<Response> {
  const workspace = await ctx.runQuery(internal.workspaceConfigs.getById, {
    accountId: accountId,
    workspaceId: workspaceId,
  });
  if (!workspace) return json({ error: "Workspace not found" }, 404);
  const target = { accountId: accountId, workspaceId: workspace._id };

  if (req.method === "GET") {
    const path = new URL(req.url).searchParams.get("path");
    if (path) {
      return json({
        url: await ctx.runAction(internal.awsWorkspaceFiles.downloadUrl, {
          ...target,
          path: path,
        }),
      });
    }

    return json({
      files: await ctx.runAction(internal.awsWorkspaceFiles.list, target),
    });
  }
  if (req.method === "POST") {
    const body = (await req.json()) as {
      path?: unknown;
      contentBase64?: unknown;
      contentType?: unknown;
    };
    if (
      typeof body.path !== "string" ||
      typeof body.contentBase64 !== "string"
    ) {
      return json({ error: "path and contentBase64 are required" }, 400);
    }
    const file = await ctx.runAction(internal.awsWorkspaceFiles.upload, {
      ...target,
      path: body.path,
      contentBase64: body.contentBase64,
      ...(typeof body.contentType === "string"
        ? { contentType: body.contentType }
        : {}),
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: workspace.projectId,
      environmentId: workspace.environmentId,
      actor: actor,
      action: "file-uploaded",
      resource: { kind: "workspaceFile", id: workspace._id, name: body.path },
      summary: "Workspace file uploaded",
      detailsJson: auditDetailsJson({
        workspaceId: workspace._id,
        path: body.path,
      }),
    });

    return json({ file: file }, 201);
  }
  if (req.method === "PATCH") {
    const body = (await req.json()) as { path?: unknown; newPath?: unknown };
    if (typeof body.path !== "string" || typeof body.newPath !== "string") {
      return json({ error: "path and newPath are required" }, 400);
    }
    const renamed = await ctx.runAction(internal.awsWorkspaceFiles.renamePath, {
      ...target,
      path: body.path,
      newPath: body.newPath,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: workspace.projectId,
      environmentId: workspace.environmentId,
      actor: actor,
      action: "file-updated",
      resource: {
        kind: "workspaceFile",
        id: workspace._id,
        name: body.newPath,
      },
      summary: "Workspace file updated",
      detailsJson: auditDetailsJson({
        workspaceId: workspace._id,
        path: body.path,
        newPath: body.newPath,
      }),
    });

    return json({ renamed: renamed });
  }
  if (req.method === "DELETE") {
    const body = (await req.json()) as { path?: unknown };
    if (typeof body.path !== "string")
      return json({ error: "path is required" }, 400);
    const deleted = await ctx.runAction(internal.awsWorkspaceFiles.removePath, {
      ...target,
      path: body.path,
    });
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: workspace.projectId,
        environmentId: workspace.environmentId,
        actor: actor,
        action: "file-deleted",
        resource: { kind: "workspaceFile", id: workspace._id, name: body.path },
        summary: "Workspace file deleted",
        detailsJson: auditDetailsJson({
          workspaceId: workspace._id,
          path: body.path,
        }),
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["GET", "POST", "PATCH", "DELETE"]);
}

/**
 * Cron CRUD: list/create on the collection, get/patch/delete by id, plus the
 * run history at /v1/crons/{id}/runs. Table writes and EventBridge Scheduler
 * mutations happen in awsCrons; mirrors core's former handleCronRoute contract.
 */
async function handleCronRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  cronId: string | undefined,
  runs: boolean,
): Promise<Response> {
  if (runs && cronId) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const limit = parseCronRunsLimit(
      new URL(req.url).searchParams.get("limit"),
    );
    const records = await ctx
      .runQuery(internal.cron.listRuns, {
        accountId: accountId,
        cronId: cronId as Id<"crons">,
        ...(limit !== undefined ? { limit: limit } : {}),
      })
      .catch(() => []);

    return json({ runs: records.map((record) => toCronRunResponse(record)) });
  }

  if (!cronId) {
    if (req.method === "GET") {
      const records = await ctx.runQuery(internal.cron.list, {
        accountId: accountId,
      });

      return json({ crons: records.map((record) => toCronResponse(record)) });
    }
    if (req.method === "POST") {
      const cron = await ctx.runAction(internal.awsCrons.create, {
        accountId: accountId,
        input: await req.json(),
      });
      const cronRecord = isPlainObject(cron) ? cron : {};
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: {
          kind: "cron",
          id:
            typeof cronRecord.cronId === "string"
              ? cronRecord.cronId
              : undefined,
          name:
            typeof cronRecord.name === "string" ? cronRecord.name : undefined,
        },
        summary: "Cron job created",
        detailsJson:
          typeof cronRecord.cronId === "string"
            ? auditDetailsJson({ cronId: cronRecord.cronId })
            : undefined,
      });

      return json(cron, 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record = await ctx
      .runQuery(internal.cron.getById, {
        accountId: accountId,
        cronId: cronId as Id<"crons">,
      })
      .catch(() => null);

    return record
      ? json(toCronResponse(record))
      : json({ error: "Cron job not found" }, 404);
  }
  if (req.method === "PATCH") {
    const cron = await ctx.runAction(internal.awsCrons.update, {
      accountId: accountId,
      cronId: cronId,
      patch: await req.json(),
    });
    if (cron) {
      const cronRecord = isPlainObject(cron) ? cron : {};
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "updated",
        resource: {
          kind: "cron",
          id:
            typeof cronRecord.cronId === "string" ? cronRecord.cronId : cronId,
          name:
            typeof cronRecord.name === "string" ? cronRecord.name : undefined,
        },
        summary: "Cron job updated",
        detailsJson: auditDetailsJson({ cronId: cronId }),
      });
    }

    return cron ? json(cron) : json({ error: "Cron job not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing = await ctx
      .runQuery(internal.cron.getById, {
        accountId: accountId,
        cronId: cronId as Id<"crons">,
      })
      .catch(() => null);
    const deleted = await ctx.runAction(internal.awsCrons.remove, {
      accountId: accountId,
      cronId: cronId,
    });
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: {
          kind: "cron",
          id: existing?._id ?? cronId,
          name: existing?.name,
        },
        summary: "Cron job deleted",
        detailsJson: auditDetailsJson({ cronId: cronId }),
      });
    }

    return deleted
      ? json({ deleted: true })
      : json({ error: "Cron job not found" }, 404);
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Map an accountTools document to the public tool shape core used to return.
 * @param record the accountTools document
 * @returns the public record with toolId and ISO timestamps
 */
function toPublicAccountTool(
  record: Doc<"accountTools">,
): Record<string, unknown> {
  return {
    accountId: record.accountId,
    toolId: record._id,
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    sha256: record.sha256,
    runtime: record.runtime ?? "sandbox",
    ...(record.defaultConfig !== undefined
      ? { defaultConfig: record.defaultConfig }
      : {}),
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.deletedAt
      ? { deletedAt: new Date(record.deletedAt).toISOString() }
      : {}),
  };
}

/**
 * Map an accountHooks document to the public hook shape.
 * @param record the accountHooks document
 * @returns the public record with hookId and ISO timestamps
 */
function toPublicAccountHook(
  record: Doc<"accountHooks">,
): Record<string, unknown> {
  return {
    accountId: record.accountId,
    hookId: record._id,
    name: record.name,
    ...(record.description !== undefined
      ? { description: record.description }
      : {}),
    events: record.events,
    sha256: record.sha256,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.deletedAt
      ? { deletedAt: new Date(record.deletedAt).toISOString() }
      : {}),
  };
}

async function validateAgentReferences(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  await validateAgentSkillPaths(ctx, accountId, config);
  await validateAgentSubagentIds(ctx, accountId, config);
  await validateAgentPolicyIds(ctx, accountId, config);
}

// Skills are account-scoped, so bare names canonicalize to <accountId>/<name>
// in place — callers must run this BEFORE the config is encrypted to persist.
export function canonicalizeAgentSkillPaths(
  accountId: Id<"accounts">,
  config: AgentConfig | undefined,
): void {
  const skills = config?.skills;
  if (!skills?.allowed) return;
  skills.allowed = skills.allowed.map((skillPath) =>
    skillPath.includes("/") ? skillPath : `${accountId}/${skillPath}`,
  );
}

async function validateAgentSkillPaths(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const skillPath of config.skills?.allowed ?? []) {
    const parts = skillPath.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid skill path: ${skillPath}`);
    }
    if (parts[0] !== accountId) {
      throw new Error(`Skill path belongs to another account: ${skillPath}`);
    }
    const skill: unknown | null = await ctx.runAction(internal.awsSkills.get, {
      accountId: accountId,
      skillName: parts[1],
    });
    if (!skill) throw new Error(`Skill not found: ${skillPath}`);
  }
}

async function validateAgentSubagentIds(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const agentId of config.subagent?.allowed ?? []) {
    const agent: Doc<"agents"> | null = await ctx.runQuery(
      internal.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!agent) throw new Error(`Subagent not found: ${agentId}`);
  }
}

async function validateAgentPolicyIds(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const policyId of config.policy?.policyIds ?? []) {
    const policy: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agentPolicies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!policy) throw new Error(`Agent policy not found: ${policyId}`);
  }
}

async function decryptAgentConfig(doc: Doc<"agents">): Promise<AgentConfig> {
  if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
    return {};
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedConfig,
      iv: doc.encryptionIv,
      tag: doc.encryptionTag,
    },
    configEncryptionSecret(),
  );
  if (!decrypted) throw new Error("Failed to decrypt agent config");

  return decrypted as AgentConfig;
}

/** Decrypt the unresolved config when present so API reads and PATCHes preserve placeholders. */
async function decryptAgentConfigForPublicRead(
  doc: Doc<"agents">,
): Promise<AgentConfig> {
  if (
    !doc.encryptedSourceConfig ||
    !doc.sourceEncryptionIv ||
    !doc.sourceEncryptionTag
  ) {
    return await decryptAgentConfig(doc);
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedSourceConfig,
      iv: doc.sourceEncryptionIv,
      tag: doc.sourceEncryptionTag,
    },
    configEncryptionSecret(),
  );
  if (!decrypted) throw new Error("Failed to decrypt agent source config");

  return decrypted as AgentConfig;
}

type PreparedAccountAgentConfig = {
  encrypted: { ciphertext: string; iv: string; tag: string };
  source?: { ciphertext: string; iv: string; tag: string };
};

/** Resolve valid account env references on a normalized config, rejecting missing names on writes. */
async function prepareAccountAgentConfig(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  sourceConfig: AgentConfig,
): Promise<PreparedAccountAgentConfig> {
  const names = [...collectEnvPlaceholderNames(sourceConfig)].sort();
  if (names.length === 0)
    return { encrypted: await encryptAgentConfig(sourceConfig) };
  const values: Record<string, string> = await ctx.runQuery(
    internal.accountEnvVars.loadValues,
    { accountId: accountId },
  );
  const missing = names.filter(
    (name) => !Object.prototype.hasOwnProperty.call(values, name),
  );
  if (missing.length > 0)
    throw new Error(`unknown env vars: ${missing.join(", ")}`);

  return {
    encrypted: await encryptAgentConfig(
      substituteAccountEnvPlaceholders(sourceConfig, values),
    ),
    source: await encryptAgentConfig(sourceConfig),
  };
}

/** Validate the stable uppercase name accepted by account env-var routes and references. */
function validateAccountEnvVarName(name: string): void {
  if (!ACCOUNT_ENV_VAR_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      "env name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters",
    );
  }
}

async function encryptAgentConfig(
  config: AgentConfig,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  return await encryptAgentConfigBlob(config, configEncryptionSecret());
}

async function decryptSandboxConfig(
  doc: Doc<"sandboxConfigs">,
): Promise<SandboxConfig> {
  if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
    return { provider: "sandbox", permissionMode: "ask" };
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedConfig,
      iv: doc.encryptionIv,
      tag: doc.encryptionTag,
    },
    configEncryptionSecret(),
  );

  return decrypted
    ? (decrypted as unknown as SandboxConfig)
    : { provider: "sandbox", permissionMode: "ask" };
}

async function encryptSandboxConfig(
  config: SandboxConfig,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  return await encryptAgentConfigBlob(
    config as unknown as Record<string, unknown>,
    configEncryptionSecret(),
  );
}

function configEncryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required");

  return secret;
}

/**
 * Terminate reserved sandbox instances matching a predicate through core's
 * lifecycle route (which owns the decrypted provider credentials). Best-effort:
 * skips rows without a sandboxConfigId and swallows per-instance failures.
 */
async function terminateReservedInstances(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  matches: (instance: Doc<"sandboxInstances">) => boolean,
): Promise<void> {
  const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
  const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
  if (!url || !secret) return;

  const instances: Doc<"sandboxInstances">[] = await ctx.runQuery(
    internal.sandboxInstances.listForAccount,
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
          (instance.status === "running" || instance.status === "suspended") &&
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

function methodNotAllowed(allowedMethods: string[]): Response {
  return json(
    { error: "Method not allowed", allowedMethods: allowedMethods },
    405,
  );
}

function isClientInputError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof SyntaxError) return true;
  return [
    "tool.",
    "Request body",
    "source must",
    "files must",
    "Each file",
    "JSON skills",
    "Skill ",
    "Duplicate skill ",
    "Invalid skill ",
    "Invalid request JSON:",
    "Invalid skill path:",
    "Skill path belongs",
    "Skill not found:",
    "Subagent not found:",
    "Agent policy not found:",
    "Agent name already exists:",
    "SKILL.md ",
    "GitHub skill URL ",
    "GitHub archive ",
    "url must ",
    "path ",
    "path and ",
    "contentBase64 ",
    "config must",
    "config.",
    "e2b ",
    "Invalid workspace path",
    "Invalid destination path",
    "Workspace uploads ",
    "Workspace file not found",
    "Workspace path not found",
    "name must",
    "username must",
    "agentId must",
    "Agent config ",
    "description must",
    "conversationKey must",
    "scheduleExpression must",
    "timezone ",
    "status must",
    "policy ",
    "Policy document",
    "Policy rule",
    "Policy does not belong",
    "Sandbox config does not belong",
    "Workspace config does not belong",
    "events must",
    "Provide exactly one of",
    "limit must",
    "Cron job agentId ",
    "unknown env vars:",
    "env name must",
    "env value must",
  ].some((prefix) => error.message.startsWith(prefix));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

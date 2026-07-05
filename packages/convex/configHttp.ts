/**
 * Public config-plane HTTP surface (epic #85 phase 9): agents, skills, tools,
 * workspace files, crons, workspaces, sandboxes, and policies served straight
 * from Convex. The gateway forwards these paths here; response shapes match
 * the retired core handlers so the public API contract is unchanged. Auth is
 * the account Bearer secret.
 */

import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createAccountSecret, hashAccountSecret } from "./model/accountSecrets";
import { normalizeAccountToolUpload } from "./model/accountTools";
import { decryptAgentConfigBlob, encryptAgentConfigBlob } from "./model/agentConfigCodec";
import {
    normalizeCreateAgentInput,
    normalizeUpdateAgentInput,
    toPublicAgentResponse,
    type AgentConfig,
} from "./model/agentRules";
import { parseCronRunsLimit, toCronResponse, toCronRunResponse } from "./model/cronRules";
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
import { isPlainObject } from "./model/objects";

export const handle = httpAction(async (ctx, req) => {
    try {
        const accountRoute = parseAccountRoute(new URL(req.url).pathname);
        if (accountRoute) return await handleAccountRoute(ctx, req, accountRoute);

        const account = await requireAccount(ctx, req);
        if (!account) return json({ error: "Unauthorized" }, 401);
        const route = parseRoute(new URL(req.url).pathname);
        if (!route) return json({ error: "Not found" }, 404);

        switch (route.kind) {
            case "skills":
                return await handleSkillRoute(ctx, req, account._id, route.name);
            case "tools":
                return await handleToolRoute(ctx, req, account._id, route.toolId);
            case "workspaceFiles":
                return await handleWorkspaceFilesRoute(ctx, req, account._id, route.workspaceId);
            case "crons":
                return await handleCronRoute(ctx, req, account._id, route.cronId, route.runs);
            case "workspaces":
                return await handleWorkspaceConfigRoute(ctx, req, account._id, route.workspaceId);
            case "sandboxes":
                return await handleSandboxConfigRoute(ctx, req, account._id, route.sandboxId);
            case "policies":
                return await handlePolicyConfigRoute(ctx, req, account._id, route.policyId);
            case "agents":
                return await handleAgentConfigRoute(ctx, req, account._id, route.agentId);
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
    if (error.message.startsWith("Skill path belongs to another account:")) return 401;
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
    if (record?.[1]) return { kind: "adminRecord", accountId: decodeURIComponent(record[1]) };

    const rotate = pathname.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
    if (rotate?.[1]) return { kind: "adminRotate", accountId: decodeURIComponent(rotate[1]) };

    return { kind: "adminUnknown" };
}

/**
 * Handle account self-management and admin account config routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @param route parsed account route
 * @returns HTTP response matching core account-management payloads
 */
async function handleAccountRoute(ctx: ActionCtx, req: Request, route: AccountHttpRoute): Promise<Response> {
    if (route.kind === "self" || route.kind === "selfRotate") {
        const account = await requireSelfAccount(ctx, req);
        if (account instanceof Response) return account;

        if (route.kind === "self") {
            if (req.method === "GET") return json({ account: toPublicAccount(account) });
            if (req.method === "PATCH") return await updateAccountResponse(ctx, account._id, await parseJsonRequest(req));

            return methodNotAllowed(["GET", "PATCH"]);
        }

        if (req.method === "POST") return await rotateAccountSecretResponse(ctx, account._id);

        return methodNotAllowed(["POST"]);
    }

    const admin = await requireAdminAuth(ctx, req);
    if (admin instanceof Response) return admin;

    if (route.kind === "adminUnknown") return json({ error: "Not found" }, 404);

    if (route.kind === "adminList") {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const accounts: Doc<"accounts">[] = await ctx.runQuery(internal.accounts.list, {});

        return json({ accounts: accounts.map((account) => toPublicAccount(account)) });
    }

    if (route.kind === "adminRecord") {
        if (req.method === "GET") {
            const account: Doc<"accounts"> | null = await getAccountById(ctx, route.accountId);

            return account ? json({ account: toPublicAccount(account) }) : json({ error: "Account not found" }, 404);
        }
        if (req.method === "PATCH") return await updateAccountResponse(ctx, route.accountId, await parseJsonRequest(req));

        return methodNotAllowed(["GET", "PATCH"]);
    }

    if (req.method === "POST") return await rotateAccountSecretResponse(ctx, route.accountId);

    return methodNotAllowed(["POST"]);
}

/**
 * Require account-secret auth for `/v1/account*` routes with core parity.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns active account or an error response
 */
async function requireSelfAccount(ctx: ActionCtx, req: Request): Promise<Doc<"accounts"> | Response> {
    const auth = await resolveBearerAuth(ctx, req);
    if (!auth) return json({ error: "Unauthorized" }, 401);
    if (auth.kind === "admin") return json({ error: "Admin must use account-specific endpoints" }, 400);
    if (auth.kind === "deployment") return json({ error: "Unauthorized" }, 401);
    if (auth.viaServiceToken === true) {
        return json({ error: "Service token is not allowed for this account endpoint" }, 400);
    }

    return auth.account;
}

/**
 * Require the admin bearer secret for `/accounts*` routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns true or an error response
 */
async function requireAdminAuth(ctx: ActionCtx, req: Request): Promise<true | Response> {
    const auth = await resolveBearerAuth(ctx, req);
    if (!auth) return json({ error: "Unauthorized" }, 401);
    if (auth.kind !== "admin") return json({ error: "Forbidden" }, 403);

    return true;
}

/**
 * Resolve Bearer auth into admin, account, service-account, or deployment auth.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns auth context or null for missing/unknown/disabled credentials
 */
async function resolveBearerAuth(ctx: ActionCtx, req: Request): Promise<ConfigAuth | null> {
    const token = bearerToken(req);
    if (!token) return null;
    const tokenHash = await hashAccountSecret(token);

    const adminSecret = process.env.ADMIN_ACCOUNT_SECRET;
    if (adminSecret && digestEqual(tokenHash, await hashAccountSecret(adminSecret))) {
        return { kind: "admin" };
    }

    const serviceSecret = process.env.BROODS_SERVICE_AUTH_SECRET ?? process.env.SERVICE_AUTH_SECRET;
    if (serviceSecret && digestEqual(tokenHash, await hashAccountSecret(serviceSecret))) {
        const accountId = req.headers.get("X-Account-Id") ?? req.headers.get("x-account-id") ?? "";
        const account: Doc<"accounts"> | null = accountId ? await getAccountById(ctx, accountId) : null;
        return account && account.status === "active"
            ? { kind: "account", account: account, viaServiceToken: true }
            : null;
    }

    const deployment: {
        accountId: Id<"accounts">;
        endpointId: string;
        projectSlug: string;
        environmentSlug: string;
    } | null = await ctx.runQuery(internal.agentDeployments.getByApiKeyHash, { apiKeyHash: tokenHash });
    if (deployment) return { kind: "deployment" };

    const account: Doc<"accounts"> | null = await ctx.runQuery(internal.accounts.getBySecretHash, { secretHash: tokenHash });
    return account && account.status === "active" ? { kind: "account", account: account } : null;
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
 * Fetch an account id while treating malformed ids as not found.
 * @param ctx Convex action context
 * @param accountId account id string from the route
 * @returns account document or null
 */
async function getAccountById(ctx: ActionCtx, accountId: string): Promise<Doc<"accounts"> | null> {
    try {
        const account: Doc<"accounts"> | null = await ctx.runQuery(internal.accounts.getById, {
            accountId: accountId as Id<"accounts">,
        });

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
        throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Normalize account metadata patches with core's error strings.
 * @param value raw JSON body
 * @returns normalized account update input
 */
function normalizeAccountUpdateInput(value: unknown): AccountUpdateInput {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    if ("config" in value) throw new Error("Agent config must be updated through /v1/agents/{agentId}");
    const normalized: AccountUpdateInput = {
        ...(value.username !== undefined ? { username: requireString(value.username, "username") } : {}),
        ...(value.description !== undefined
            ? { description: value.description === null ? null : optionalString(value.description, "description") }
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
async function updateAccountResponse(ctx: ActionCtx, accountId: string, input: unknown): Promise<Response> {
    const existing = await getAccountById(ctx, accountId);
    if (!existing) return json({ error: "Account not found" }, 404);
    const patch = normalizeAccountUpdateInput(input);
    await ctx.runMutation(internal.accounts.update, {
        accountId: existing._id,
        ...(patch.username !== undefined ? { username: patch.username } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
    });
    const updated: Doc<"accounts"> | null = await ctx.runQuery(internal.accounts.getById, { accountId: existing._id });

    return updated ? json({ account: toPublicAccount(updated) }) : json({ error: "Account not found" }, 404);
}

/**
 * Rotate an account secret hash and return the one-time plaintext secret.
 * @param ctx Convex action context
 * @param accountId account id to rotate
 * @returns rotate-secret response
 */
async function rotateAccountSecretResponse(ctx: ActionCtx, accountId: string): Promise<Response> {
    const existing = await getAccountById(ctx, accountId);
    if (!existing) return json({ error: "Account not found" }, 404);
    const secret = createAccountSecret();
    await ctx.runMutation(internal.accounts.update, {
        accountId: existing._id,
        secretHash: await hashAccountSecret(secret),
    });
    const updated: Doc<"accounts"> | null = await ctx.runQuery(internal.accounts.getById, { accountId: existing._id });

    return updated ? json({ account: toPublicAccount(updated), secret: secret }) : json({ error: "Account not found" }, 404);
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
    | { kind: "workspaceFiles"; workspaceId: string }
    | { kind: "crons"; cronId?: string; runs: boolean }
    | { kind: "workspaces"; workspaceId?: string }
    | { kind: "sandboxes"; sandboxId?: string }
    | { kind: "policies"; policyId?: string }
    | { kind: "agents"; agentId?: string };

/**
 * Parse a config-plane pathname into its route parts.
 * @param pathname the request pathname
 * @returns the parsed route, or null when the path is not a config route
 */
function parseRoute(pathname: string): ConfigRoute | null {
    const skills = pathname.match(/^\/v1\/skills(?:\/([^/]+))?$/);
    if (skills) return { kind: "skills", ...(skills[1] ? { name: decodeURIComponent(skills[1]) } : {}) };

    const tools = pathname.match(/^\/v1\/tools(?:\/([^/]+))?$/);
    if (tools) return { kind: "tools", ...(tools[1] ? { toolId: decodeURIComponent(tools[1]) } : {}) };

    const files = pathname.match(/^\/v1\/workspaces\/([^/]+)\/files$/);
    if (files?.[1]) return { kind: "workspaceFiles", workspaceId: decodeURIComponent(files[1]) };

    const workspaces = pathname.match(/^\/v1\/workspaces(?:\/([^/]+))?$/);
    if (workspaces) return { kind: "workspaces", ...(workspaces[1] ? { workspaceId: decodeURIComponent(workspaces[1]) } : {}) };

    const sandboxes = pathname.match(/^\/v1\/sandboxes(?:\/([^/]+))?$/);
    if (sandboxes) return { kind: "sandboxes", ...(sandboxes[1] ? { sandboxId: decodeURIComponent(sandboxes[1]) } : {}) };

    const policies = pathname.match(/^\/v1\/policies(?:\/([^/]+))?$/);
    if (policies) return { kind: "policies", ...(policies[1] ? { policyId: decodeURIComponent(policies[1]) } : {}) };

    const agents = pathname.match(/^\/v1\/agents(?:\/([^/]+))?$/);
    if (agents) return { kind: "agents", ...(agents[1] ? { agentId: decodeURIComponent(agents[1]) } : {}) };

    const cronRuns = pathname.match(/^\/v1\/crons\/([^/]+)\/runs$/);
    if (cronRuns?.[1]) return { kind: "crons", cronId: decodeURIComponent(cronRuns[1]), runs: true };

    const crons = pathname.match(/^\/v1\/crons(?:\/([^/]+))?$/);
    if (crons) return { kind: "crons", ...(crons[1] ? { cronId: decodeURIComponent(crons[1]) } : {}), runs: false };

    return null;
}

/**
 * Resolve the Bearer token to an account.
 * @param ctx the action context
 * @param req the incoming request
 * @returns the account document, or null when the token is missing or unknown
 */
async function requireAccount(ctx: ActionCtx, req: Request): Promise<Doc<"accounts"> | null> {
    const auth = await resolveBearerAuth(ctx, req);

    return auth?.kind === "account" && auth.viaServiceToken !== true ? auth.account : null;
}

/**
 * Agent CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleAgentRoute contract.
 */
async function handleAgentConfigRoute(
    ctx: ActionCtx,
    req: Request,
    accountId: Id<"accounts">,
    agentId?: string,
): Promise<Response> {
    if (!agentId) {
        if (req.method === "GET") {
            const records: Doc<"agents">[] = await ctx.runQuery(internal.agents.list, { accountId: accountId });
            const agents = await Promise.all(records.map(async (record) =>
                toPublicAgentResponse(record, await decryptAgentConfig(record))
            ));

            return json({ agents: agents });
        }
        if (req.method === "POST") {
            const input = normalizeCreateAgentInput(await req.json());
            await validateAgentReferences(ctx, accountId, input.config);
            const encrypted = await encryptAgentConfig(input.config);
            const createdId: Id<"agents"> = await ctx.runMutation(internal.agents.create, {
                accountId: accountId,
                name: input.name,
                description: input.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
            });
            const created: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
                accountId: accountId,
                agentId: createdId,
            });
            if (!created) throw new Error("Failed to fetch created agent");

            return json({
                accountId: created.accountId,
                agentId: created._id,
                name: created.name,
                ...(created.description ? { description: created.description } : {}),
            }, 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
            accountId: accountId,
            agentId: agentId,
        });

        return record ? json(toPublicAgentResponse(record, await decryptAgentConfig(record))) : json({ error: "Agent not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
            accountId: accountId,
            agentId: agentId,
        });
        if (!existing) return json({ error: "Agent not found" }, 404);
        const existingConfig = await decryptAgentConfig(existing);
        const patch = normalizeUpdateAgentInput(existingConfig, await req.json());
        await validateAgentReferences(ctx, accountId, patch.config);
        const encrypted = await encryptAgentConfig(patch.config);
        await ctx.runMutation(internal.agents.update, {
            accountId: accountId,
            agentId: agentId,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            // Null is dropped, not forwarded: core's adapter has always done
            // `?? undefined` here, so PATCH {description: null} is a no-op
            // for agents (unlike policies, where null clears).
            ...(patch.description !== undefined ? { description: patch.description ?? undefined } : {}),
            encryptedConfig: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
        });
        const updated: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
            accountId: accountId,
            agentId: agentId,
        });

        return updated ? json(toPublicAgentResponse(updated, await decryptAgentConfig(updated))) : json({ error: "Agent not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
            accountId: accountId,
            agentId: agentId,
        });
        if (!existing) return json({ error: "Agent not found" }, 404);
        await ctx.runMutation(internal.agents.remove, { accountId: accountId, agentId: agentId });

        return json({ deleted: true });
    }

    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Workspace config CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleWorkspaceRoute contract.
 */
async function handleWorkspaceConfigRoute(
    ctx: ActionCtx,
    req: Request,
    accountId: Id<"accounts">,
    workspaceId?: string,
): Promise<Response> {
    if (!workspaceId) {
        if (req.method === "GET") {
            const records: Doc<"workspaceConfigs">[] = await ctx.runQuery(internal.workspaceConfigs.list, { accountId: accountId });

            return json({ workspaces: records.map((record) => toPublicWorkspaceConfigResponse(record)) });
        }
        if (req.method === "POST") {
            const input = normalizeCreateWorkspaceConfigInput(await req.json());
            const createdId: Id<"workspaceConfigs"> = await ctx.runMutation(internal.workspaceConfigs.create, {
                accountId: accountId,
                name: input.name,
                description: input.description,
                config: input.config,
            });
            const created: Doc<"workspaceConfigs"> | null = await ctx.runQuery(internal.workspaceConfigs.getById, {
                accountId: accountId,
                workspaceId: createdId,
            });
            if (!created) throw new Error("Failed to fetch created workspace config");

            return json(toPublicWorkspaceConfigResponse(created), 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record: Doc<"workspaceConfigs"> | null = await ctx.runQuery(internal.workspaceConfigs.getById, {
            accountId: accountId,
            workspaceId: workspaceId,
        });

        return record ? json(toPublicWorkspaceConfigResponse(record)) : json({ error: "Workspace not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(internal.workspaceConfigs.getById, {
            accountId: accountId,
            workspaceId: workspaceId,
        });
        if (!existing) return json({ error: "Workspace not found" }, 404);
        const patch = normalizeUpdateWorkspaceConfigInput(
            existing.config ?? { storage: { provider: "s3" } },
            await req.json(),
        );
        await ctx.runMutation(internal.workspaceConfigs.update, {
            accountId: accountId,
            workspaceId: workspaceId,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description ?? undefined } : {}),
            config: patch.config,
        });
        const updated: Doc<"workspaceConfigs"> | null = await ctx.runQuery(internal.workspaceConfigs.getById, {
            accountId: accountId,
            workspaceId: workspaceId,
        });

        return updated ? json(toPublicWorkspaceConfigResponse(updated)) : json({ error: "Workspace not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(internal.workspaceConfigs.getById, {
            accountId: accountId,
            workspaceId: workspaceId,
        });
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
        await terminateReservedInstances(ctx, accountId, (instance) =>
            instance.reservationKey === namespace || instance.reservationKey.startsWith(`${namespace}/`),
        ).catch(() => undefined);
        await ctx.runMutation(internal.workspaceConfigs.remove, { accountId: accountId, workspaceId: workspaceId });

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
    sandboxId?: string,
): Promise<Response> {
    if (!sandboxId) {
        if (req.method === "GET") {
            const records: Doc<"sandboxConfigs">[] = await ctx.runQuery(internal.sandboxConfigs.list, { accountId: accountId });
            const sandboxes = await Promise.all(records.map(async (record) =>
                toPublicSandboxConfigResponse(record, await decryptSandboxConfig(record))
            ));

            return json({ sandboxes: sandboxes });
        }
        if (req.method === "POST") {
            const input = normalizeCreateSandboxConfigInput(await req.json());
            const encrypted = await encryptSandboxConfig(input.config);
            const createdId: Id<"sandboxConfigs"> = await ctx.runMutation(internal.sandboxConfigs.create, {
                accountId: accountId,
                name: input.name,
                description: input.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
            });
            const created: Doc<"sandboxConfigs"> | null = await ctx.runQuery(internal.sandboxConfigs.getById, {
                accountId: accountId,
                sandboxId: createdId,
            });
            if (!created) throw new Error("Failed to fetch created sandbox config");

            return json(toPublicSandboxConfigResponse(created, await decryptSandboxConfig(created)), 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record: Doc<"sandboxConfigs"> | null = await ctx.runQuery(internal.sandboxConfigs.getById, {
            accountId: accountId,
            sandboxId: sandboxId,
        });

        return record ? json(toPublicSandboxConfigResponse(record, await decryptSandboxConfig(record))) : json({ error: "Sandbox not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(internal.sandboxConfigs.getById, {
            accountId: accountId,
            sandboxId: sandboxId,
        });
        if (!existing) return json({ error: "Sandbox not found" }, 404);
        const existingConfig = await decryptSandboxConfig(existing);
        const patch = normalizeUpdateSandboxConfigInput(existingConfig, await req.json());
        const encrypted = await encryptSandboxConfig(patch.config);
        await ctx.runMutation(internal.sandboxConfigs.update, {
            accountId: accountId,
            sandboxId: sandboxId,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description ?? undefined } : {}),
            encryptedConfig: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
        });
        const updated: Doc<"sandboxConfigs"> | null = await ctx.runQuery(internal.sandboxConfigs.getById, {
            accountId: accountId,
            sandboxId: sandboxId,
        });

        return updated ? json(toPublicSandboxConfigResponse(updated, await decryptSandboxConfig(updated))) : json({ error: "Sandbox not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(internal.sandboxConfigs.getById, {
            accountId: accountId,
            sandboxId: sandboxId,
        });
        if (!existing) return json({ error: "Sandbox not found" }, 404);
        await terminateReservedInstances(ctx, accountId, (instance) => instance.sandboxConfigId === existing._id)
            .catch(() => undefined);
        await ctx.runMutation(internal.sandboxConfigs.remove, { accountId: accountId, sandboxId: sandboxId });

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
    policyId?: string,
): Promise<Response> {
    if (!policyId) {
        if (req.method === "GET") {
            const records: Doc<"agentPolicies">[] = await ctx.runQuery(internal.agentPolicies.list, { accountId: accountId });

            return json({ policies: records.map((record) => toPublicAgentPolicyResponse(record)) });
        }
        if (req.method === "POST") {
            const input = normalizeCreateAgentPolicyInput(await req.json());
            const createdId: Id<"agentPolicies"> = await ctx.runMutation(internal.agentPolicies.createInternal, {
                accountId: accountId,
                name: input.name,
                description: input.description,
                document: input.document,
            });
            const created: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
                accountId: accountId,
                policyId: createdId,
            });
            if (!created) throw new Error("Failed to fetch created agent policy");

            return json(toPublicAgentPolicyResponse(created), 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
            accountId: accountId,
            policyId: policyId,
        });

        return record ? json(toPublicAgentPolicyResponse(record)) : json({ error: "Policy not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
            accountId: accountId,
            policyId: policyId,
        });
        if (!existing) return json({ error: "Policy not found" }, 404);
        const patch = normalizeUpdateAgentPolicyInput(await req.json());
        await ctx.runMutation(internal.agentPolicies.updateInternal, {
            accountId: accountId,
            policyId: policyId,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.document !== undefined ? { document: patch.document } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
        });
        const updated: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
            accountId: accountId,
            policyId: policyId,
        });

        return updated ? json(toPublicAgentPolicyResponse(updated)) : json({ error: "Policy not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
            accountId: accountId,
            policyId: policyId,
        });
        if (!existing) return json({ error: "Policy not found" }, 404);
        await ctx.runMutation(internal.agentPolicies.removeInternal, { accountId: accountId, policyId: policyId });

        return json({ deleted: true });
    }

    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Skills CRUD: list/create on the collection, get/replace/delete by name.
 * Mirrors core's former handleSkillRoute contract.
 */
async function handleSkillRoute(ctx: ActionCtx, req: Request, accountId: Id<"accounts">, name?: string): Promise<Response> {
    if (!name) {
        if (req.method === "GET") {
            const skills = await ctx.runAction(internal.awsSkills.list, { accountId: accountId });

            return json({ skills: skills });
        }
        if (req.method === "POST") {
            const skill = await ctx.runAction(internal.awsSkills.createSkill, {
                accountId: accountId,
                input: await req.json(),
            });

            return json(skill, 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const skill = await ctx.runAction(internal.awsSkills.get, { accountId: accountId, skillName: name });

        return skill ? json(skill) : json({ error: "Skill not found" }, 404);
    }
    if (req.method === "PUT") {
        const skill = await ctx.runAction(internal.awsSkills.createSkill, {
            accountId: accountId,
            input: await req.json(),
            expectedName: name,
        });

        return json(skill);
    }
    if (req.method === "DELETE") {
        const deleted = await ctx.runAction(internal.awsSkills.remove, { accountId: accountId, skillName: name });

        return deleted ? json({ deleted: true }) : json({ error: "Skill not found" }, 404);
    }

    return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

/**
 * Tools CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountTools table.
 * Mirrors core's former handleToolRoute contract.
 */
async function handleToolRoute(ctx: ActionCtx, req: Request, accountId: Id<"accounts">, toolId?: string): Promise<Response> {
    if (!toolId) {
        if (req.method === "GET") {
            const records = await ctx.runQuery(internal.accountTools.list, { accountId: accountId });

            return json({ tools: records.map((record) => toPublicAccountTool(record)) });
        }
        if (req.method === "POST") {
            const upload = await normalizeAccountToolUpload(await req.json(), { requireBundle: true });
            const bundleStorageKey = await ctx.runAction(internal.awsBundles.putToolBundle, {
                accountId: accountId,
                sha256: upload.sha256,
                bundle: upload.bundle,
            });
            const createdId = await ctx.runMutation(internal.accountTools.create, {
                accountId: accountId,
                name: upload.name,
                description: upload.description,
                inputSchema: upload.inputSchema,
                bundleStorageKey: bundleStorageKey,
                sha256: upload.sha256,
                ...(upload.defaultConfig !== undefined ? { defaultConfig: upload.defaultConfig } : {}),
            });
            const created = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: createdId });

            return json(toPublicAccountTool(created!), 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });

        return record && record.status === "active"
            ? json(toPublicAccountTool(record))
            : json({ error: "Tool not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });
        if (!existing || existing.status !== "active") return json({ error: "Tool not found" }, 404);
        const upload = await normalizeAccountToolUpload(await req.json(), { requireBundle: false });
        const bundleStorageKey = upload.bundle !== undefined && upload.sha256 !== undefined
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
            ...(upload.description !== undefined ? { description: upload.description } : {}),
            ...(upload.inputSchema !== undefined ? { inputSchema: upload.inputSchema } : {}),
            ...(bundleStorageKey !== undefined ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 } : {}),
            ...(upload.defaultConfig !== undefined ? { defaultConfig: upload.defaultConfig } : {}),
        });
        const updated = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });

        return updated ? json(toPublicAccountTool(updated)) : json({ error: "Tool not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });
        if (!existing || existing.status !== "active") return json({ error: "Tool not found" }, 404);
        await ctx.runMutation(internal.accountTools.remove, { accountId: accountId, toolId: toolId });

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
            return json({ url: await ctx.runAction(internal.awsWorkspaceFiles.downloadUrl, { ...target, path: path }) });
        }

        return json({ files: await ctx.runAction(internal.awsWorkspaceFiles.list, target) });
    }
    if (req.method === "POST") {
        const body = await req.json() as { path?: unknown; contentBase64?: unknown; contentType?: unknown };
        if (typeof body.path !== "string" || typeof body.contentBase64 !== "string") {
            return json({ error: "path and contentBase64 are required" }, 400);
        }
        const file = await ctx.runAction(internal.awsWorkspaceFiles.upload, {
            ...target,
            path: body.path,
            contentBase64: body.contentBase64,
            ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
        });

        return json({ file: file }, 201);
    }
    if (req.method === "PATCH") {
        const body = await req.json() as { path?: unknown; newPath?: unknown };
        if (typeof body.path !== "string" || typeof body.newPath !== "string") {
            return json({ error: "path and newPath are required" }, 400);
        }
        const renamed = await ctx.runAction(internal.awsWorkspaceFiles.renamePath, {
            ...target,
            path: body.path,
            newPath: body.newPath,
        });

        return json({ renamed: renamed });
    }
    if (req.method === "DELETE") {
        const body = await req.json() as { path?: unknown };
        if (typeof body.path !== "string") return json({ error: "path is required" }, 400);
        const deleted = await ctx.runAction(internal.awsWorkspaceFiles.removePath, { ...target, path: body.path });

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
    cronId: string | undefined,
    runs: boolean,
): Promise<Response> {
    if (runs && cronId) {
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const limit = parseCronRunsLimit(new URL(req.url).searchParams.get("limit"));
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
            const records = await ctx.runQuery(internal.cron.list, { accountId: accountId });

            return json({ crons: records.map((record) => toCronResponse(record)) });
        }
        if (req.method === "POST") {
            const cron = await ctx.runAction(internal.awsCrons.create, {
                accountId: accountId,
                input: await req.json(),
            });

            return json(cron, 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record = await ctx
            .runQuery(internal.cron.getById, { accountId: accountId, cronId: cronId as Id<"crons"> })
            .catch(() => null);

        return record ? json(toCronResponse(record)) : json({ error: "Cron job not found" }, 404);
    }
    if (req.method === "PATCH") {
        const cron = await ctx.runAction(internal.awsCrons.update, {
            accountId: accountId,
            cronId: cronId,
            patch: await req.json(),
        });

        return cron ? json(cron) : json({ error: "Cron job not found" }, 404);
    }
    if (req.method === "DELETE") {
        const deleted = await ctx.runAction(internal.awsCrons.remove, { accountId: accountId, cronId: cronId });

        return deleted ? json({ deleted: true }) : json({ error: "Cron job not found" }, 404);
    }

    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Map an accountTools document to the public tool shape core used to return.
 * @param record the accountTools document
 * @returns the public record with toolId and ISO timestamps
 */
function toPublicAccountTool(record: Doc<"accountTools">): Record<string, unknown> {
    return {
        accountId: record.accountId,
        toolId: record._id,
        name: record.name,
        description: record.description,
        inputSchema: record.inputSchema,
        sha256: record.sha256,
        ...(record.defaultConfig !== undefined ? { defaultConfig: record.defaultConfig } : {}),
        status: record.status,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        ...(record.deletedAt ? { deletedAt: new Date(record.deletedAt).toISOString() } : {}),
    };
}

async function validateAgentReferences(ctx: ActionCtx, accountId: Id<"accounts">, config: AgentConfig): Promise<void> {
    await validateAgentSkillPaths(ctx, accountId, config);
    await validateAgentSubagentIds(ctx, accountId, config);
    await validateAgentPolicyIds(ctx, accountId, config);
}

async function validateAgentSkillPaths(ctx: ActionCtx, accountId: Id<"accounts">, config: AgentConfig): Promise<void> {
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

async function validateAgentSubagentIds(ctx: ActionCtx, accountId: Id<"accounts">, config: AgentConfig): Promise<void> {
    for (const agentId of config.subagent?.allowed ?? []) {
        const agent: Doc<"agents"> | null = await ctx.runQuery(internal.agents.getById, {
            accountId: accountId,
            agentId: agentId,
        });
        if (!agent) throw new Error(`Subagent not found: ${agentId}`);
    }
}

async function validateAgentPolicyIds(ctx: ActionCtx, accountId: Id<"accounts">, config: AgentConfig): Promise<void> {
    for (const policyId of config.policy?.policyIds ?? []) {
        const policy: Doc<"agentPolicies"> | null = await ctx.runQuery(internal.agentPolicies.getById, {
            accountId: accountId,
            policyId: policyId,
        });
        if (!policy) throw new Error(`Agent policy not found: ${policyId}`);
    }
}

async function decryptAgentConfig(doc: Doc<"agents">): Promise<AgentConfig> {
    if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
        return {};
    }
    const decrypted = await decryptAgentConfigBlob({
        ciphertext: doc.encryptedConfig,
        iv: doc.encryptionIv,
        tag: doc.encryptionTag,
    }, configEncryptionSecret());
    if (!decrypted) throw new Error("Failed to decrypt agent config");

    return decrypted as AgentConfig;
}

async function encryptAgentConfig(config: AgentConfig): Promise<{ ciphertext: string; iv: string; tag: string }> {
    return await encryptAgentConfigBlob(config, configEncryptionSecret());
}

async function decryptSandboxConfig(doc: Doc<"sandboxConfigs">): Promise<SandboxConfig> {
    if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
        return { provider: "lambda", permissionMode: "ask" };
    }
    const decrypted = await decryptAgentConfigBlob({
        ciphertext: doc.encryptedConfig,
        iv: doc.encryptionIv,
        tag: doc.encryptionTag,
    }, configEncryptionSecret());

    return decrypted ? decrypted as unknown as SandboxConfig : { provider: "lambda", permissionMode: "ask" };
}

async function encryptSandboxConfig(config: SandboxConfig): Promise<{ ciphertext: string; iv: string; tag: string }> {
    return await encryptAgentConfigBlob(config as unknown as Record<string, unknown>, configEncryptionSecret());
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

    const instances: Doc<"sandboxInstances">[] = await ctx.runQuery(internal.sandboxInstances.listForAccount, {
        accountId: accountId,
    });
    const baseUrl = url.replace(/\/+$/, "");
    await Promise.all(instances
        .filter((instance) =>
            instance.sandboxConfigId !== undefined &&
            (instance.status === "running" || instance.status === "suspended") &&
            matches(instance)
        )
        .map(async (instance) => {
            await fetch(`${baseUrl}/v1/sandboxes/${encodeURIComponent(instance.sandboxConfigId as string)}/terminate`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${secret}`,
                    "X-Account-Id": accountId,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ reservationKey: instance.reservationKey }),
            }).catch(() => undefined);
        }));
}

function methodNotAllowed(allowedMethods: string[]): Response {
    return json({ error: "Method not allowed", allowedMethods: allowedMethods }, 405);
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
    ].some((prefix) => error.message.startsWith(prefix));
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" },
    });
}

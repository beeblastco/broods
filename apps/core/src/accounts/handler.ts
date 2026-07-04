/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import { context as otelContextApi } from "@opentelemetry/api";
import { resolveBearerAuth, type AuthContext } from "../shared/auth.ts";
import {
    AgentSkillAuthorizationError,
    AgentSkillNotFoundError,
    AgentPolicyNotFoundError,
    AgentSubagentNotFoundError,
    applyCronPatch,
    getStorage,
    normalizeCreateAccountInput,
    normalizeUpdateAccountInput,
    toPublicAccount,
    toPublicAgent,
    toPublicSandboxConfig,
    toPublicWorkspaceConfig,
    type AccountRecord,
    type AgentRecord,
    type CronRecord,
    type CronRunRecord,
} from "../shared/storage/index.ts";
import {
    errorResponse,
    jsonResponse,
    normalizePath,
    parseJsonBody,
    type CoreRequest,
} from "../shared/http.ts";
import { createSandboxExecutor } from "../harness/sandbox/index.ts";
import { workdirConnection, workdirPtyUrl } from "../harness/sandbox/workdir-executor.ts";
import { MICROVM_SHELL_AUTH_HEADER, microvmShellConnection } from "../harness/sandbox/microvm-executor.ts";
import { getSandboxExternalId } from "../harness/sandbox/instance-store.ts";
import { sealTerminalTicket, TERMINAL_TICKET_TTL_MS, TERMINAL_WEBSOCKET_PATH } from "../shared/terminal-ticket.ts";
import { requireEnv } from "../shared/env.ts";
import { removeSandboxInstance, setSandboxInstanceStatus } from "../shared/storage/convex/sandbox-instances.ts";
import { recordSandboxAuditEvent, type SandboxAuditActor } from "../shared/storage/convex/sandbox-audit-events.ts";
import { upsertSandboxSnapshot } from "../shared/storage/convex/sandbox-snapshots.ts";
import { workspaceSandboxLimits } from "../shared/sandbox.ts";
import {
    deleteAccountRuntimeData,
    deleteWorkspaceFilesystem,
} from "./cleanup.ts";
import {
    releaseReservedSandboxes,
    releaseSandboxConfigInstances,
} from "../shared/sandbox-cleanup.ts";
import { workspaceNamespace, workspaceNamespaceOwnsReservationKey } from "../shared/workspaces.ts";
import { isPlainObject } from "../shared/object.ts";
import { deleteAccountSkills } from "./skills.ts";
import { enforceAccountSignupRateLimit, RateLimitExceededError } from "./rate-limit.ts";
import {
    assertCronsAvailable,
    createCronSchedule,
    CronsUnavailableError,
    deleteCronSchedule,
    schedulerGroupName,
    updateCronSchedule,
} from "./cron.ts";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import {
    forceFlushOtel,
    getObservabilityContext,
    mintTraceId,
    setObservabilityContext,
    runWithObservabilityScope,
} from "../shared/otel.ts";
export async function handler(request: CoreRequest): Promise<Response> {
    // Request-private observability scope so concurrent tenants in the shared
    // container process cannot clobber each other's log redaction/routing.
    return runWithObservabilityScope(() => handleAccountRequest(request));
}

async function handleAccountRequest(request: CoreRequest): Promise<Response> {
    const method = request.method;
    const rawPath = normalizePath(request.path);
    const headers = request.headers;

    try {
        logInfo("Account manage request received", {
            method,
            rawPath,
        });

        if (method === "GET" && rawPath === "/") {
            return jsonResponse(200, { status: "ok" });
        }

        if (method === "POST" && rawPath === "/accounts") {
            await enforceAccountSignupRateLimit(request);
            const body = parseJsonBody(request);
            const created = await getStorage().accounts.create(normalizeCreateAccountInput(body));
            return jsonResponse(201, {
                account: toCreateAccountResponse(created.account),
                secret: created.secret,
            });
        }

        const auth = await resolveBearerAuth(headers);
        if (!auth) {
            logWarn("Account manage request unauthorized", {
                method,
                rawPath,
            });
            return errorResponse(401, "Unauthorized");
        }

        if (method === "POST" && rawPath === "/v1/internal/observability-log") {
            if (auth.kind !== "account" || auth.viaServiceToken !== true) {
                return errorResponse(403, "Forbidden");
            }

            return await handleInternalObservabilityLog(auth.account.accountId, request);
        }

        if (method === "GET" && rawPath === "/v1/account") {
            const account = requireAccountAuth(auth);
            return jsonResponse(200, { account: toPublicAccount(account) });
        }

        if (method === "PATCH" && rawPath === "/v1/account") {
            const account = requireAccountAuth(auth);
            return updateAccountResponse(account.accountId, parseAccountPatch(request));
        }

        if (method === "POST" && rawPath === "/v1/account/rotate-secret") {
            const account = requireAccountAuth(auth);
            return rotateSecretResponse(account.accountId);
        }

        if (method === "DELETE" && rawPath === "/v1/account") {
            const account = requireAccountAuth(auth);
            return deleteAccountResponse(account);
        }

        const selfAgentCollection = rawPath === "/v1/agents";
        const selfAgentMatch = rawPath.match(/^\/v1\/agents\/([^/]+)$/);
        if (selfAgentCollection || selfAgentMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await withAgentObservability(
                account.accountId,
                selfAgentMatch?.[1] ? decodeURIComponent(selfAgentMatch[1]) : undefined,
                () => handleAgentRoute(method, account.accountId, selfAgentMatch?.[1], request),
            );
        }

        // Skills, tools, and workspace-file CRUD moved to the Convex config
        // plane (configHttp.ts, epic #85 phase 9); the gateway routes those
        // paths there. Runtime reads stay in src/shared/skills.ts, uploaded
        // tool bundle loading, and workspace mount/S3 read helpers.
        const selfCronCollection = rawPath === "/v1/crons";
        const selfCronRunsMatch = rawPath.match(/^\/v1\/crons\/([^/]+)\/runs$/);
        const selfCronMatch = rawPath.match(/^\/v1\/crons\/([^/]+)$/);
        if (selfCronCollection || selfCronMatch?.[1] || selfCronRunsMatch?.[1]) {
            const account = requireAccountAuth(auth, { allowServiceToken: true, allowDeployment: true });
            return await handleCronRoute(method, account.accountId, selfCronMatch?.[1] ?? selfCronRunsMatch?.[1], request, {
                runs: Boolean(selfCronRunsMatch?.[1]),
            });
        }

        const selfPolicyCollection = rawPath === "/v1/policies";
        const selfPolicyMatch = rawPath.match(/^\/v1\/policies\/([^/]+)$/);
        if (selfPolicyCollection || selfPolicyMatch?.[1]) {
            const account = requireAccountAuth(auth, { allowServiceToken: true });
            return await handlePolicyRoute(method, account.accountId, selfPolicyMatch?.[1], request);
        }

        const selfSandboxLifecycleMatch = rawPath.match(/^\/v1\/sandboxes\/([^/]+)\/(suspend|resume|terminate|snapshot|refresh|exec|terminal)$/);
        if (selfSandboxLifecycleMatch?.[1] && selfSandboxLifecycleMatch[2]) {
            // Driven by the dashboard via the sandboxPublic Convex actions, which
            // authenticate with the shared service token.
            const account = requireAccountAuth(auth, { allowServiceToken: true });
            return await handleSandboxLifecycle(
                method,
                account.accountId,
                selfSandboxLifecycleMatch[1],
                selfSandboxLifecycleMatch[2] as SandboxLifecycleAction,
                request,
            );
        }

        const selfSandboxCollection = rawPath === "/v1/sandboxes";
        const selfSandboxMatch = rawPath.match(/^\/v1\/sandboxes\/([^/]+)$/);
        if (selfSandboxCollection || selfSandboxMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleSandboxRoute(method, account.accountId, selfSandboxMatch?.[1], request);
        }

        const selfWorkspaceCollection = rawPath === "/v1/workspaces";
        const selfWorkspaceMatch = rawPath.match(/^\/v1\/workspaces\/([^/]+)$/);
        if (selfWorkspaceCollection || selfWorkspaceMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleWorkspaceRoute(method, account.accountId, selfWorkspaceMatch?.[1], request);
        }

        if (auth.kind !== "admin") {
            return errorResponse(403, "Forbidden");
        }

        if (method === "GET" && rawPath === "/accounts") {
            const accounts = await getStorage().accounts.list();
            return jsonResponse(200, { accounts: accounts.map(toPublicAccount) });
        }

        const accountMatch = rawPath.match(/^\/accounts\/([^/]+)$/);
        if (accountMatch?.[1]) {
            const accountId = decodeURIComponent(accountMatch[1]);
            if (method === "GET") {
                const account = await getStorage().accounts.getById(accountId);
                return account
                    ? jsonResponse(200, { account: toPublicAccount(account) })
                    : errorResponse(404, "Account not found");
            }

            if (method === "PATCH") {
                return updateAccountResponse(accountId, parseAccountPatch(request));
            }

            if (method === "DELETE") {
                const account = await getStorage().accounts.getById(accountId);
                if (!account) {
                    return errorResponse(404, "Account not found");
                }
                return deleteAccountResponse(account);
            }
        }

        const rotateMatch = rawPath.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
        if (method === "POST" && rotateMatch?.[1]) {
            return rotateSecretResponse(decodeURIComponent(rotateMatch[1]));
        }

        const adminAgentMatch = rawPath.match(/^\/accounts\/([^/]+)\/agents(?:\/([^/]+))?$/);
        if (adminAgentMatch?.[1]) {
            const accountId = decodeURIComponent(adminAgentMatch[1]);
            return await withAgentObservability(
                accountId,
                adminAgentMatch[2] ? decodeURIComponent(adminAgentMatch[2]) : undefined,
                () => handleAgentRoute(method, accountId, adminAgentMatch[2], request),
            );
        }

        const adminCronMatch = rawPath.match(/^\/accounts\/([^/]+)\/crons(?:\/([^/]+))?$/);
        if (adminCronMatch?.[1]) {
            return await handleCronRoute(method, decodeURIComponent(adminCronMatch[1]), adminCronMatch[2], request);
        }

        const adminPolicyMatch = rawPath.match(/^\/accounts\/([^/]+)\/policies(?:\/([^/]+))?$/);
        if (adminPolicyMatch?.[1]) {
            return await handlePolicyRoute(method, decodeURIComponent(adminPolicyMatch[1]), adminPolicyMatch[2], request);
        }

        const adminSandboxMatch = rawPath.match(/^\/accounts\/([^/]+)\/sandboxes(?:\/([^/]+))?$/);
        if (adminSandboxMatch?.[1]) {
            return await handleSandboxRoute(method, decodeURIComponent(adminSandboxMatch[1]), adminSandboxMatch[2], request);
        }

        const adminWorkspaceMatch = rawPath.match(/^\/accounts\/([^/]+)\/workspaces(?:\/([^/]+))?$/);
        if (adminWorkspaceMatch?.[1]) {
            return await handleWorkspaceRoute(method, decodeURIComponent(adminWorkspaceMatch[1]), adminWorkspaceMatch[2], request);
        }

        return errorResponse(404, "Not found");
    } catch (err) {
        logError("Account manage request failed", {
            method,
            rawPath,
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : undefined,
            stack: err instanceof Error ? err.stack : undefined,
        });
        if (err instanceof RateLimitExceededError) {
            return errorResponse(429, "Rate limit exceeded", {}, {
                "Retry-After": String(err.retryAfterSeconds),
            });
        }
        return errorResponseForError(err);
    }
}

async function withAgentObservability<T>(
    accountId: string,
    agentId: string | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    if (!agentId) return operation();
    const deployment = await getStorage().agentDeployments.getByAgentId?.(accountId, agentId);
    if (!deployment) return operation();

    return withObservabilityScope({
        accountId: accountId,
        project: deployment.projectSlug,
        environment: deployment.environmentSlug,
        endpointId: deployment.endpointId,
        agentId: agentId,
        conversationKey: `service:account-manage:${agentId}`,
    }, operation);
}

async function withObservabilityScope<T>(
    scope: {
        accountId: string;
        project: string;
        environment: string;
        endpointId: string;
        agentId: string;
        conversationKey: string;
    },
    operation: () => Promise<T>,
): Promise<T> {
    const previous = getObservabilityContext();
    setObservabilityContext({
        ...scope,
        traceId: mintTraceId(),
        otelContext: otelContextApi.active(),
        secretValues: [],
    });

    try {
        return await operation();
    } finally {
        await forceFlushOtel();
        setObservabilityContext(previous);
    }
}

async function handleInternalObservabilityLog(
    accountId: string,
    request: CoreRequest,
): Promise<Response> {
    const body = parseJsonBody(request) as Record<string, unknown>;
    const project = requiredLogField(body, "project");
    const environment = requiredLogField(body, "environment");
    const endpointId = requiredLogField(body, "endpointId");
    const eventType = requiredLogField(body, "eventType");
    const message = requiredLogField(body, "message");
    const agentId = typeof body.agentId === "string" ? body.agentId : "service";
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {};

    return withObservabilityScope({
        accountId: accountId,
        project: project,
        environment: environment,
        endpointId: endpointId,
        agentId: agentId,
        conversationKey: `service:convex:${eventType}`,
    }, async () => {
        logInfo(message, {
            ...data,
            eventType: eventType,
            source: "convex",
        });

        return jsonResponse(202, { accepted: true });
    });
}

function requiredLogField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${field} is required`);
    }

    return value;
}

async function handleCronRoute(
    method: string,
    accountId: string,
    rawCronId: string | undefined,
    request: CoreRequest,
    options: { runs?: boolean } = {},
): Promise<Response> {
    assertCronsAvailable();
    const cronId = rawCronId ? decodeURIComponent(rawCronId) : undefined;

    const crons = getStorage().crons;
    if (options.runs) {
        if (!cronId) return errorResponse(404, "Cron job not found");
        if (method !== "GET") return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET"] });
        const limit = parsePositiveLimit(request.query.get("limit") ?? undefined);
        const records = await crons.listRuns(accountId, cronId, limit);
        return jsonResponse(200, { runs: records.map(toCronRunResponse) });
    }

    if (!cronId) {
        if (method === "GET") {
            const records = await crons.list(accountId);
            return jsonResponse(200, { crons: records.map(toCronResponse) });
        }
        if (method === "POST") {
            const body = parseJsonBody(request) as { agentId?: unknown };
            await assertCronAgentExists(accountId, body.agentId);
            const cron = await crons.create(accountId, body as never, {
                schedulerGroupName: schedulerGroupName(),
            });
            try {
                await createCronSchedule(cron);
            } catch (err) {
                await crons.remove(accountId, cron.cronId).catch(() => { });
                throw err;
            }
            return jsonResponse(201, toCronResponse(cron));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const cron = await crons.getById(accountId, cronId);
        return cron ? jsonResponse(200, toCronResponse(cron)) : errorResponse(404, "Cron job not found");
    }
    if (method === "PATCH") {
        const existing = await crons.getById(accountId, cronId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }

        const patch = parseJsonBody(request);
        if (typeof (patch as { agentId?: unknown }).agentId !== "undefined") {
            await assertCronAgentExists(accountId, (patch as { agentId?: unknown }).agentId);
        }
        const patched = applyCronPatch(existing, patch as never);
        await updateCronSchedule(patched);
        const cron = await crons.update(accountId, cronId, patch as never);
        return cron ? jsonResponse(200, toCronResponse(cron)) : errorResponse(404, "Cron job not found");
    }
    if (method === "DELETE") {
        const existing = await crons.getById(accountId, cronId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }
        await deleteCronSchedule(existing);
        const deleted = await crons.remove(accountId, cronId);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Cron job not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function handleAgentRoute(
    method: string,
    accountId: string,
    rawAgentId: string | undefined,
    request: CoreRequest,
): Promise<Response> {
    const agentId = rawAgentId ? decodeURIComponent(rawAgentId) : undefined;
    logInfo("Account agent route received", {
        method,
        accountId,
        agentId,
        hasAgentId: Boolean(agentId),
    });

    const agents = getStorage().agents;
    if (!agentId) {
        if (method === "GET") {
            const records = await agents.list(accountId);
            logInfo("Account agents listed", {
                accountId,
                count: records.length,
            });
            return jsonResponse(200, { agents: records.map(toPublicAgent) });
        }
        if (method === "POST") {
            logInfo("Account agent create started", {
                accountId,
            });
            const agent = await agents.create(accountId, parseJsonBody(request) as never);
            logInfo("Account agent create completed", {
                accountId,
                agentId: agent.agentId,
                name: agent.name,
            });
            return jsonResponse(201, toCreateAgentResponse(agent));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        logInfo("Account agent get started", {
            accountId,
            agentId,
        });
        const agent = await agents.getById(accountId, agentId);
        logInfo("Account agent get completed", {
            accountId,
            agentId,
            found: Boolean(agent),
            name: agent?.name,
            hasModelProvider: Boolean(agent?.config.model?.provider),
            toolNames: Object.keys(agent?.config.tools ?? {}),
            channelNames: Object.keys(agent?.config.channels ?? {}),
        });
        return agent ? jsonResponse(200, toPublicAgent(agent)) : errorResponse(404, "Agent not found");
    }
    if (method === "PATCH") {
        const patch = parseJsonBody(request) as Record<string, unknown>;
        const patchConfig = patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
            ? patch.config as Record<string, unknown>
            : undefined;
        logInfo("Account agent patch started", {
            accountId,
            agentId,
            patchKeys: Object.keys(patch),
            configKeys: Object.keys(patchConfig ?? {}),
            hasModelProviderPatch: Boolean((patchConfig?.model as Record<string, unknown> | undefined)?.provider),
            hasHandoffsPatch: Boolean((patchConfig?.tools as Record<string, unknown> | undefined)?.handoffs),
            channelNamesPatch: Object.keys((patchConfig?.channels as Record<string, unknown> | undefined) ?? {}),
        });
        const agent = await agents.update(accountId, agentId, patch as never);
        logInfo("Account agent patch completed", {
            accountId,
            agentId,
            found: Boolean(agent),
            name: agent?.name,
            hasModelProvider: Boolean(agent?.config.model?.provider),
            toolNames: Object.keys(agent?.config.tools ?? {}),
            channelNames: Object.keys(agent?.config.channels ?? {}),
            handoffsHasPancake: Boolean(agent?.config.tools?.handoffs?.pancake),
            handoffsHasZalo: Boolean(agent?.config.tools?.handoffs?.zalo),
        });
        return agent ? jsonResponse(200, toPublicAgent(agent)) : errorResponse(404, "Agent not found");
    }
    if (method === "DELETE") {
        logInfo("Account agent delete started", {
            accountId,
            agentId,
        });
        const deleted = await agents.remove(accountId, agentId);
        logInfo("Account agent delete completed", {
            accountId,
            agentId,
            deleted,
        });
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Agent not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function handleSandboxRoute(
    method: string,
    accountId: string,
    rawSandboxId: string | undefined,
    request: CoreRequest,
): Promise<Response> {
    const sandboxId = rawSandboxId ? decodeURIComponent(rawSandboxId) : undefined;
    const sandboxConfigs = getStorage().sandboxConfigs;

    if (!sandboxId) {
        if (method === "GET") {
            const records = await sandboxConfigs.list(accountId);
            return jsonResponse(200, { sandboxes: records.map((record) => toPublicSandboxConfig(record)) });
        }
        if (method === "POST") {
            const record = await sandboxConfigs.create(accountId, parseJsonBody(request) as never);
            return jsonResponse(201, toPublicSandboxConfig(record));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await sandboxConfigs.getById(accountId, sandboxId);
        return record ? jsonResponse(200, toPublicSandboxConfig(record)) : errorResponse(404, "Sandbox not found");
    }
    if (method === "PATCH") {
        const record = await sandboxConfigs.update(accountId, sandboxId, parseJsonBody(request) as never);
        return record ? jsonResponse(200, toPublicSandboxConfig(record)) : errorResponse(404, "Sandbox not found");
    }
    if (method === "DELETE") {
        // Capture the config before deleting: releasing reserved daytona/e2b
        // sandboxes needs its credentials, which vanish with the record.
        const record = await sandboxConfigs.getById(accountId, sandboxId);
        const deleted = await sandboxConfigs.remove(accountId, sandboxId);
        if (deleted && record) {
            await releaseSandboxConfigInstances(accountId, record.config).catch(() => {});
        }
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Sandbox not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

/**
 * Drives a reserved sandbox's suspend/resume/terminate lifecycle on behalf of the
 * dashboard. Loads the (decrypted) sandbox config so the provider credentials are
 * available, runs the provider lifecycle call, then mirrors the new status into
 * Convex so the live dashboard query reflects it.
 */
type SandboxLifecycleAction = "suspend" | "resume" | "terminate" | "snapshot" | "refresh" | "exec" | "terminal";

async function handleSandboxLifecycle(
    method: string,
    accountId: string,
    rawSandboxId: string,
    action: SandboxLifecycleAction,
    request: CoreRequest,
): Promise<Response> {
    if (method !== "POST") {
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["POST"] });
    }
    const sandboxId = decodeURIComponent(rawSandboxId);
    const record = await getStorage().sandboxConfigs.getById(accountId, sandboxId);
    if (!record) {
        return errorResponse(404, "Sandbox not found");
    }

    const body = parseJsonBody(request) as Record<string, unknown>;
    const reservationKey = typeof body.reservationKey === "string" ? body.reservationKey.trim() : "";
    if (!reservationKey) {
        return errorResponse(400, "reservationKey is required");
    }
    if (!await sandboxReservationBelongsToAccount(accountId, record.config, reservationKey)) {
        return errorResponse(403, "reservationKey does not belong to this account or sandbox config");
    }

    const executor = createSandboxExecutor(record.config);
    const ref = { reservationKey: reservationKey };
    const provider = record.config.provider;
    const actor = sandboxAuditActor(body.actor);
    const audit = async (
        result: "ok" | "error",
        details: {
            status?: "running" | "suspended" | "terminating" | "error";
            errorMessage?: string;
            exitCode?: number | null;
            durationMs?: number;
            truncated?: boolean;
        } = {},
    ) => recordSandboxAuditEvent({
        accountId,
        sandboxConfigId: sandboxId,
        reservationKey,
        provider,
        action,
        result,
        actor,
        ...details,
    });

    if (action === "exec") {
        const code = typeof body.code === "string" ? body.code : "";
        if (!code.trim()) {
            await audit("error", { errorMessage: "code is required" });
            return errorResponse(400, "code is required");
        }
        if (code.length > 20_000) {
            await audit("error", { errorMessage: "code must be 20000 characters or less" });
            return errorResponse(400, "code must be 20000 characters or less");
        }

        const limits = workspaceSandboxLimits(provider);
        const timeoutSeconds = boundedInteger(body.timeoutSeconds, record.config.timeout ?? limits.defaultTimeoutSeconds, limits.maxTimeoutSeconds);
        const outputLimitBytes = boundedInteger(body.outputLimitBytes, record.config.outputLimitBytes ?? limits.defaultOutputLimitBytes, limits.maxOutputLimitBytes);
        let result;
        try {
            result = await executor.run({
                code,
                reservationKey,
                timeoutSeconds,
                outputLimitBytes,
            });
        } catch (err) {
            await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        await setSandboxInstanceStatus(accountId, reservationKey, "running");
        await audit(result.ok ? "ok" : "error", {
            status: "running",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated === true,
        });

        return jsonResponse(200, {
            ok: result.ok,
            runtime: result.runtime,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            truncated: result.truncated === true,
            provider: result.provider,
        });
    }

    if (action === "terminal") {
        // workdir exposes an in-guest PTY WebSocket; AWS MicroVMs expose the native
        // shell endpoint (SHELL_INGRESS). Other providers keep the bounded `exec`
        // terminal.
        if (provider !== "sandbox" && provider !== "lambda") {
            await audit("error", { errorMessage: `provider ${provider} does not support a live terminal` });
            return errorResponse(409, `provider ${provider} does not support a live terminal`);
        }
        const externalId = await getSandboxExternalId(provider, reservationKey);
        if (!externalId) {
            await audit("error", { errorMessage: "No reserved sandbox instance for this reservation key" });
            return errorResponse(404, "No reserved sandbox instance for this reservation key");
        }
        // The PTY endpoint requires a running guest, so opening a terminal
        // resumes a suspended instance the same way an exec would.
        if (executor.getInstanceInfo && executor.resume) {
            const info = await executor.getInstanceInfo(ref);
            if (info?.state === "suspended") {
                try {
                    await executor.resume(ref);
                } catch (err) {
                    await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
                    throw err;
                }
                await setSandboxInstanceStatus(accountId, reservationKey, "running");
            }
        }
        let target: { url: string; authorization: string; authorizationHeader?: string };
        if (provider === "lambda") {
            try {
                const shell = await microvmShellConnection(externalId);
                target = { ...shell, authorizationHeader: MICROVM_SHELL_AUTH_HEADER };
            } catch (error) {
                // Most likely a VM launched before SHELL_INGRESS was attached at
                // RunMicrovm; connectors cannot be added to a live VM.
                const message = error instanceof Error ? error.message : String(error);
                await audit("error", { errorMessage: message });
                return errorResponse(409, `MicroVM shell access unavailable (${message}); terminate and re-reserve the instance to enable the live terminal`);
            }
        } else {
            const { baseUrl, apiKey } = workdirConnection(record.config);
            target = { url: workdirPtyUrl(baseUrl, externalId), authorization: `Bearer ${apiKey}` };
        }
        const expiresAt = Date.now() + TERMINAL_TICKET_TTL_MS;
        const token = sealTerminalTicket({ ...target, accountId, expiresAt }, requireEnv("SERVICE_AUTH_SECRET"));
        await audit("ok", { status: "running" });

        return jsonResponse(200, { token, expiresAt, websocketPath: TERMINAL_WEBSOCKET_PATH });
    }

    if (action === "refresh") {
        if (!executor.getInstanceInfo) {
            await audit("error", { errorMessage: `provider ${provider} does not support instance status refresh` });
            return errorResponse(409, `provider ${provider} does not support instance status refresh`);
        }
        let info;
        try {
            info = await executor.getInstanceInfo(ref);
        } catch (err) {
            await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        if (!info || info.state === "terminating") {
            await removeSandboxInstance(accountId, reservationKey);
            await audit("ok", { status: "terminating" });
            return jsonResponse(200, { status: "terminated" });
        }
        const status = info.state === "unknown" ? "error" : info.state;
        await setSandboxInstanceStatus(accountId, reservationKey, status);
        await audit(status === "error" ? "error" : "ok", { status });
        return jsonResponse(200, { status, externalId: info.externalId });
    }

    if (action === "suspend") {
        if (!executor.suspend) {
            await audit("error", { errorMessage: `provider ${provider} does not support suspend` });
            return errorResponse(409, `provider ${provider} does not support suspend`);
        }
        try {
            await executor.suspend(ref);
        } catch (err) {
            await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        await setSandboxInstanceStatus(accountId, reservationKey, "suspended");
        await audit("ok", { status: "suspended" });
        return jsonResponse(200, { status: "suspended" });
    }
    if (action === "resume") {
        if (!executor.resume) {
            await audit("error", { errorMessage: `provider ${provider} does not support resume` });
            return errorResponse(409, `provider ${provider} does not support resume`);
        }
        try {
            await executor.resume(ref);
        } catch (err) {
            await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        await setSandboxInstanceStatus(accountId, reservationKey, "running");
        await audit("ok", { status: "running" });
        return jsonResponse(200, { status: "running" });
    }
    if (action === "snapshot") {
        if (!executor.snapshot) {
            await audit("error", { errorMessage: `provider ${provider} does not support snapshot` });
            return errorResponse(409, `provider ${provider} does not support snapshot`);
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
            await audit("error", { errorMessage: "name is required" });
            return errorResponse(400, "name is required");
        }
        let result;
        try {
            result = await executor.snapshot(ref);
        } catch (err) {
            await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        const externalImageId = result.externalImageId ?? result.snapshotId;
        await upsertSandboxSnapshot({
            accountId,
            name,
            provider,
            baseImage: provider,
            externalImageId,
            status: "active",
        });
        await audit("ok", { status: "running" });
        return jsonResponse(200, { status: "active", snapshotId: result.snapshotId, externalImageId });
    }
    if (!executor.release) {
        await audit("error", { errorMessage: `provider ${provider} does not support terminate` });
        return errorResponse(409, `provider ${provider} does not support terminate`);
    }
    try {
        await executor.release(ref);
    } catch (err) {
        await audit("error", { errorMessage: err instanceof Error ? err.message : String(err) });
        throw err;
    }
    await removeSandboxInstance(accountId, reservationKey);
    await audit("ok", { status: "terminating" });

    return jsonResponse(200, { status: "terminated" });
}

function boundedInteger(value: unknown, defaultValue: number, max: number): number {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
        return defaultValue;
    }

    return parsed;
}

function sandboxAuditActor(value: unknown): SandboxAuditActor {
    if (!isPlainObject(value)) {
        return { source: "unknown" };
    }
    const source = value.source === "dashboard" || value.source === "agent" || value.source === "service"
        ? value.source
        : "unknown";

    return {
        source,
        ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
        ...(typeof value.email === "string" && value.email.trim() ? { email: value.email.trim() } : {}),
        ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    };
}

/**
 * Authorizes dashboard lifecycle controls against reservations this account can
 * create: workspace namespaces owned by the account, or the config's explicit
 * stateless reservation key. Prevents arbitrary provider lifecycle calls.
 */
async function sandboxReservationBelongsToAccount(
    accountId: string,
    config: { persistent?: boolean; options?: Record<string, unknown> },
    reservationKey: string,
): Promise<boolean> {
    if (config.persistent !== true) return false;
    const options = isPlainObject(config.options) ? config.options : {};
    if (typeof options.reservationKey === "string" && options.reservationKey.trim() === reservationKey) {
        return true;
    }

    const workspaces = await getStorage().workspaceConfigs.list(accountId);
    return workspaces.some((workspace) =>
        workspaceNamespaceOwnsReservationKey(workspaceNamespace(accountId, workspace.workspaceId), reservationKey)
    );
}

async function handlePolicyRoute(
    method: string,
    accountId: string,
    rawPolicyId: string | undefined,
    request: CoreRequest,
): Promise<Response> {
    const policyId = rawPolicyId ? decodeURIComponent(rawPolicyId) : undefined;
    const policies = getStorage().agentPolicies;

    if (!policyId) {
        if (method === "GET") {
            const records = await policies.list(accountId);
            return jsonResponse(200, { policies: records });
        }
        if (method === "POST") {
            const record = await policies.create(accountId, parseJsonBody(request) as never);
            return jsonResponse(201, record);
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await policies.getById(accountId, policyId);
        return record ? jsonResponse(200, record) : errorResponse(404, "Policy not found");
    }
    if (method === "PATCH") {
        const record = await policies.update(accountId, policyId, parseJsonBody(request) as never);
        return record ? jsonResponse(200, record) : errorResponse(404, "Policy not found");
    }
    if (method === "DELETE") {
        const deleted = await policies.remove(accountId, policyId);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Policy not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function handleWorkspaceRoute(
    method: string,
    accountId: string,
    rawWorkspaceId: string | undefined,
    request: CoreRequest,
): Promise<Response> {
    const workspaceId = rawWorkspaceId ? decodeURIComponent(rawWorkspaceId) : undefined;
    const workspaceConfigs = getStorage().workspaceConfigs;

    if (!workspaceId) {
        if (method === "GET") {
            const records = await workspaceConfigs.list(accountId);
            return jsonResponse(200, { workspaces: records.map((record) => toPublicWorkspaceConfig(record)) });
        }
        if (method === "POST") {
            const record = await workspaceConfigs.create(accountId, parseJsonBody(request) as never);
            return jsonResponse(201, toPublicWorkspaceConfig(record));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await workspaceConfigs.getById(accountId, workspaceId);
        return record ? jsonResponse(200, toPublicWorkspaceConfig(record)) : errorResponse(404, "Workspace not found");
    }
    if (method === "PATCH") {
        const record = await workspaceConfigs.update(accountId, workspaceId, parseJsonBody(request) as never);
        return record ? jsonResponse(200, toPublicWorkspaceConfig(record)) : errorResponse(404, "Workspace not found");
    }
    if (method === "DELETE") {
        const record = await workspaceConfigs.getById(accountId, workspaceId);
        if (!record) {
            return errorResponse(404, "Workspace not found");
        }
        await deleteWorkspaceFilesystem(accountId, workspaceId, record.config.storage);
        const deleted = await workspaceConfigs.remove(accountId, workspaceId);
        if (deleted) {
            // Tear down any reserved sandbox bound to this workspace's namespace.
            await releaseReservedSandboxes(accountId, [workspaceNamespace(accountId, workspaceId)]).catch(() => {});
        }
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Workspace not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function updateAccountResponse(accountId: string, input: unknown): Promise<Response> {
    const account = await getStorage().accounts.update(accountId, normalizeUpdateAccountInput(input));
    return account
        ? jsonResponse(200, { account: toPublicAccount(account) })
        : errorResponse(404, "Account not found");
}

async function rotateSecretResponse(accountId: string): Promise<Response> {
    const rotated = await getStorage().accounts.rotateSecret(accountId);
    return rotated
        ? jsonResponse(200, {
            account: toPublicAccount(rotated.account),
            secret: rotated.secret,
        })
        : errorResponse(404, "Account not found");
}

async function deleteAccountResponse(account: Extract<AuthContext, { kind: "account" }>["account"]): Promise<Response> {
    const cleanup = await deleteAccountRuntimeData(account);
    const [agentsDeleted, skillObjectsDeleted, cronsDeleted, accountToolsDeleted] = await Promise.all([
        getStorage().agents.removeAllForAccount(account.accountId),
        deleteAccountSkills(account.accountId),
        deleteAccountCrons(account.accountId),
        getStorage().accountTools.removeAllForAccount(account.accountId),
    ]);
    await getStorage().accounts.remove(account.accountId);
    return jsonResponse(200, { deleted: true, cleanup: { ...cleanup, agentsDeleted, skillObjectsDeleted, cronsDeleted, accountToolsDeleted } });
}

async function assertCronAgentExists(accountId: string, agentId: unknown): Promise<void> {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw new Error("agentId is required");
    }
    const agent = await getStorage().agents.getById(accountId, agentId);
    if (!agent) {
        throw new Error("Cron job agentId must reference an existing agent");
    }
    if (agent.status !== "active") {
        throw new Error("Cron job agentId must reference an active agent");
    }
}

function requireAccountAuth(
    auth: AuthContext,
    options: { allowServiceToken?: boolean; allowDeployment?: boolean } = {},
): Extract<AuthContext, { kind: "account" }>["account"] {
    if (auth.kind === "deployment" && options.allowDeployment === true) {
        return auth.account;
    }
    if (auth.kind === "deployment") {
        throw new AccountEndpointUnauthorizedError();
    }
    if (auth.kind !== "account") {
        throw new Error("Admin must use account-specific endpoints");
    }
    if (auth.viaServiceToken && options.allowServiceToken !== true) {
        throw new Error("Service token is not allowed for this account endpoint");
    }

    return auth.account;
}

class AccountEndpointUnauthorizedError extends Error {
    constructor() {
        super("Unauthorized");
    }
}

function toCreateAccountResponse(account: AccountRecord): Record<string, unknown> {
    return {
        accountId: account.accountId,
        username: account.username,
        ...(account.description ? { description: account.description } : {}),
    };
}

function toCreateAgentResponse(agent: AgentRecord): Record<string, unknown> {
    return {
        accountId: agent.accountId,
        agentId: agent.agentId,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
    };
}

function toCronResponse(cron: CronRecord): Record<string, unknown> {
    return {
        accountId: cron.accountId,
        cronId: cron.cronId,
        name: cron.name,
        ...(cron.description ? { description: cron.description } : {}),
        agentId: cron.agentId,
        events: cron.events,
        ...(cron.conversationKey ? { conversationKey: cron.conversationKey } : {}),
        scheduleExpression: cron.scheduleExpression,
        ...(cron.timezone ? { timezone: cron.timezone } : {}),
        status: cron.status,
        createdAt: cron.createdAt,
        updatedAt: cron.updatedAt,
        ...(cron.lastInvokedAt ? { lastInvokedAt: cron.lastInvokedAt } : {}),
        ...(cron.lastStatus ? { lastStatus: cron.lastStatus } : {}),
        ...(cron.lastError ? { lastError: cron.lastError } : {}),
    };
}

function toCronRunResponse(run: CronRunRecord): Record<string, unknown> {
    return {
        accountId: run.accountId,
        cronId: run.cronId,
        runId: run.runId,
        eventId: run.eventId,
        conversationKey: run.conversationKey,
        status: run.status,
        ...(run.result !== undefined ? { result: run.result } : {}),
        ...(run.error ? { error: run.error } : {}),
        startedAt: run.startedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    };
}

function parsePositiveLimit(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error("limit must be an integer between 1 and 100");
    }
    return parsed;
}

async function deleteAccountCrons(accountId: string): Promise<number> {
    try {
        assertCronsAvailable();
    } catch (err) {
        if (err instanceof CronsUnavailableError) {
            return 0;
        }
        throw err;
    }

    const cronsStore = getStorage().crons;
    const crons = await cronsStore.list(accountId);
    await Promise.all(crons.map(async (cron) => {
        await deleteCronSchedule(cron);
        await cronsStore.remove(accountId, cron.cronId);
    }));
    return crons.length;
}

function parseAccountPatch(request: CoreRequest): unknown {
    return parseJsonBody(request);
}

function errorResponseForError(err: unknown): Response {
    if (err instanceof AccountEndpointUnauthorizedError) {
        return errorResponse(401, err.message);
    }
    if (err instanceof CronsUnavailableError) {
        return errorResponse(503, err.message);
    }
    if (err instanceof AgentSkillAuthorizationError) {
        return errorResponse(401, err.message);
    }
    if (err instanceof AgentSkillNotFoundError) {
        return errorResponse(404, err.message);
    }
    if (err instanceof AgentSubagentNotFoundError) {
        return errorResponse(404, err.message);
    }
    if (err instanceof AgentPolicyNotFoundError) {
        return errorResponse(404, err.message);
    }
    return errorResponse(400, err instanceof Error ? err.message : "Invalid request");
}

/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import { context as otelContextApi } from "@opentelemetry/api";
import { resolveBearerAuth, type AuthContext } from "../_shared/auth.ts";
import {
    AgentSkillAuthorizationError,
    AgentSkillNotFoundError,
    AgentSubagentNotFoundError,
    applyCronPatch,
    getStorage,
    normalizeCreateAccountInput,
    normalizeUpdateAccountInput,
    toPublicAccount,
    toPublicAgent,
    toPublicAccountTool,
    toPublicSandboxConfig,
    toPublicWorkspaceConfig,
    type AccountRecord,
    type AgentRecord,
    type CronRecord,
    type CronRunRecord,
} from "../_shared/storage/index.ts";
import {
    errorResponse,
    jsonResponse,
    normalizeHeaders,
    normalizePath,
    parseJsonBody,
} from "../_shared/http.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { deleteAccountRuntimeData, releaseReservedSandboxes, releaseSandboxConfigInstances } from "./cleanup.ts";
import { workspaceNamespace } from "../_shared/workspaces.ts";
import {
    createOrReplaceSkill,
    deleteAccountSkills,
    deleteSkill,
    getSkill,
    listAccountSkills,
    type SkillMetadata,
    type StoredSkill,
} from "./skills.ts";
import { enforceAccountSignupRateLimit, RateLimitExceededError } from "./rate-limit.ts";
import {
    assertCronsAvailable,
    createCronSchedule,
    CronsUnavailableError,
    deleteCronSchedule,
    schedulerGroupName,
    updateCronSchedule,
} from "./cron.ts";
import { createAccountTool, updateAccountTool } from "./account-tools.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import {
    forceFlushOtel,
    getObservabilityContext,
    mintTraceId,
    setObservabilityContext,
} from "../_shared/otel.ts";
import {
    deleteWorkspacePath,
    listWorkspaceFiles,
    renameWorkspacePath,
    uploadWorkspaceFile,
    workspaceFileDownloadUrl,
} from "./workspace-files.ts";

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaResponse> {
    const method = event.requestContext.http.method;
    const rawPath = normalizePath(event.rawPath);
    const headers = normalizeHeaders(event.headers);

    try {
        logInfo("Account manage request received", {
            method,
            rawPath,
        });

        if (method === "GET" && rawPath === "/") {
            return jsonResponse(200, { status: "ok" });
        }

        if (method === "POST" && rawPath === "/accounts") {
            await enforceAccountSignupRateLimit(event);
            const body = parseJsonBody(event);
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

            return await handleInternalObservabilityLog(auth.account.accountId, event);
        }

        if (method === "GET" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            return jsonResponse(200, { account: toPublicAccount(account) });
        }

        if (method === "PATCH" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            return updateAccountResponse(account.accountId, parseAccountPatch(event));
        }

        if (method === "POST" && rawPath === "/accounts/me/rotate-secret") {
            const account = requireAccountAuth(auth);
            return rotateSecretResponse(account.accountId);
        }

        if (method === "DELETE" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            return deleteAccountResponse(account);
        }

        const selfAgentCollection = rawPath === "/accounts/me/agents";
        const selfAgentMatch = rawPath.match(/^\/accounts\/me\/agents\/([^/]+)$/);
        if (selfAgentCollection || selfAgentMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await withAgentObservability(
                account.accountId,
                selfAgentMatch?.[1] ? decodeURIComponent(selfAgentMatch[1]) : undefined,
                () => handleAgentRoute(method, account.accountId, selfAgentMatch?.[1], event),
            );
        }

        const selfSkillCollection = rawPath === "/accounts/me/skills";
        const selfSkillMatch = rawPath.match(/^\/accounts\/me\/skills\/([^/]+)$/);
        if (selfSkillCollection || selfSkillMatch?.[1]) {
            // The Convex CLI sync (`filthy-panty dev`) pushes skill manifests with the
            // account-scoped service token. Deployment runtime keys are intentionally
            // excluded: they can run agents, not mutate account skill bundles.
            const account = requireAccountAuth(auth, { allowServiceToken: true });
            return await handleSkillRoute(method, account.accountId, selfSkillMatch?.[1], event);
        }

        const selfCronCollection = rawPath === "/accounts/me/crons";
        const selfCronRunsMatch = rawPath.match(/^\/accounts\/me\/crons\/([^/]+)\/runs$/);
        const selfCronMatch = rawPath.match(/^\/accounts\/me\/crons\/([^/]+)$/);
        if (selfCronCollection || selfCronMatch?.[1] || selfCronRunsMatch?.[1]) {
            const account = requireAccountAuth(auth, { allowServiceToken: true, allowDeployment: true });
            return await handleCronRoute(method, account.accountId, selfCronMatch?.[1] ?? selfCronRunsMatch?.[1], event, {
                runs: Boolean(selfCronRunsMatch?.[1]),
            });
        }

        const selfToolCollection = rawPath === "/accounts/me/tools";
        const selfToolMatch = rawPath.match(/^\/accounts\/me\/tools\/([^/]+)$/);
        if (selfToolCollection || selfToolMatch?.[1]) {
            // The Convex CLI sync pushes tool manifests with the account-scoped
            // service token. Deployment runtime keys are intentionally excluded:
            // they can run agents, not mutate uploaded account tools.
            const account = requireAccountAuth(auth, { allowServiceToken: true });
            return await handleToolRoute(method, account.accountId, selfToolMatch?.[1], event);
        }

        const selfSandboxCollection = rawPath === "/accounts/me/sandboxes";
        const selfSandboxMatch = rawPath.match(/^\/accounts\/me\/sandboxes\/([^/]+)$/);
        if (selfSandboxCollection || selfSandboxMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleSandboxRoute(method, account.accountId, selfSandboxMatch?.[1], event);
        }

        const selfWorkspaceFilesMatch = rawPath.match(/^\/accounts\/me\/workspaces\/([^/]+)\/files$/);
        if (selfWorkspaceFilesMatch?.[1]) {
            const account = requireAccountAuth(auth, { allowServiceToken: true });
            return await handleWorkspaceFilesRoute(
                method,
                account.accountId,
                decodeURIComponent(selfWorkspaceFilesMatch[1]),
                event,
            );
        }

        const selfWorkspaceCollection = rawPath === "/accounts/me/workspaces";
        const selfWorkspaceMatch = rawPath.match(/^\/accounts\/me\/workspaces\/([^/]+)$/);
        if (selfWorkspaceCollection || selfWorkspaceMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleWorkspaceRoute(method, account.accountId, selfWorkspaceMatch?.[1], event);
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
                return updateAccountResponse(accountId, parseAccountPatch(event));
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
                () => handleAgentRoute(method, accountId, adminAgentMatch[2], event),
            );
        }

        const adminSkillMatch = rawPath.match(/^\/accounts\/([^/]+)\/skills(?:\/([^/]+))?$/);
        if (adminSkillMatch?.[1]) {
            return await handleSkillRoute(method, decodeURIComponent(adminSkillMatch[1]), adminSkillMatch[2], event);
        }

        const adminCronMatch = rawPath.match(/^\/accounts\/([^/]+)\/crons(?:\/([^/]+))?$/);
        if (adminCronMatch?.[1]) {
            return await handleCronRoute(method, decodeURIComponent(adminCronMatch[1]), adminCronMatch[2], event);
        }

        const adminToolMatch = rawPath.match(/^\/accounts\/([^/]+)\/tools(?:\/([^/]+))?$/);
        if (adminToolMatch?.[1]) {
            return await handleToolRoute(method, decodeURIComponent(adminToolMatch[1]), adminToolMatch[2], event);
        }

        const adminSandboxMatch = rawPath.match(/^\/accounts\/([^/]+)\/sandboxes(?:\/([^/]+))?$/);
        if (adminSandboxMatch?.[1]) {
            return await handleSandboxRoute(method, decodeURIComponent(adminSandboxMatch[1]), adminSandboxMatch[2], event);
        }

        const adminWorkspaceFilesMatch = rawPath.match(/^\/accounts\/([^/]+)\/workspaces\/([^/]+)\/files$/);
        if (adminWorkspaceFilesMatch?.[1] && adminWorkspaceFilesMatch[2]) {
            return await handleWorkspaceFilesRoute(
                method,
                decodeURIComponent(adminWorkspaceFilesMatch[1]),
                decodeURIComponent(adminWorkspaceFilesMatch[2]),
                event,
            );
        }

        const adminWorkspaceMatch = rawPath.match(/^\/accounts\/([^/]+)\/workspaces(?:\/([^/]+))?$/);
        if (adminWorkspaceMatch?.[1]) {
            return await handleWorkspaceRoute(method, decodeURIComponent(adminWorkspaceMatch[1]), adminWorkspaceMatch[2], event);
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
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const body = parseJsonBody(event) as Record<string, unknown>;
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

async function handleWorkspaceFilesRoute(
    method: string,
    accountId: string,
    workspaceId: string,
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const workspace = await getStorage().workspaceConfigs.getById(accountId, workspaceId);
    if (!workspace) return errorResponse(404, "Workspace not found");

    if (method === "GET") {
        const path = event.queryStringParameters?.path;
        if (path) {
            return jsonResponse(200, { url: await workspaceFileDownloadUrl(accountId, workspaceId, path) });
        }
        return jsonResponse(200, { files: await listWorkspaceFiles(accountId, workspaceId) });
    }
    if (method === "POST") {
        const file = await uploadWorkspaceFile(accountId, workspaceId, parseJsonBody(event) as never);
        return jsonResponse(201, { file: file });
    }
    if (method === "PATCH") {
        const body = parseJsonBody(event) as { path?: unknown; newPath?: unknown };
        const renamed = await renameWorkspacePath(accountId, workspaceId, body.path, body.newPath);
        return jsonResponse(200, { renamed: renamed });
    }
    if (method === "DELETE") {
        const body = parseJsonBody(event) as { path?: unknown };
        const deleted = await deleteWorkspacePath(accountId, workspaceId, body.path);
        return jsonResponse(200, { deleted: deleted });
    }

    return errorResponse(405, "Method not allowed", { allowedMethods: ["GET", "POST", "PATCH", "DELETE"] });
}

async function handleCronRoute(
    method: string,
    accountId: string,
    rawCronId: string | undefined,
    event: LambdaFunctionURLEvent,
    options: { runs?: boolean } = {},
): Promise<LambdaResponse> {
    assertCronsAvailable();
    const cronId = rawCronId ? decodeURIComponent(rawCronId) : undefined;

    const crons = getStorage().crons;
    if (options.runs) {
        if (!cronId) return errorResponse(404, "Cron job not found");
        if (method !== "GET") return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET"] });
        const limit = parsePositiveLimit(event.queryStringParameters?.limit);
        const records = await crons.listRuns(accountId, cronId, limit);
        return jsonResponse(200, { runs: records.map(toCronRunResponse) });
    }

    if (!cronId) {
        if (method === "GET") {
            const records = await crons.list(accountId);
            return jsonResponse(200, { crons: records.map(toCronResponse) });
        }
        if (method === "POST") {
            const body = parseJsonBody(event) as { agentId?: unknown };
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

        const patch = parseJsonBody(event);
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
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
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
            const agent = await agents.create(accountId, parseJsonBody(event) as never);
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
        const patch = parseJsonBody(event) as Record<string, unknown>;
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
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const sandboxId = rawSandboxId ? decodeURIComponent(rawSandboxId) : undefined;
    const sandboxConfigs = getStorage().sandboxConfigs;

    if (!sandboxId) {
        if (method === "GET") {
            const records = await sandboxConfigs.list(accountId);
            return jsonResponse(200, { sandboxes: records.map((record) => toPublicSandboxConfig(record)) });
        }
        if (method === "POST") {
            const record = await sandboxConfigs.create(accountId, parseJsonBody(event) as never);
            return jsonResponse(201, toPublicSandboxConfig(record));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await sandboxConfigs.getById(accountId, sandboxId);
        return record ? jsonResponse(200, toPublicSandboxConfig(record)) : errorResponse(404, "Sandbox not found");
    }
    if (method === "PATCH") {
        const record = await sandboxConfigs.update(accountId, sandboxId, parseJsonBody(event) as never);
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

async function handleToolRoute(
    method: string,
    accountId: string,
    rawToolId: string | undefined,
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const toolId = rawToolId ? decodeURIComponent(rawToolId) : undefined;
    const accountTools = getStorage().accountTools;

    if (!toolId) {
        if (method === "GET") {
            const records = await accountTools.list(accountId);
            return jsonResponse(200, { tools: records.map((record) => toPublicAccountTool(record)) });
        }
        if (method === "POST") {
            const toolRecord = await createAccountTool(accountId, parseJsonBody(event));
            return jsonResponse(201, toolRecord);
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await accountTools.getById(accountId, toolId);
        return record && record.status === "active"
            ? jsonResponse(200, toPublicAccountTool(record))
            : errorResponse(404, "Tool not found");
    }
    if (method === "PATCH") {
        const record = await updateAccountTool(accountId, toolId, parseJsonBody(event));
        return record ? jsonResponse(200, record) : errorResponse(404, "Tool not found");
    }
    if (method === "DELETE") {
        const deleted = await accountTools.remove(accountId, toolId);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Tool not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function handleWorkspaceRoute(
    method: string,
    accountId: string,
    rawWorkspaceId: string | undefined,
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const workspaceId = rawWorkspaceId ? decodeURIComponent(rawWorkspaceId) : undefined;
    const workspaceConfigs = getStorage().workspaceConfigs;

    if (!workspaceId) {
        if (method === "GET") {
            const records = await workspaceConfigs.list(accountId);
            return jsonResponse(200, { workspaces: records.map((record) => toPublicWorkspaceConfig(record)) });
        }
        if (method === "POST") {
            const record = await workspaceConfigs.create(accountId, parseJsonBody(event) as never);
            return jsonResponse(201, toPublicWorkspaceConfig(record));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const record = await workspaceConfigs.getById(accountId, workspaceId);
        return record ? jsonResponse(200, toPublicWorkspaceConfig(record)) : errorResponse(404, "Workspace not found");
    }
    if (method === "PATCH") {
        const record = await workspaceConfigs.update(accountId, workspaceId, parseJsonBody(event) as never);
        return record ? jsonResponse(200, toPublicWorkspaceConfig(record)) : errorResponse(404, "Workspace not found");
    }
    if (method === "DELETE") {
        const deleted = await workspaceConfigs.remove(accountId, workspaceId);
        if (deleted) {
            // Tear down any reserved sandbox bound to this workspace's namespace.
            await releaseReservedSandboxes(accountId, [workspaceNamespace(accountId, workspaceId)]).catch(() => {});
        }
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Workspace not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PATCH", "DELETE"] });
}

async function handleSkillRoute(
    method: string,
    accountId: string,
    rawSkillName: string | undefined,
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    const skillName = rawSkillName ? decodeURIComponent(rawSkillName) : undefined;

    if (!skillName) {
        if (method === "GET") {
            const skills = await listAccountSkills(accountId);
            return jsonResponse(200, { skills: skills.map(toSkillResponse) });
        }
        if (method === "POST") {
            const skill = await createOrReplaceSkill(accountId, parseJsonBody(event));
            return jsonResponse(201, toSkillResponse(skill));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const skill = await getSkill(accountId, skillName);
        return skill ? jsonResponse(200, toSkillResponse(skill)) : errorResponse(404, "Skill not found");
    }
    if (method === "PUT") {
        const skill = await createOrReplaceSkill(accountId, parseJsonBody(event));
        if (skill.name !== skillName) {
            await deleteSkill(accountId, skill.name).catch(() => { });
            throw new Error("Skill name in SKILL.md must match the URL skillName");
        }
        return jsonResponse(200, toSkillResponse(skill));
    }
    if (method === "DELETE") {
        const deleted = await deleteSkill(accountId, skillName);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Skill not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PUT", "DELETE"] });
}

async function updateAccountResponse(accountId: string, input: unknown): Promise<LambdaResponse> {
    const account = await getStorage().accounts.update(accountId, normalizeUpdateAccountInput(input));
    return account
        ? jsonResponse(200, { account: toPublicAccount(account) })
        : errorResponse(404, "Account not found");
}

async function rotateSecretResponse(accountId: string): Promise<LambdaResponse> {
    const rotated = await getStorage().accounts.rotateSecret(accountId);
    return rotated
        ? jsonResponse(200, {
            account: toPublicAccount(rotated.account),
            secret: rotated.secret,
        })
        : errorResponse(404, "Account not found");
}

async function deleteAccountResponse(account: Extract<AuthContext, { kind: "account" }>["account"]): Promise<LambdaResponse> {
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

function toSkillResponse(skill: SkillMetadata | StoredSkill): Record<string, unknown> {
    return {
        path: skill.path,
        name: skill.name,
        description: skill.description,
        ...("files" in skill ? { files: skill.files } : {}),
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

function parseAccountPatch(event: LambdaFunctionURLEvent): unknown {
    return parseJsonBody(event);
}

function errorResponseForError(err: unknown): LambdaResponse {
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
    return errorResponse(400, err instanceof Error ? err.message : "Invalid request");
}

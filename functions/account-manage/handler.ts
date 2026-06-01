/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import { resolveBearerAuth, type AuthContext } from "../_shared/auth.ts";
import {
    AgentSkillAuthorizationError,
    AgentSkillNotFoundError,
    AgentSubagentNotFoundError,
    applyCronJobPatch,
    getStorage,
    normalizeCreateAccountInput,
    normalizeUpdateAccountInput,
    toPublicAccount,
    toPublicAgent,
    toPublicSandboxConfig,
    toPublicWorkspaceConfig,
    type AccountRecord,
    type AgentRecord,
    type CronJobRecord,
} from "../_shared/storage/index.ts";
import {
    errorResponse,
    jsonResponse,
    normalizeHeaders,
    normalizePath,
    parseJsonBody,
} from "../_shared/http.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { deleteAccountRuntimeData } from "./cleanup.ts";
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
    assertCronJobsAvailable,
    createCronSchedule,
    CronJobsUnavailableError,
    deleteCronSchedule,
    schedulerGroupName,
    updateCronSchedule,
} from "./cron.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";

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
            return await handleAgentRoute(method, account.accountId, selfAgentMatch?.[1], event);
        }

        const selfSkillCollection = rawPath === "/accounts/me/skills";
        const selfSkillMatch = rawPath.match(/^\/accounts\/me\/skills\/([^/]+)$/);
        if (selfSkillCollection || selfSkillMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleSkillRoute(method, account.accountId, selfSkillMatch?.[1], event);
        }

        const selfCronCollection = rawPath === "/accounts/me/cron-jobs";
        const selfCronMatch = rawPath.match(/^\/accounts\/me\/cron-jobs\/([^/]+)$/);
        if (selfCronCollection || selfCronMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleCronJobRoute(method, account.accountId, selfCronMatch?.[1], event);
        }

        const selfSandboxCollection = rawPath === "/accounts/me/sandboxes";
        const selfSandboxMatch = rawPath.match(/^\/accounts\/me\/sandboxes\/([^/]+)$/);
        if (selfSandboxCollection || selfSandboxMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleSandboxRoute(method, account.accountId, selfSandboxMatch?.[1], event);
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
            return await handleAgentRoute(method, decodeURIComponent(adminAgentMatch[1]), adminAgentMatch[2], event);
        }

        const adminSkillMatch = rawPath.match(/^\/accounts\/([^/]+)\/skills(?:\/([^/]+))?$/);
        if (adminSkillMatch?.[1]) {
            return await handleSkillRoute(method, decodeURIComponent(adminSkillMatch[1]), adminSkillMatch[2], event);
        }

        const adminCronMatch = rawPath.match(/^\/accounts\/([^/]+)\/cron-jobs(?:\/([^/]+))?$/);
        if (adminCronMatch?.[1]) {
            return await handleCronJobRoute(method, decodeURIComponent(adminCronMatch[1]), adminCronMatch[2], event);
        }

        const adminSandboxMatch = rawPath.match(/^\/accounts\/([^/]+)\/sandboxes(?:\/([^/]+))?$/);
        if (adminSandboxMatch?.[1]) {
            return await handleSandboxRoute(method, decodeURIComponent(adminSandboxMatch[1]), adminSandboxMatch[2], event);
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

async function handleCronJobRoute(
    method: string,
    accountId: string,
    rawCronJobId: string | undefined,
    event: LambdaFunctionURLEvent,
): Promise<LambdaResponse> {
    assertCronJobsAvailable();
    const cronJobId = rawCronJobId ? decodeURIComponent(rawCronJobId) : undefined;

    const cronJobs = getStorage().cronJobs;
    if (!cronJobId) {
        if (method === "GET") {
            const records = await cronJobs.list(accountId);
            return jsonResponse(200, { cronJobs: records.map(toCronJobResponse) });
        }
        if (method === "POST") {
            const cronJob = await cronJobs.create(accountId, parseJsonBody(event) as never, {
                schedulerGroupName: schedulerGroupName(),
            });
            try {
                await createCronSchedule(cronJob);
            } catch (err) {
                await cronJobs.remove(accountId, cronJob.cronJobId).catch(() => { });
                throw err;
            }
            return jsonResponse(201, toCronJobResponse(cronJob));
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const cronJob = await cronJobs.getById(accountId, cronJobId);
        return cronJob ? jsonResponse(200, toCronJobResponse(cronJob)) : errorResponse(404, "Cron job not found");
    }
    if (method === "PATCH") {
        const existing = await cronJobs.getById(accountId, cronJobId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }

        const patch = parseJsonBody(event);
        const patched = applyCronJobPatch(existing, patch as never);
        await updateCronSchedule(patched);
        const cronJob = await cronJobs.update(accountId, cronJobId, patch as never);
        return cronJob ? jsonResponse(200, toCronJobResponse(cronJob)) : errorResponse(404, "Cron job not found");
    }
    if (method === "DELETE") {
        const existing = await cronJobs.getById(accountId, cronJobId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }
        await deleteCronSchedule(existing);
        const deleted = await cronJobs.remove(accountId, cronJobId);
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
        const deleted = await sandboxConfigs.remove(accountId, sandboxId);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Sandbox not found");
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
    const [agentsDeleted, skillObjectsDeleted, cronJobsDeleted] = await Promise.all([
        getStorage().agents.removeAllForAccount(account.accountId),
        deleteAccountSkills(account.accountId),
        deleteAccountCronJobs(account.accountId),
    ]);
    await getStorage().accounts.remove(account.accountId);
    return jsonResponse(200, { deleted: true, cleanup: { ...cleanup, agentsDeleted, skillObjectsDeleted, cronJobsDeleted } });
}

function requireAccountAuth(auth: AuthContext): Extract<AuthContext, { kind: "account" }>["account"] {
    if (auth.kind !== "account") {
        throw new Error("Admin must use account-specific endpoints");
    }

    return auth.account;
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

function toCronJobResponse(cronJob: CronJobRecord): Record<string, unknown> {
    return {
        accountId: cronJob.accountId,
        cronJobId: cronJob.cronJobId,
        name: cronJob.name,
        ...(cronJob.description ? { description: cronJob.description } : {}),
        agentId: cronJob.agentId,
        prompt: cronJob.prompt,
        ...(cronJob.conversationKey ? { conversationKey: cronJob.conversationKey } : {}),
        scheduleExpression: cronJob.scheduleExpression,
        ...(cronJob.timezone ? { timezone: cronJob.timezone } : {}),
        status: cronJob.status,
        createdAt: cronJob.createdAt,
        updatedAt: cronJob.updatedAt,
        ...(cronJob.lastInvokedAt ? { lastInvokedAt: cronJob.lastInvokedAt } : {}),
        ...(cronJob.lastStatus ? { lastStatus: cronJob.lastStatus } : {}),
        ...(cronJob.lastError ? { lastError: cronJob.lastError } : {}),
    };
}

async function deleteAccountCronJobs(accountId: string): Promise<number> {
    try {
        assertCronJobsAvailable();
    } catch (err) {
        if (err instanceof CronJobsUnavailableError) {
            return 0;
        }
        throw err;
    }

    const cronJobsStore = getStorage().cronJobs;
    const cronJobs = await cronJobsStore.list(accountId);
    await Promise.all(cronJobs.map(async (cronJob) => {
        await deleteCronSchedule(cronJob);
        await cronJobsStore.remove(accountId, cronJob.cronJobId);
    }));
    return cronJobs.length;
}

function parseAccountPatch(event: LambdaFunctionURLEvent): unknown {
    return parseJsonBody(event);
}

function errorResponseForError(err: unknown): LambdaResponse {
    if (err instanceof CronJobsUnavailableError) {
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

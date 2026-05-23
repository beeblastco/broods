/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import {
    createAccount,
    deleteAccount,
    getAccount,
    listAccounts,
    resolveBearerAuth,
    rotateAccountSecret,
    toPublicAccount,
    updateAccount,
    type AuthContext,
    type AccountRecord,
} from "../_shared/accounts.ts";
import {
    applyCronJobPatch,
    createCronJob,
    deleteCronJob,
    getCronJob,
    listCronJobs,
    updateCronJob,
    type CronJobRecord,
} from "../_shared/cron-jobs.ts";
import {
    AgentSkillAuthorizationError,
    AgentSkillNotFoundError,
    AgentSubagentNotFoundError,
    createAgent,
    deleteAccountAgents,
    deleteAgent,
    getAgent,
    listAgents,
    toPublicAgent,
    updateAgent,
    type AgentRecord,
} from "../_shared/agents.ts";
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

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaResponse> {
    const method = event.requestContext.http.method;
    const rawPath = normalizePath(event.rawPath);
    const headers = normalizeHeaders(event.headers);

    try {
        if (method === "GET" && rawPath === "/") {
            return jsonResponse(200, { status: "ok" });
        }

        if (method === "POST" && rawPath === "/accounts") {
            await enforceAccountSignupRateLimit(event);
            const body = parseJsonBody(event);
            const created = await createAccount(body as never);
            return jsonResponse(201, {
                account: toCreateAccountResponse(created.account),
                accountSecret: created.accountSecret,
            });
        }

        const auth = await resolveBearerAuth(headers);
        if (!auth) {
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
            return handleAgentRoute(method, account.accountId, selfAgentMatch?.[1], event);
        }

        const selfSkillCollection = rawPath === "/accounts/me/skills";
        const selfSkillMatch = rawPath.match(/^\/accounts\/me\/skills\/([^/]+)$/);
        if (selfSkillCollection || selfSkillMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return handleSkillRoute(method, account.accountId, selfSkillMatch?.[1], event);
        }

        const selfCronCollection = rawPath === "/accounts/me/cron-jobs";
        const selfCronMatch = rawPath.match(/^\/accounts\/me\/cron-jobs\/([^/]+)$/);
        if (selfCronCollection || selfCronMatch?.[1]) {
            const account = requireAccountAuth(auth);
            return await handleCronJobRoute(method, account.accountId, selfCronMatch?.[1], event);
        }

        if (auth.kind !== "admin") {
            return errorResponse(403, "Forbidden");
        }

        if (method === "GET" && rawPath === "/accounts") {
            const accounts = await listAccounts();
            return jsonResponse(200, { accounts: accounts.map(toPublicAccount) });
        }

        const accountMatch = rawPath.match(/^\/accounts\/([^/]+)$/);
        if (accountMatch?.[1]) {
            const accountId = decodeURIComponent(accountMatch[1]);
            if (method === "GET") {
                const account = await getAccount(accountId);
                return account
                    ? jsonResponse(200, { account: toPublicAccount(account) })
                    : errorResponse(404, "Account not found");
            }

            if (method === "PATCH") {
                return updateAccountResponse(accountId, parseAccountPatch(event));
            }

            if (method === "DELETE") {
                const account = await getAccount(accountId);
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
            return handleAgentRoute(method, decodeURIComponent(adminAgentMatch[1]), adminAgentMatch[2], event);
        }

        const adminSkillMatch = rawPath.match(/^\/accounts\/([^/]+)\/skills(?:\/([^/]+))?$/);
        if (adminSkillMatch?.[1]) {
            return handleSkillRoute(method, decodeURIComponent(adminSkillMatch[1]), adminSkillMatch[2], event);
        }

        const adminCronMatch = rawPath.match(/^\/accounts\/([^/]+)\/cron-jobs(?:\/([^/]+))?$/);
        if (adminCronMatch?.[1]) {
            return await handleCronJobRoute(method, decodeURIComponent(adminCronMatch[1]), adminCronMatch[2], event);
        }

        return errorResponse(404, "Not found");
    } catch (err) {
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

    if (!cronJobId) {
        if (method === "GET") {
            const cronJobs = await listCronJobs(accountId);
            return jsonResponse(200, { cronJobs: cronJobs.map(toCronJobResponse) });
        }
        if (method === "POST") {
            const cronJob = await createCronJob(accountId, parseJsonBody(event) as never, {
                schedulerGroupName: schedulerGroupName(),
            });
            try {
                await createCronSchedule(cronJob);
            } catch (err) {
                await deleteCronJob(accountId, cronJob.cronJobId).catch(() => { });
                throw err;
            }
            return jsonResponse(201, { cronJob: toCronJobResponse(cronJob) });
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const cronJob = await getCronJob(accountId, cronJobId);
        return cronJob ? jsonResponse(200, { cronJob: toCronJobResponse(cronJob) }) : errorResponse(404, "Cron job not found");
    }
    if (method === "PATCH") {
        const existing = await getCronJob(accountId, cronJobId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }

        const patch = parseJsonBody(event);
        const patched = applyCronJobPatch(existing, patch as never);
        await updateCronSchedule(patched);
        const cronJob = await updateCronJob(accountId, cronJobId, patch as never);
        return cronJob ? jsonResponse(200, { cronJob: toCronJobResponse(cronJob) }) : errorResponse(404, "Cron job not found");
    }
    if (method === "DELETE") {
        const existing = await getCronJob(accountId, cronJobId);
        if (!existing) {
            return errorResponse(404, "Cron job not found");
        }
        await deleteCronSchedule(existing);
        const deleted = await deleteCronJob(accountId, cronJobId);
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

    if (!agentId) {
        if (method === "GET") {
            const agents = await listAgents(accountId);
            return jsonResponse(200, { agents: agents.map(toPublicAgent) });
        }
        if (method === "POST") {
            const agent = await createAgent(accountId, parseJsonBody(event) as never);
            return jsonResponse(201, { agent: toCreateAgentResponse(agent) });
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const agent = await getAgent(accountId, agentId);
        return agent ? jsonResponse(200, { agent: toPublicAgent(agent) }) : errorResponse(404, "Agent not found");
    }
    if (method === "PATCH") {
        const agent = await updateAgent(accountId, agentId, parseJsonBody(event) as never);
        return agent ? jsonResponse(200, { agent: toPublicAgent(agent) }) : errorResponse(404, "Agent not found");
    }
    if (method === "DELETE") {
        const deleted = await deleteAgent(accountId, agentId);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Agent not found");
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
            return jsonResponse(201, { skill: toSkillResponse(skill) });
        }
        return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "POST"] });
    }

    if (method === "GET") {
        const skill = await getSkill(accountId, skillName);
        return skill ? jsonResponse(200, { skill: toSkillResponse(skill) }) : errorResponse(404, "Skill not found");
    }
    if (method === "PUT") {
        const skill = await createOrReplaceSkill(accountId, parseJsonBody(event));
        if (skill.name !== skillName) {
            await deleteSkill(accountId, skill.name).catch(() => { });
            throw new Error("Skill name in SKILL.md must match the URL skillName");
        }
        return jsonResponse(200, { skill: toSkillResponse(skill) });
    }
    if (method === "DELETE") {
        const deleted = await deleteSkill(accountId, skillName);
        return deleted ? jsonResponse(200, { deleted: true }) : errorResponse(404, "Skill not found");
    }

    return errorResponse(405, "Method not allowed", { method, allowedMethods: ["GET", "PUT", "DELETE"] });
}

async function updateAccountResponse(accountId: string, input: unknown): Promise<LambdaResponse> {
    const account = await updateAccount(accountId, input as never);
    return account
        ? jsonResponse(200, { account: toPublicAccount(account) })
        : errorResponse(404, "Account not found");
}

async function rotateSecretResponse(accountId: string): Promise<LambdaResponse> {
    const rotated = await rotateAccountSecret(accountId);
    return rotated
        ? jsonResponse(200, {
            account: toPublicAccount(rotated.account),
            accountSecret: rotated.accountSecret,
        })
        : errorResponse(404, "Account not found");
}

async function deleteAccountResponse(account: Extract<AuthContext, { kind: "account" }>["account"]): Promise<LambdaResponse> {
    const [cleanup, agentsDeleted, skillObjectsDeleted, cronJobsDeleted] = await Promise.all([
        deleteAccountRuntimeData(account),
        deleteAccountAgents(account.accountId),
        deleteAccountSkills(account.accountId),
        deleteAccountCronJobs(account.accountId),
    ]);
    await deleteAccount(account.accountId);
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
        skillPath: skill.skillPath,
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

    const cronJobs = await listCronJobs(accountId);
    await Promise.all(cronJobs.map(async (cronJob) => {
        await deleteCronSchedule(cronJob);
        await deleteCronJob(accountId, cronJob.cronJobId);
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

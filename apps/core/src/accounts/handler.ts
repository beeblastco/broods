/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import { resolveBearerAuth, type AuthContext } from "../shared/auth.ts";
import {
    getStorage,
    isCronsConfigured,
    normalizeCreateAccountInput,
    type AccountRecord,
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
import { deleteAccountRuntimeData } from "./cleanup.ts";
import { workspaceNamespace, workspaceNamespaceOwnsReservationKey } from "../shared/workspaces.ts";
import { isPlainObject } from "../shared/object.ts";
import { deleteAccountSkills } from "./skills.ts";
import { deleteAccountToolBundles } from "./bundles.ts";
import { deleteCronSchedule } from "./cron.ts";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import { runWithObservabilityScope } from "../shared/otel.ts";

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

        const auth = await resolveBearerAuth(headers);
        if (!auth) {
            logWarn("Account manage request unauthorized", {
                method,
                rawPath,
            });
            return errorResponse(401, "Unauthorized");
        }

        if (method === "DELETE" && rawPath === "/v1/account") {
            const account = requireAccountAuth(auth);
            return deleteAccountResponse(account);
        }

        // Agent, skills, tools, hooks, workspace-file, cron, workspace, sandbox-config, and
        // policy CRUD moved to the Convex config plane (configHttp.ts, epic
        // #85 phase 9); the gateway routes those paths there. Runtime reads
        // stay in src/shared/skills.ts, uploaded tool bundle loading,
        // workspace mount/S3 read helpers, sandbox lifecycle verbs, and the
        // harness cron-run leaf; account deletion still sweeps leftover
        // schedules (deleteAccountCrons).

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

        if (auth.kind !== "admin") {
            return errorResponse(403, "Forbidden");
        }

        if (method === "POST" && rawPath === "/accounts") {
            const body = parseJsonBody(request);
            const created = await getStorage().accounts.create(normalizeCreateAccountInput(body));
            return jsonResponse(201, {
                account: toCreateAccountResponse(created.account),
                secret: created.secret,
            });
        }

        const accountMatch = rawPath.match(/^\/accounts\/([^/]+)$/);
        if (accountMatch?.[1]) {
            const accountId = decodeURIComponent(accountMatch[1]);
            if (method === "DELETE") {
                const account = await getStorage().accounts.getById(accountId);
                if (!account) {
                    return errorResponse(404, "Account not found");
                }
                return deleteAccountResponse(account);
            }
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
        return errorResponseForError(err);
    }
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

async function deleteAccountResponse(account: Extract<AuthContext, { kind: "account" }>["account"]): Promise<Response> {
    const [runtime, agentsDeleted, skillObjectsDeleted, toolBundleObjectsDeleted, cronsDeleted, accountToolsDeleted, accountHooksDeleted] = await Promise.all([
        deleteAccountRuntimeData(account),
        getStorage().agents.removeAllForAccount(account.accountId),
        deleteAccountSkills(account.accountId),
        deleteAccountToolBundles(account.accountId),
        deleteAccountCrons(account.accountId),
        getStorage().accountTools.removeAllForAccount(account.accountId),
        getStorage().accountHooks.removeAllForAccount(account.accountId),
    ]);
    await getStorage().accounts.remove(account.accountId);
    return jsonResponse(200, { deleted: true, cleanup: { ...runtime, agentsDeleted, skillObjectsDeleted, toolBundleObjectsDeleted, cronsDeleted, accountToolsDeleted, accountHooksDeleted } });
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

async function deleteAccountCrons(accountId: string): Promise<number> {
    if (!isCronsConfigured()) {
        return 0;
    }

    const cronsStore = getStorage().crons;
    const crons = await cronsStore.list(accountId);
    await Promise.all(crons.map(async (cron) => {
        await deleteCronSchedule(cron);
        await cronsStore.remove(accountId, cron.cronId);
    }));
    return crons.length;
}

function errorResponseForError(err: unknown): Response {
    if (err instanceof AccountEndpointUnauthorizedError) {
        return errorResponse(401, err.message);
    }
    return errorResponse(400, err instanceof Error ? err.message : "Invalid request");
}

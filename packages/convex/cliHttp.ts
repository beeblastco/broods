/**
 * HTTP handlers for the `beeblast` CLI.
 *
 * Routes authenticate with the org Bearer secret and delegate writes to
 * `cliSync` so the CLI can sync desired-state manifests without browser auth.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

type RouteParts =
    | { kind: "manifest"; project: string; environment: string }
    | { kind: "logs"; project: string; environment: string }
    | { kind: "env"; project: string; environment: string; name: string }
    | {
        kind: "resource";
        project: string;
        environment: string;
        resourceKind: "agent" | "workspace" | "sandbox" | "cronJob";
        name: string;
    };

type CliManifest = {
    version: 1;
    project: string;
    environment: string;
    resources: Array<{
        kind: "agent" | "workspace" | "sandbox" | "cronJob";
        name: string;
        description?: string;
        config: unknown;
    }>;
};

type GeneratedIds = {
    agents?: Record<string, string>;
    workspaces?: Record<string, string>;
    sandboxes?: Record<string, string>;
    cronJobs?: Record<string, string>;
};

type CronJobResponse = {
    cronJobId: string;
    name: string;
    agentId: string;
    prompt: string;
    conversationKey?: string;
    scheduleExpression: string;
    timezone?: string;
    status: "active" | "paused";
    description?: string;
};

type DesiredCronJob = Omit<CronJobResponse, "cronJobId"> & {
    resourceName: string;
};

export const handle = httpAction(async (ctx, req) => {
    try {
        const auth = await bearerAuth(req);
        const route = parseRoute(new URL(req.url).pathname);
        if (!route) return json({ error: "Not found" }, 404);

        if (route.kind === "manifest" && req.method === "GET") {
            const result = await ctx.runQuery(internal.cliSync.getManifestBySecretHash, {
                secretHash: auth.secretHash,
                project: route.project,
                environment: route.environment,
            });

            return result ? json(result) : json({ error: "Manifest not found" }, 404);
        }

        if (route.kind === "logs" && req.method === "GET") {
            const url = new URL(req.url);
            const logs = await ctx.runAction(internal.logs.fetchForCli, {
                secretHash: auth.secretHash,
                project: route.project,
                environment: route.environment,
                lookbackMs: numberSearchParam(url, "lookbackMs"),
                limit: numberSearchParam(url, "limit"),
                errorOnly: booleanSearchParam(url, "errorOnly"),
            });

            return json({ logs });
        }

        if (route.kind === "manifest" && req.method === "PUT") {
            const body = await req.json() as { manifest?: unknown; prune?: boolean };
            const manifest = body.manifest;
            if (!manifest || typeof manifest !== "object") {
                return json({ error: "Request body must include manifest" }, 400);
            }
            const result = await ctx.runMutation(internal.cliSync.syncManifestBySecretHash, {
                secretHash: auth.secretHash,
                manifest: manifest as never,
                prune: body.prune === true,
            });

            const cronJobIds = await syncCronJobs(auth.token, manifest as CliManifest, result.ids, body.prune === true);
            const refreshed = await ctx.runQuery(internal.cliSync.getManifestBySecretHash, {
                secretHash: auth.secretHash,
                project: route.project,
                environment: route.environment,
            });

            return json(refreshed ?? {
                ...result,
                ids: { ...result.ids, cronJobs: cronJobIds },
            });
        }

        if (route.kind === "env" && req.method === "PUT") {
            const body = await req.json() as { value?: unknown };
            if (typeof body.value !== "string") {
                return json({ error: "Request body must include string value" }, 400);
            }
            await ctx.runMutation(internal.cliSync.setEnvBySecretHash, {
                secretHash: auth.secretHash,
                project: route.project,
                environment: route.environment,
                name: route.name,
                value: body.value,
            });

            return json({ ok: true });
        }

        if (route.kind === "resource" && req.method === "DELETE") {
            if (route.resourceKind === "cronJob") {
                await deleteCronJobByName(auth.token, route.name);
            } else {
                await ctx.runMutation(internal.cliSync.deleteResourceBySecretHash, {
                    secretHash: auth.secretHash,
                    project: route.project,
                    environment: route.environment,
                    kind: route.resourceKind,
                    name: route.name,
                });
            }

            return json({ deleted: true });
        }

        return json({ error: "Method not allowed" }, 405);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("Authorization") || message.includes("token") ? 401 : 400;

        return json({ error: message }, status);
    }
});

function parseRoute(pathname: string): RouteParts | null {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (
        parts.length === 7 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "manifest"
    ) {
        return { kind: "manifest", project: parts[3], environment: parts[5] };
    }
    if (
        parts.length === 8 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "env"
    ) {
        return { kind: "env", project: parts[3], environment: parts[5], name: parts[7] };
    }
    if (
        parts.length === 7 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "logs"
    ) {
        return { kind: "logs", project: parts[3], environment: parts[5] };
    }
    if (
        parts.length === 9 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "resources" &&
        isResourceKind(parts[7])
    ) {
        return {
            kind: "resource",
            project: parts[3],
            environment: parts[5],
            resourceKind: parts[7],
            name: parts[8],
        };
    }

    return null;
}

function numberSearchParam(url: URL, name: string): number | undefined {
    const raw = url.searchParams.get(name);
    if (!raw) return undefined;
    const value = Number(raw);

    return Number.isFinite(value) ? value : undefined;
}

function booleanSearchParam(url: URL, name: string): boolean | undefined {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    return raw === "1" || raw === "true";
}

function isResourceKind(value: string): value is "agent" | "workspace" | "sandbox" | "cronJob" {
    return value === "agent" || value === "workspace" || value === "sandbox" || value === "cronJob";
}

async function bearerAuth(req: Request): Promise<{ token: string; secretHash: string }> {
    const header = req.headers.get("Authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw new Error("Authorization Bearer token is required");

    return {
        token: match[1],
        secretHash: await sha256Hex(match[1]),
    };
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" },
    });
}

async function syncCronJobs(
    token: string,
    manifest: CliManifest,
    ids: GeneratedIds,
    prune: boolean,
): Promise<Record<string, string>> {
    const desired = desiredCronJobs(manifest, ids.agents ?? {});
    if (desired.length === 0 && prune !== true) return {};
    const existing = await listCronJobs(token);
    const existingByName = new Map(existing.map((job) => [job.name, job]));
    const desiredNames = new Set(desired.map((job) => job.name));
    const cronJobIds: Record<string, string> = {};

    for (const job of desired) {
        const existingJob = existingByName.get(job.name);
        if (existingJob) {
            await updateCronJob(token, existingJob.cronJobId, job);
            cronJobIds[job.resourceName] = existingJob.cronJobId;
        } else {
            const created = await createCronJob(token, job);
            cronJobIds[job.resourceName] = created.cronJobId;
        }
    }

    if (prune === true) {
        const environmentAgentIds = new Set(Object.values(ids.agents ?? {}));
        for (const job of existing) {
            if (!environmentAgentIds.has(job.agentId) || desiredNames.has(job.name)) continue;
            await deleteCronJob(token, job.cronJobId);
        }
    }

    return cronJobIds;
}

function desiredCronJobs(
    manifest: CliManifest,
    agentIds: Record<string, string>,
): DesiredCronJob[] {
    return manifest.resources
        .filter((resource) => resource.kind === "cronJob")
        .map((resource) => {
            const config = asRecord(resource.config, `cronJob:${resource.name}`);
            const localAgentName = stringField(config.agentId, `cronJob:${resource.name}.agentId`);
            const agentId = agentIds[localAgentName];
            if (!agentId) throw new Error(`Cron job ${resource.name} references unknown deployed agent: ${localAgentName}`);

            return stripUndefined({
                resourceName: resource.name,
                name: stringField(config.name, `cronJob:${resource.name}.name`),
                description: optionalStringField(config.description ?? resource.description),
                agentId: agentId,
                prompt: stringField(config.prompt, `cronJob:${resource.name}.prompt`),
                conversationKey: optionalStringField(config.conversationKey),
                scheduleExpression: stringField(config.scheduleExpression, `cronJob:${resource.name}.scheduleExpression`),
                timezone: optionalStringField(config.timezone),
                status: cronJobStatus(config.status),
            });
        });
}

async function listCronJobs(token: string): Promise<CronJobResponse[]> {
    const response = await accountManageFetch(token, "/accounts/me/cron-jobs", { method: "GET" });
    const payload = await response.json() as { cronJobs?: CronJobResponse[] };
    return Array.isArray(payload.cronJobs) ? payload.cronJobs : [];
}

async function createCronJob(
    token: string,
    job: DesiredCronJob,
): Promise<CronJobResponse> {
    const response = await accountManageFetch(token, "/accounts/me/cron-jobs", {
        method: "POST",
        body: JSON.stringify(cronJobBody(job)),
    });
    const payload = await response.json() as CronJobResponse | { cronJob?: CronJobResponse };
    return "cronJob" in payload && payload.cronJob ? payload.cronJob : payload as CronJobResponse;
}

async function updateCronJob(
    token: string,
    cronJobId: string,
    job: DesiredCronJob,
): Promise<void> {
    await accountManageFetch(token, `/accounts/me/cron-jobs/${encodeURIComponent(cronJobId)}`, {
        method: "PATCH",
        body: JSON.stringify(cronJobBody(job)),
    });
}

async function deleteCronJob(token: string, cronJobId: string): Promise<void> {
    await accountManageFetch(token, `/accounts/me/cron-jobs/${encodeURIComponent(cronJobId)}`, {
        method: "DELETE",
    });
}

async function deleteCronJobByName(token: string, name: string): Promise<void> {
    const existing = await listCronJobs(token);
    const cronJob = existing.find((job) => job.name === name);
    if (!cronJob) return;
    await deleteCronJob(token, cronJob.cronJobId);
}

async function accountManageFetch(token: string, path: string, init: RequestInit): Promise<Response> {
    const baseUrl = process.env.FILTHY_PANTY_ACCOUNT_MANAGE_URL;
    if (!baseUrl) throw new Error("FILTHY_PANTY_ACCOUNT_MANAGE_URL is required to sync cron jobs");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...init.headers,
        },
    });
    if (!response.ok) {
        throw new Error(`BeeBlast account-manage cron sync failed: ${response.status} ${await response.text()}`);
    }

    return response;
}

function cronJobBody(job: DesiredCronJob): Record<string, unknown> {
    const body: Record<string, unknown> = { ...job };
    delete body.resourceName;

    return stripUndefined(body);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} config must be an object`);
    }

    return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);

    return value;
}

function optionalStringField(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function cronJobStatus(value: unknown): "active" | "paused" {
    if (value === undefined) return "active";
    if (value === "active" || value === "paused") return value;
    throw new Error("Cron job status must be active or paused");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

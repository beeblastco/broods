/**
 * HTTP handlers for the `broods` CLI.
 *
 * Routes authenticate with the org Bearer secret and delegate writes to
 * `cliSync` so the CLI can sync desired-state manifests without browser auth.
 */

import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { CliManifest, GeneratedIds } from "./cliTypes";

type RouteParts =
    | { kind: "manifest"; project: string; environment: string }
    | { kind: "logs"; project: string; environment: string }
    | { kind: "runtimeKey"; project: string; environment: string }
    | { kind: "envList"; project: string; environment: string }
    | { kind: "env"; project: string; environment: string; name: string }
    | {
        kind: "resource";
        project: string;
        environment: string;
        resourceKind: "agent" | "workspace" | "sandbox" | "cron";
        name: string;
    };

type CronResponse = {
    cronId: string;
    name: string;
    agentId: string;
    events: unknown[];
    conversationKey?: string;
    scheduleExpression: string;
    timezone?: string;
    status: "active" | "paused";
    description?: string;
};

type DesiredCron = Omit<CronResponse, "cronId"> & {
    resourceName: string;
};

export const handle = httpAction(async (ctx, req) => {
    try {
        const auth = await bearerAuth(req);
        const route = parseRoute(new URL(req.url).pathname);
        if (!route) return json({ error: "Not found" }, 404);

        // Resolve the token to an account secret hash, enforcing deploy-key scope
        // against the route's project/environment. `scoped` keys can't forward to
        // broods's cron API (which only knows the org secret), so cron sync
        // is skipped for them — `forwardToken` is null in that case.
        const resolved = await ctx.runQuery(internal.cliSync.resolveCliAuth, {
            tokenHash: auth.secretHash,
            project: route.project,
            environment: route.environment,
        });
        const cliResolved = resolved ? null : await ctx.runMutation(internal.cliAuth.resolveCliToken, {
            tokenHash: auth.secretHash,
        });
        const authResult = resolved ?? (cliResolved ? {
            accountId: cliResolved.accountId,
            secretHash: cliResolved.secretHash,
            scoped: true,
            cliTokenId: cliResolved.cliTokenId,
            cliAuthId: cliResolved.authId,
        } : null);
        if (!authResult) return json({ error: "Invalid or out-of-scope deploy token" }, 401);
        const secretHash = authResult.secretHash;
        const forwardToken = authResult.scoped ? null : auth.token;
        const accountId = authResult.accountId;

        if (route.kind === "manifest" && req.method === "GET") {
            const result = await ctx.runQuery(internal.cliSync.getManifestBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
            });

            return result ? json(result) : json({ error: "Manifest not found" }, 404);
        }

        if (route.kind === "logs" && req.method === "GET") {
            // Logs now stream via the gateway (NATS live tail + Loki backfill).
            // Use wss://gateway.broods.app/v1/<project>/<env>/observability/ws instead.
            return json({ error: "Log streaming has moved to the gateway observability WebSocket" }, 410);
        }

        if (route.kind === "runtimeKey" && req.method === "GET") {
            // Reconnect path: recover the existing runtime key (minting one if the
            // environment has none yet) so the CLI can write BROODS_API_KEY
            // without a redeploy.
            const deployment = await ctx.runMutation(internal.cliSync.ensureRuntimeKeyBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
            });

            return deployment
                ? json({
                    apiKey: deployment.apiKey,
                    keyHint: deployment.keyHint,
                    endpointId: deployment.endpointId,
                    projectSlug: deployment.projectSlug,
                    environmentSlug: deployment.environmentSlug,
                })
                : json({ error: "Project or environment not found" }, 404);
        }

        if (route.kind === "manifest" && req.method === "PUT") {
            const body = await req.json() as { manifest?: unknown; prune?: boolean; rotateRuntimeKey?: boolean };
            const manifest = body.manifest;
            if (!manifest || typeof manifest !== "object") {
                return json({ error: "Request body must include manifest" }, 400);
            }
            if (!manifestMatchesRoute(manifest, route)) {
                return json({ error: "Manifest project/environment must match the request path" }, 400);
            }
            const originalManifest = manifest as CliManifest;
            const externalIds = await syncExternalResources(accountId, originalManifest, body.prune === true);
            await ctx.runMutation(internal.cliSync.recordExternalResourcesBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                resources: originalManifest.resources as never,
                ids: externalIds,
                prune: body.prune === true,
            });
            const syncManifest = rewriteExternalResourceRefs(originalManifest, externalIds);
            const result = await ctx.runMutation(internal.cliSync.syncManifestBySecretHash, {
                secretHash: secretHash,
                manifest: syncManifest as never,
                prune: body.prune === true,
            });
            await syncSkillNodeFiles(ctx, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                manifest: originalManifest,
            });

            const cronIds = forwardToken
                ? await syncCrons(forwardToken, syncManifest, result.ids, body.prune === true)
                : await syncCronsWithServiceToken(accountId, syncManifest, result.ids, body.prune === true);
            const refreshed = await ctx.runQuery(internal.cliSync.getManifestBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
            });

            // Ensure the environment has a recoverable runtime API key so the CLI
            // can write BROODS_API_KEY locally on first or later deploys.
            const deployment = await ctx.runMutation(internal.cliSync.ensureRuntimeKeyBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                rotate: body.rotateRuntimeKey === true,
                auditSync: {
                    resourceCount: originalManifest.resources.length,
                    prune: body.prune === true,
                },
            });

            // `refreshed` is re-read from the DB and carries no warnings, so merge
            // the sync mutation's warnings back in either way.
            return json({
                ...(refreshed ?? {
                    ...result,
                    ids: { ...result.ids, ...externalIds, crons: cronIds },
                }),
                warnings: result.warnings,
                deployment: deployment,
            });
        }

        if (route.kind === "envList" && req.method === "GET") {
            const variables = await ctx.runQuery(internal.cliSync.listEnvBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
            });

            return json({ variables });
        }

        if (route.kind === "env" && req.method === "GET") {
            const result = await ctx.runMutation(internal.cliSync.getEnvBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                name: route.name,
                revealedByCliTokenId: "cliTokenId" in authResult ? authResult.cliTokenId : undefined,
                revealedByCliAuthId: "cliAuthId" in authResult ? authResult.cliAuthId : undefined,
                revealedByDeployKeyId: "deployKeyId" in authResult ? authResult.deployKeyId : undefined,
            });

            return result ? json(result) : json({ error: "Environment variable not found" }, 404);
        }

        if (route.kind === "env" && req.method === "DELETE") {
            const result = await ctx.runMutation(internal.cliSync.removeEnvBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                name: route.name,
            });

            return json({ removed: result.removed });
        }

        if (route.kind === "env" && req.method === "PUT") {
            const body = await req.json() as { value?: unknown };
            if (typeof body.value !== "string") {
                return json({ error: "Request body must include string value" }, 400);
            }
            await ctx.runMutation(internal.cliSync.setEnvBySecretHash, {
                secretHash: secretHash,
                project: route.project,
                environment: route.environment,
                name: route.name,
                value: body.value,
            });

            return json({ ok: true });
        }

        if (route.kind === "resource" && req.method === "DELETE") {
            if (route.resourceKind === "cron") {
                // Scoped deploy keys can't manage broods cron jobs; no-op for them.
                if (forwardToken) await deleteCronByName(forwardToken, route.name);
                else await deleteCronByNameWithServiceToken(accountId, route.name);
            } else {
                await ctx.runMutation(internal.cliSync.deleteResourceBySecretHash, {
                    secretHash: secretHash,
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
        parts.length === 7 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "runtime-key"
    ) {
        return { kind: "runtimeKey", project: parts[3], environment: parts[5] };
    }
    if (
        parts.length === 7 &&
        parts[0] === "api" &&
        parts[1] === "cli" &&
        parts[2] === "projects" &&
        parts[4] === "environments" &&
        parts[6] === "env"
    ) {
        return { kind: "envList", project: parts[3], environment: parts[5] };
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

function manifestMatchesRoute(
    manifest: unknown,
    route: Extract<RouteParts, { kind: "manifest" }>,
): boolean {
    if (!manifest || typeof manifest !== "object") return false;
    const candidate = manifest as { project?: unknown; environment?: unknown };

    return candidate.project === route.project && candidate.environment === route.environment;
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

function isResourceKind(value: string): value is "agent" | "workspace" | "sandbox" | "cron" {
    return value === "agent" || value === "workspace" || value === "sandbox" || value === "cron";
}

/**
 * Stores CLI-bundled skill files in Convex storage and mirrors them into workspaceFiles.
 */
async function syncSkillNodeFiles(
    ctx: ActionCtx,
    options: {
        secretHash: string;
        project: string;
        environment: string;
        manifest: CliManifest;
    },
): Promise<void> {
    for (const resource of options.manifest.resources.filter((entry) => entry.kind === "skill")) {
        const config = asRecord(resource.config, `skill:${resource.name}`);
        const files = config.files;
        if (!Array.isArray(files)) continue;
        const storedFiles = [];
        for (const entry of files) {
            const file = asRecord(entry, `skill:${resource.name}.files[]`);
            const path = stringField(file.path, `skill:${resource.name}.files[].path`);
            const contentBase64 = stringField(file.contentBase64, `skill:${resource.name}.files[].contentBase64`);
            const mimeType = typeof file.contentType === "string" ? file.contentType : "text/plain";
            const bytes = base64ArrayBuffer(contentBase64);
            const storageId = await ctx.storage.store(new Blob([bytes], { type: mimeType }));
            const parts = path.split("/");
            storedFiles.push({
                path: path,
                name: parts[parts.length - 1] || path,
                storageId: storageId,
                mimeType: mimeType,
                sizeBytes: bytes.byteLength,
            });
        }

        await ctx.runMutation(internal.cliSync.replaceSkillNodeFilesBySecretHash, {
            secretHash: options.secretHash,
            project: options.project,
            environment: options.environment,
            skillName: resource.name,
            files: storedFiles,
        });
    }
}

/**
 * Decodes base64 without Node Buffer because Convex HTTP actions run in the web runtime.
 */
function base64ArrayBuffer(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer as ArrayBuffer;
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

type ExternalIds = Pick<GeneratedIds, "skills" | "tools">;

async function syncExternalResources(
    accountId: string,
    manifest: CliManifest,
    prune: boolean,
): Promise<ExternalIds> {
    const hasExternalResources = manifest.resources.some((entry) =>
        entry.kind === "skill" || entry.kind === "tool",
    );
    if (!hasExternalResources) return { skills: {}, tools: {} };

    const skills = await syncSkillResources(accountId, manifest);
    const tools = await syncToolResources(accountId, manifest, prune);

    return { skills, tools };
}

async function syncSkillResources(
    accountId: string,
    manifest: CliManifest,
): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const resource of manifest.resources.filter((entry) => entry.kind === "skill")) {
        const config = asRecord(resource.config, `skill:${resource.name}`);
        const files = config.files;
        if (!Array.isArray(files)) throw new Error(`skill:${resource.name}.files must be an array`);
        const response = await accountManageFetchWithServiceToken(
            accountId,
            `/accounts/me/skills/${encodeURIComponent(resource.name)}`,
            {
                method: "PUT",
                body: JSON.stringify({ source: "files", files }),
            },
        );
        const payload = await response.json() as { path?: string };
        ids[resource.name] = payload.path ?? `${accountId}/${resource.name}`;
    }

    return ids;
}

async function syncToolResources(
    accountId: string,
    manifest: CliManifest,
    prune: boolean,
): Promise<Record<string, string>> {
    const desired = manifest.resources.filter((entry) => entry.kind === "tool");
    if (desired.length === 0) return {};
    const existingResponse = await accountManageFetchWithServiceToken(accountId, "/accounts/me/tools", { method: "GET" });
    const existingPayload = await existingResponse.json() as {
        tools?: Array<{ toolId: string; name: string; status?: string }>;
    };
    const existing = new Map((existingPayload.tools ?? []).map((tool) => [tool.name, tool]));
    const desiredNames = new Set(desired.map((resource) => resource.name));
    const ids: Record<string, string> = {};

    for (const resource of desired) {
        const config = asRecord(resource.config, `tool:${resource.name}`);
        const body = JSON.stringify({
            name: resource.name,
            description: stringField(config.description ?? resource.description, `tool:${resource.name}.description`),
            inputSchema: asRecord(config.inputSchema, `tool:${resource.name}.inputSchema`),
            ...(config.defaultConfig !== undefined ? { defaultConfig: asRecord(config.defaultConfig, `tool:${resource.name}.defaultConfig`) } : {}),
            bundle: stringField(config.bundle, `tool:${resource.name}.bundle`),
        });
        const current = existing.get(resource.name);
        const response = current
            ? await accountManageFetchWithServiceToken(accountId, `/accounts/me/tools/${encodeURIComponent(current.toolId)}`, {
                method: "PATCH",
                body,
            })
            : await accountManageFetchWithServiceToken(accountId, "/accounts/me/tools", {
                method: "POST",
                body,
            });
        const payload = await response.json() as { toolId: string };
        ids[resource.name] = payload.toolId;
    }

    if (prune === true) {
        for (const tool of existing.values()) {
            if (!desiredNames.has(tool.name)) {
                await accountManageFetchWithServiceToken(accountId, `/accounts/me/tools/${encodeURIComponent(tool.toolId)}`, {
                    method: "DELETE",
                });
            }
        }
    }

    return ids;
}

function rewriteExternalResourceRefs(manifest: CliManifest, ids: ExternalIds): CliManifest {
    return {
        ...manifest,
        resources: manifest.resources.map((resource) => {
            if (resource.kind !== "agent") return resource;
            return {
                ...resource,
                config: rewriteExternalConfigRefs(asRecord(resource.config, `agent:${resource.name}`), ids),
            };
        }),
    };
}

function rewriteExternalConfigRefs(config: Record<string, unknown>, ids: ExternalIds): Record<string, unknown> {
    const result = { ...config };
    if (asOptionalRecord(result.skills) && Array.isArray(asOptionalRecord(result.skills)?.allowed)) {
        const skills = asOptionalRecord(result.skills)!;
        result.skills = {
            ...skills,
            allowed: (skills.allowed as unknown[]).map((entry) =>
                typeof entry === "string" && ids.skills[entry] ? ids.skills[entry] : entry,
            ),
        };
    }
    if (asOptionalRecord(result.tools)) {
        const tools = asOptionalRecord(result.tools)!;
        result.tools = Object.fromEntries(Object.entries(tools).map(([key, value]) => [
            ids.tools[key] ?? key,
            value,
        ]));
    }

    return result;
}

async function syncCrons(
    token: string,
    manifest: CliManifest,
    ids: GeneratedIds,
    prune: boolean,
): Promise<Record<string, string>> {
    return syncCronsWithFetch(
        manifest,
        ids,
        prune,
        (path, init) => accountManageFetch(token, path, init),
    );
}

async function syncCronsWithFetch(
    manifest: CliManifest,
    ids: GeneratedIds,
    prune: boolean,
    fetchCron: (path: string, init: RequestInit) => Promise<Response>,
): Promise<Record<string, string>> {
    const desired = desiredCrons(manifest, ids.agents ?? {});
    if (desired.length === 0 && prune !== true) return {};
    const existing = await listCronsWithFetch(fetchCron);
    const existingByName = new Map(existing.map((job) => [job.name, job]));
    const desiredNames = new Set(desired.map((job) => job.name));
    const cronIds: Record<string, string> = {};

    for (const job of desired) {
        const existingJob = existingByName.get(job.name);
        if (existingJob) {
            await updateCronWithFetch(fetchCron, existingJob.cronId, job);
            cronIds[job.resourceName] = existingJob.cronId;
        } else {
            const created = await createCronWithFetch(fetchCron, job);
            cronIds[job.resourceName] = created.cronId;
        }
    }

    if (prune === true) {
        const environmentAgentIds = new Set(Object.values(ids.agents ?? {}));
        for (const job of existing) {
            if (!environmentAgentIds.has(job.agentId) || desiredNames.has(job.name)) continue;
            await deleteCronWithFetch(fetchCron, job.cronId);
        }
    }

    return cronIds;
}

function desiredCrons(
    manifest: CliManifest,
    agentIds: Record<string, string>,
): DesiredCron[] {
    return manifest.resources
        .filter((resource) => resource.kind === "cron")
        .map((resource) => {
            const config = asRecord(resource.config, `cron:${resource.name}`);
            const localAgentName = stringField(config.agentId, `cron:${resource.name}.agentId`);
            const agentId = agentIds[localAgentName];
            if (!agentId) throw new Error(`Cron job ${resource.name} references unknown deployed agent: ${localAgentName}`);

            return stripUndefined({
                resourceName: resource.name,
                name: stringField(config.name, `cron:${resource.name}.name`),
                description: optionalStringField(config.description ?? resource.description),
                agentId: agentId,
                events: cronEvents(config, `cron:${resource.name}`),
                conversationKey: optionalStringField(config.conversationKey),
                scheduleExpression: stringField(config.scheduleExpression, `cron:${resource.name}.scheduleExpression`),
                timezone: optionalStringField(config.timezone),
                status: cronStatus(config.status),
            });
        });
}

async function listCrons(token: string): Promise<CronResponse[]> {
    return listCronsWithFetch((path, init) => accountManageFetch(token, path, init));
}

async function listCronsWithFetch(
    fetchCron: (path: string, init: RequestInit) => Promise<Response>,
): Promise<CronResponse[]> {
    const response = await fetchCron("/accounts/me/crons", { method: "GET" });
    const payload = await response.json() as { crons?: CronResponse[] };
    return Array.isArray(payload.crons) ? payload.crons : [];
}

async function createCron(
    token: string,
    job: DesiredCron,
): Promise<CronResponse> {
    return createCronWithFetch((path, init) => accountManageFetch(token, path, init), job);
}

async function createCronWithFetch(
    fetchCron: (path: string, init: RequestInit) => Promise<Response>,
    job: DesiredCron,
): Promise<CronResponse> {
    const response = await fetchCron("/accounts/me/crons", {
        method: "POST",
        body: JSON.stringify(cronBody(job)),
    });
    const payload = await response.json() as CronResponse | { cron?: CronResponse };
    return "cron" in payload && payload.cron ? payload.cron : payload as CronResponse;
}

async function updateCron(
    token: string,
    cronId: string,
    job: DesiredCron,
): Promise<void> {
    await updateCronWithFetch((path, init) => accountManageFetch(token, path, init), cronId, job);
}

async function updateCronWithFetch(
    fetchCron: (path: string, init: RequestInit) => Promise<Response>,
    cronId: string,
    job: DesiredCron,
): Promise<void> {
    await fetchCron(`/accounts/me/crons/${encodeURIComponent(cronId)}`, {
        method: "PATCH",
        body: JSON.stringify(cronBody(job)),
    });
}

async function deleteCron(token: string, cronId: string): Promise<void> {
    await deleteCronWithFetch((path, init) => accountManageFetch(token, path, init), cronId);
}

async function deleteCronWithFetch(
    fetchCron: (path: string, init: RequestInit) => Promise<Response>,
    cronId: string,
): Promise<void> {
    await fetchCron(`/accounts/me/crons/${encodeURIComponent(cronId)}`, {
        method: "DELETE",
    });
}

async function deleteCronByName(token: string, name: string): Promise<void> {
    const existing = await listCrons(token);
    const cron = existing.find((job) => job.name === name);
    if (!cron) return;
    await deleteCron(token, cron.cronId);
}

async function accountManageFetch(token: string, path: string, init: RequestInit): Promise<Response> {
    const baseUrl = process.env.BROODS_ACCOUNT_MANAGE_URL;
    if (!baseUrl) throw new Error("BROODS_ACCOUNT_MANAGE_URL is required to sync cron jobs");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...init.headers,
        },
    });
    if (!response.ok) {
        throw new Error(`Broods account-manage cron sync failed: ${response.status} ${await response.text()}`);
    }

    return response;
}

async function accountManageFetchWithServiceToken(accountId: string, path: string, init: RequestInit): Promise<Response> {
    const baseUrl = process.env.BROODS_ACCOUNT_MANAGE_URL;
    const token = process.env.BROODS_SERVICE_AUTH_SECRET;
    if (!baseUrl || !token) {
        throw new Error("BROODS_ACCOUNT_MANAGE_URL and BROODS_SERVICE_AUTH_SECRET are required");
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Account-Id": accountId,
            ...init.headers,
        },
    });
    if (!response.ok) {
        throw new Error(`Broods account-manage service call failed: ${response.status} ${await response.text()}`);
    }

    return response;
}

async function syncCronsWithServiceToken(
    accountId: string,
    manifest: CliManifest,
    ids: GeneratedIds,
    prune: boolean,
): Promise<Record<string, string>> {
    return syncCronsWithFetch(
        manifest,
        ids,
        prune,
        (path, init) => accountManageFetchWithServiceToken(accountId, path, init),
    );
}

async function deleteCronByNameWithServiceToken(accountId: string, name: string): Promise<void> {
    const existing = await listCronsWithFetch((path, init) => accountManageFetchWithServiceToken(accountId, path, init));
    const cron = existing.find((job) => job.name === name);
    if (!cron) return;
    await accountManageFetchWithServiceToken(accountId, `/accounts/me/crons/${encodeURIComponent(cron.cronId)}`, {
        method: "DELETE",
    });
}

function cronBody(job: DesiredCron): Record<string, unknown> {
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

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);

    return value;
}

function optionalStringField(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function cronEvents(config: Record<string, unknown>, label: string): unknown[] {
    if (Array.isArray(config.events) && config.events.length > 0) return config.events;
    if (typeof config.prompt === "string" && config.prompt.trim()) {
        return [{ role: "user", content: [{ type: "text", text: config.prompt }] }];
    }

    throw new Error(`${label}.events must be a non-empty array`);
}

function cronStatus(value: unknown): "active" | "paused" {
    if (value === undefined) return "active";
    if (value === "active" || value === "paused") return value;
    throw new Error("Cron job status must be active or paused");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

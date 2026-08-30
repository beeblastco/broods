/**
 * Route handlers for the CLI HTTP surface (`cli/http.ts` is the router).
 * One exported handler per route kind, plus the external-resource sync helpers
 * (skills/tools/hooks bundles, cron reconciliation) the manifest PUT drives.
 */

import { type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CliManifest, GeneratedIds } from "./types";
import { isExternalResourceKind } from "../model/cliSync";
import { normalizeAccountHookUpload } from "../model/accountHooks";
import { normalizeAccountToolUpload } from "../model/accountTools";
import { normalizeMcpInput } from "../model/mcp";
import { putHookBundle, putToolBundle, storeMcpBundle } from "../model/bundles";
import { remapKeys, stableJson, stripUndefined } from "../model/objects";
import type { ProjectStageScope } from "../model/projectScope";

/** Resolved CLI auth: an org secret, a scoped deploy key, or a CLI token. */
export type CliAuth =
  | {
      accountId: Id<"accounts">;
      secretHash: string;
      scoped: boolean;
      deployKeyId?: Id<"deployKeys">;
    }
  | {
      accountId: Id<"accounts">;
      secretHash: string;
      scoped: true;
      cliTokenId: Id<"cliTokens">;
      cliAuthId: string;
    };

export type RouteParts =
  | { kind: "manifest"; project: string; stage: string }
  | { kind: "logs"; project: string; stage: string }
  | { kind: "runtimeKey"; project: string; stage: string }
  | { kind: "envList"; project: string; stage: string }
  | { kind: "env"; project: string; stage: string; name: string }
  | {
      kind: "resource";
      project: string;
      stage: string;
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

type ExternalIds = Pick<
  GeneratedIds,
  "skills" | "tools" | "hooks" | "mcpServers"
>;

/** GET the stage's env names/digests; values never leave the store. */
export async function handleEnvListRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "envList" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const variables = await ctx.runQuery(internal.cli.sync.listEnvBySecretHash, {
    secretHash: auth.secretHash,
    project: route.project,
    stage: route.stage,
  });

  return json({ variables: variables });
}

/** One env variable: GET reveals (audited), PUT sets, DELETE removes. */
export async function handleEnvRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "env" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method === "GET") {
    const result = await ctx.runMutation(internal.cli.sync.getEnvBySecretHash, {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
      name: route.name,
      revealedByCliTokenId: "cliTokenId" in auth ? auth.cliTokenId : undefined,
      revealedByCliAuthId: "cliAuthId" in auth ? auth.cliAuthId : undefined,
      revealedByDeployKeyId:
        "deployKeyId" in auth ? auth.deployKeyId : undefined,
    });

    return result
      ? json(result)
      : json({ error: "Environment variable not found" }, 404);
  }

  if (req.method === "DELETE") {
    const result = await ctx.runMutation(
      internal.cli.sync.removeEnvBySecretHash,
      {
        secretHash: auth.secretHash,
        project: route.project,
        stage: route.stage,
        name: route.name,
      },
    );

    return json({ removed: result.removed });
  }

  if (req.method === "PUT") {
    const body = (await req.json()) as { value?: unknown };
    if (typeof body.value !== "string") {
      return json({ error: "Request body must include string value" }, 400);
    }
    await ctx.runMutation(internal.cli.sync.setEnvBySecretHash, {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
      name: route.name,
      value: body.value,
    });

    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

/** Log streaming moved to the gateway observability WebSocket; keep the 410. */
export function handleLogsRoute(req: Request): Response {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  // Logs now stream via the gateway (NATS live tail + Loki backfill).
  // Use wss://gateway.broods.app/v1/<project>/<stage>/observability/ws instead.
  return json(
    {
      error: "Log streaming has moved to the gateway observability WebSocket",
    },
    410,
  );
}

/** Manifest read on GET; full desired-state sync (with prune) on PUT. */
export async function handleManifestRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "manifest" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method === "GET") {
    const result = await ctx.runQuery(
      internal.cli.sync.getManifestBySecretHash,
      {
        secretHash: auth.secretHash,
        project: route.project,
        stage: route.stage,
      },
    );

    return result ? json(result) : json({ error: "Manifest not found" }, 404);
  }
  if (req.method === "PUT")
    return await handleManifestSync(ctx, req, route, auth);

  return json({ error: "Method not allowed" }, 405);
}

/** DELETE one manifest-managed resource by kind and name. */
export async function handleResourceDeleteRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "resource" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "DELETE")
    return json({ error: "Method not allowed" }, 405);
  if (route.resourceKind === "cron") {
    await deleteCronByName(ctx, auth.accountId, route.name);
  } else {
    await ctx.runMutation(internal.cli.sync.deleteResourceBySecretHash, {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
      kind: route.resourceKind,
      name: route.name,
    });
  }

  return json({ deleted: true });
}

/** GET (minting when absent) the stage's runtime API key for reconnects. */
export async function handleRuntimeKeyRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "runtimeKey" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  // Reconnect path: recover the existing runtime key (minting one if the
  // stage has none yet) so the CLI can write BROODS_API_KEY
  // without a redeploy.
  const deployment = await ctx.runMutation(
    internal.cli.sync.ensureRuntimeKeyBySecretHash,
    {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
    },
  );

  return deployment
    ? json({
        apiKey: deployment.apiKey,
        keyHint: deployment.keyHint,
        endpointId: deployment.endpointId,
        projectSlug: deployment.projectSlug,
        stageSlug: deployment.stageSlug,
      })
    : json({ error: "Project or stage not found" }, 404);
}

/** Serialize a JSON response body with the given status. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  return value as Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} config must be an object`);
  }

  return value as Record<string, unknown>;
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

function cronBody(job: DesiredCron): Record<string, unknown> {
  const body: Record<string, unknown> = { ...job };
  delete body.resourceName;

  return stripUndefined(body);
}

function cronEvents(config: Record<string, unknown>, label: string): unknown[] {
  if (Array.isArray(config.events) && config.events.length > 0)
    return config.events;
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

/**
 * Delete a manifest-managed cron job by its configured name, if present.
 */
async function deleteCronByName(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  name: string,
): Promise<void> {
  const existing = await ctx.runQuery(internal.agent.crons.list, {
    accountId: accountId,
  });
  const cron = existing.find((job) => job.name === name);
  if (!cron) return;
  await ctx.runMutation(internal.agent.crons.remove, {
    accountId: accountId,
    cronId: cron._id,
  });
}

function desiredCrons(
  manifest: CliManifest,
  agentIds: Record<string, string>,
): DesiredCron[] {
  return manifest.resources
    .filter((resource) => resource.kind === "cron")
    .map((resource) => {
      const config = asRecord(resource.config, `cron:${resource.name}`);
      const localAgentName = stringField(
        config.agentId,
        `cron:${resource.name}.agentId`,
      );
      const agentId = agentIds[localAgentName];
      if (!agentId)
        throw new Error(
          `Cron job ${resource.name} references unknown deployed agent: ${localAgentName}`,
        );

      return stripUndefined({
        resourceName: resource.name,
        name: stringField(config.name, `cron:${resource.name}.name`),
        description: optionalStringField(
          config.description ?? resource.description,
        ),
        agentId: agentId,
        events: cronEvents(config, `cron:${resource.name}`),
        conversationKey: optionalStringField(config.conversationKey),
        scheduleExpression: stringField(
          config.scheduleExpression,
          `cron:${resource.name}.scheduleExpression`,
        ),
        timezone: optionalStringField(config.timezone),
        status: cronStatus(config.status),
      });
    });
}

/** PUT `/manifest`: sync external resources, the manifest, skills files, crons. */
async function handleManifestSync(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "manifest" }>,
  auth: CliAuth,
): Promise<Response> {
  const secretHash = auth.secretHash;
  const accountId = auth.accountId;
  const body = (await req.json()) as {
    manifest?: unknown;
    prune?: boolean;
    rotateRuntimeKey?: boolean;
  };
  const manifest = body.manifest;
  if (!manifest || typeof manifest !== "object") {
    return json({ error: "Request body must include manifest" }, 400);
  }
  if (!manifestMatchesRoute(manifest, route)) {
    return json(
      { error: "Manifest project/stage must match the request path" },
      400,
    );
  }
  const prune = body.prune === true;
  const originalManifest = manifest as CliManifest;
  const scope = await ctx.runMutation(
    internal.cli.sync.ensureScopeBySecretHash,
    {
      secretHash: secretHash,
      project: route.project,
      stage: route.stage,
    },
  );
  const externalIds = await syncExternalResources(
    ctx,
    accountId,
    scope,
    originalManifest,
    prune,
  );
  await ctx.runMutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: secretHash,
    project: route.project,
    stage: route.stage,
    resources: originalManifest.resources as never,
    ids: externalIds,
    prune: prune,
  });
  const syncManifest = rewriteExternalResourceRefs(
    originalManifest,
    externalIds,
  );
  const result = await ctx.runMutation(
    internal.cli.sync.syncManifestBySecretHash,
    {
      secretHash: secretHash,
      manifest: syncManifest as never,
      prune: prune,
    },
  );
  await syncSkillNodeFiles(ctx, {
    secretHash: secretHash,
    project: route.project,
    stage: route.stage,
    manifest: originalManifest,
  });

  const cronIds = await syncCrons(
    ctx,
    accountId,
    syncManifest,
    result.ids,
    prune,
  );
  const refreshed = await ctx.runQuery(
    internal.cli.sync.getManifestBySecretHash,
    {
      secretHash: secretHash,
      project: route.project,
      stage: route.stage,
    },
  );

  // Ensure the stage has a recoverable runtime API key so the CLI
  // can write BROODS_API_KEY locally on first or later deploys.
  const deployment = await ctx.runMutation(
    internal.cli.sync.ensureRuntimeKeyBySecretHash,
    {
      secretHash: secretHash,
      project: route.project,
      stage: route.stage,
      rotate: body.rotateRuntimeKey === true,
      auditSync: {
        resourceCount: originalManifest.resources.length,
        prune: prune,
        actorKind: "deployKeyId" in auth ? "deployKey" : "cli",
        actorId:
          "deployKeyId" in auth
            ? auth.deployKeyId
            : "cliTokenId" in auth
              ? auth.cliTokenId
              : accountId,
      },
    },
  );

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

function manifestMatchesRoute(
  manifest: unknown,
  route: Extract<RouteParts, { kind: "manifest" }>,
): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const candidate = manifest as { project?: unknown; stage?: unknown };

  return candidate.project === route.project && candidate.stage === route.stage;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function rewriteExternalConfigRefs(
  config: Record<string, unknown>,
  ids: ExternalIds,
): Record<string, unknown> {
  const result = { ...config };
  if (
    asOptionalRecord(result.skills) &&
    Array.isArray(asOptionalRecord(result.skills)?.allowed)
  ) {
    const skills = asOptionalRecord(result.skills)!;
    result.skills = {
      ...skills,
      allowed: (skills.allowed as unknown[]).map((entry) =>
        typeof entry === "string" && ids.skills[entry]
          ? ids.skills[entry]
          : entry,
      ),
    };
  }
  const tools = asOptionalRecord(result.tools);
  if (tools) {
    result.tools = remapKeys(tools, ids.tools);
  }
  const mcpServers = asOptionalRecord(result.mcpServers);
  if (mcpServers) {
    result.mcpServers = remapKeys(mcpServers, ids.mcpServers);
  }
  if (
    asOptionalRecord(result.hooks) &&
    Array.isArray(asOptionalRecord(result.hooks)?.code)
  ) {
    const hooks = asOptionalRecord(result.hooks)!;
    result.hooks = {
      ...hooks,
      code: (hooks.code as unknown[]).map((entry) => {
        if (!asOptionalRecord(entry)) return entry;
        const hook = asOptionalRecord(entry)!;
        const hookId =
          typeof hook.hookId === "string" && ids.hooks[hook.hookId]
            ? ids.hooks[hook.hookId]
            : hook.hookId;

        return { ...hook, hookId: hookId };
      }),
    };
  }

  return result;
}

function rewriteExternalResourceRefs(
  manifest: CliManifest,
  ids: ExternalIds,
): CliManifest {
  return {
    ...manifest,
    resources: manifest.resources.map((resource) => {
      if (resource.kind !== "agent") return resource;

      return {
        ...resource,
        config: rewriteExternalConfigRefs(
          asRecord(resource.config, `agent:${resource.name}`),
          ids,
        ),
      };
    }),
  };
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);

  return value;
}

/**
 * Reconcile manifest cron resources against the account's cron jobs using the
 * transactional cron mutations in agent/crons.
 */
async function syncCrons(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  manifest: CliManifest,
  ids: GeneratedIds,
  prune: boolean,
): Promise<Record<string, string>> {
  const desired = desiredCrons(manifest, ids.agents ?? {});
  if (desired.length === 0 && prune !== true) return {};
  const existing = await ctx.runQuery(internal.agent.crons.list, {
    accountId: accountId,
  });
  const existingByName = new Map(existing.map((job) => [job.name, job]));
  const desiredNames = new Set(desired.map((job) => job.name));
  const cronIds: Record<string, string> = {};

  for (const job of desired) {
    const existingJob = existingByName.get(job.name);
    if (existingJob) {
      await ctx.runMutation(internal.agent.crons.update, {
        accountId: accountId,
        cronId: existingJob._id,
        patch: cronBody(job),
      });
      cronIds[job.resourceName] = existingJob._id;
    } else {
      const created = (await ctx.runMutation(internal.agent.crons.create, {
        accountId: accountId,
        input: cronBody(job),
      })) as { cronId: string };
      cronIds[job.resourceName] = created.cronId;
    }
  }

  if (prune === true) {
    const stageAgentIds = new Set<string>(Object.values(ids.agents ?? {}));
    for (const job of existing) {
      if (!stageAgentIds.has(job.agentId) || desiredNames.has(job.name))
        continue;
      await ctx.runMutation(internal.agent.crons.remove, {
        accountId: accountId,
        cronId: job._id,
      });
    }
  }

  return cronIds;
}

async function syncExternalResources(
  ctx: ActionCtx,
  accountId: string,
  scope: ProjectStageScope,
  manifest: CliManifest,
  prune: boolean,
): Promise<ExternalIds> {
  const hasExternalResources = manifest.resources.some((entry) =>
    isExternalResourceKind(entry.kind),
  );
  if (!hasExternalResources)
    return { skills: {}, tools: {}, hooks: {}, mcpServers: {} };

  const skills = await syncSkillResources(
    ctx,
    accountId as Id<"accounts">,
    manifest,
  );
  const tools = await syncToolResources(
    ctx,
    accountId as Id<"accounts">,
    scope,
    manifest,
    prune,
  );
  const hooks = await syncHookResources(
    ctx,
    accountId as Id<"accounts">,
    manifest,
    prune,
  );
  const mcpServers = await syncMcpResources(
    ctx,
    accountId as Id<"accounts">,
    scope,
    manifest,
    prune,
  );

  return { skills: skills, tools: tools, hooks: hooks, mcpServers: mcpServers };
}

async function syncHookResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  manifest: CliManifest,
  prune: boolean,
): Promise<Record<string, string>> {
  const desired = manifest.resources.filter((entry) => entry.kind === "hook");
  if (desired.length === 0) return {};
  const existingHooks = await ctx.runQuery(internal.account.hooks.list, {
    accountId: accountId,
  });
  const existing = new Map(existingHooks.map((hook) => [hook.name, hook]));
  const desiredNames = new Set(desired.map((resource) => resource.name));
  const ids: Record<string, string> = {};

  for (const resource of desired) {
    const config = asRecord(resource.config, `hook:${resource.name}`);
    const events = config.events;
    if (!Array.isArray(events))
      throw new Error(`hook:${resource.name}.events must be an array`);
    const upload = await normalizeAccountHookUpload(
      {
        name: resource.name,
        ...(config.description !== undefined ||
        resource.description !== undefined
          ? {
              description: stringField(
                config.description ?? resource.description,
                `hook:${resource.name}.description`,
              ),
            }
          : {}),
        events: events,
        bundle: stringField(config.bundle, `hook:${resource.name}.bundle`),
      },
      { requireBundle: true },
    );
    const current = existing.get(resource.name);
    const bundleStorageKey =
      current?.sha256 === upload.sha256
        ? current.bundleStorageKey
        : await putHookBundle(ctx, {
            accountId: accountId,
            sha256: upload.sha256,
            bundle: upload.bundle,
          });
    if (current) {
      await ctx.runMutation(internal.account.hooks.update, {
        accountId: accountId,
        hookId: current._id,
        name: upload.name,
        ...(upload.description !== undefined
          ? { description: upload.description }
          : {}),
        events: upload.events,
        bundleStorageKey: bundleStorageKey,
        sha256: upload.sha256,
      });
      ids[resource.name] = current._id;
    } else {
      const hookId = await ctx.runMutation(internal.account.hooks.create, {
        accountId: accountId,
        name: upload.name,
        ...(upload.description !== undefined
          ? { description: upload.description }
          : {}),
        events: upload.events,
        bundleStorageKey: bundleStorageKey,
        sha256: upload.sha256,
      });
      ids[resource.name] = hookId;
    }
  }

  if (prune === true) {
    for (const hook of existing.values()) {
      if (!desiredNames.has(hook.name)) {
        await ctx.runMutation(internal.account.hooks.remove, {
          accountId: accountId,
          hookId: hook._id,
        });
      }
    }
  }

  return ids;
}

/**
 * Upsert the manifest's MCP server registrations by name within the stage, and
 * prune rows whose name is no longer desired (#331). A hosted server's bundle
 * is content-addressed and re-uploads only when its sha256 changed.
 */
async function syncMcpResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  scope: ProjectStageScope,
  manifest: CliManifest,
  prune: boolean,
): Promise<Record<string, string>> {
  const desired = manifest.resources.filter((entry) => entry.kind === "mcp");
  if (desired.length === 0) return {};
  const existingServers = await ctx.runQuery(
    internal.account.mcp.listForStage,
    {
      stageId: scope.stageId,
    },
  );
  const existing = new Map(
    existingServers.map((server) => [server.name, server]),
  );
  const desiredNames = new Set(desired.map((resource) => resource.name));
  const ids: Record<string, string> = {};

  for (const resource of desired) {
    const config = asRecord(resource.config, `mcp:${resource.name}`);
    const input = await normalizeMcpInput(
      {
        name: resource.name,
        ...(resource.description !== undefined
          ? { description: resource.description }
          : {}),
        ...config,
      },
      { requireConnection: true },
    );
    const current = existing.get(resource.name);
    const bundleStorageKey = await storeMcpBundle(
      ctx,
      accountId,
      input,
      current ?? null,
    );
    const patch = {
      name: input.name!,
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(bundleStorageKey !== undefined
        ? { bundleStorageKey: bundleStorageKey, sha256: input.sha256! }
        : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.allowedTools !== undefined
        ? { allowedTools: input.allowedTools }
        : {}),
    };
    if (current) {
      // An identical patch is skipped: a write would bump updatedAt, which is
      // core's MCP cache identity, and re-probe every server on the next run.
      const row = current as unknown as Record<string, unknown>;
      const unchanged = Object.entries(patch).every(
        ([key, value]) => stableJson(value) === stableJson(row[key]),
      );
      if (!unchanged) {
        await ctx.runMutation(internal.account.mcp.update, {
          accountId: accountId,
          serverId: current._id,
          ...patch,
        });
      }
      ids[resource.name] = current._id;
    } else {
      const serverId = await ctx.runMutation(internal.account.mcp.create, {
        accountId: accountId,
        projectId: scope.projectId,
        stageId: scope.stageId,
        ...patch,
      });
      ids[resource.name] = serverId;
    }
  }

  if (prune === true) {
    for (const server of existing.values()) {
      if (!desiredNames.has(server.name)) {
        await ctx.runMutation(internal.account.mcp.remove, {
          accountId: accountId,
          serverId: server._id,
        });
      }
    }
  }

  return ids;
}

/**
 * Stores CLI-bundled skill files in Convex storage and mirrors them into workspaceFiles.
 */
async function syncSkillNodeFiles(
  ctx: ActionCtx,
  options: {
    secretHash: string;
    project: string;
    stage: string;
    manifest: CliManifest;
  },
): Promise<void> {
  for (const resource of options.manifest.resources.filter(
    (entry) => entry.kind === "skill",
  )) {
    const config = asRecord(resource.config, `skill:${resource.name}`);
    const files = config.files;
    if (!Array.isArray(files)) continue;
    const storedFiles = [];
    for (const entry of files) {
      const file = asRecord(entry, `skill:${resource.name}.files[]`);
      const path = stringField(
        file.path,
        `skill:${resource.name}.files[].path`,
      );
      const contentBase64 = stringField(
        file.contentBase64,
        `skill:${resource.name}.files[].contentBase64`,
      );
      const mimeType =
        typeof file.contentType === "string" ? file.contentType : "text/plain";
      const bytes = base64ArrayBuffer(contentBase64);
      const storageId = await ctx.storage.store(
        new Blob([bytes], { type: mimeType }),
      );
      const parts = path.split("/");
      storedFiles.push({
        path: path,
        name: parts[parts.length - 1] || path,
        storageId: storageId,
        mimeType: mimeType,
        sizeBytes: bytes.byteLength,
      });
    }

    await ctx.runMutation(internal.cli.sync.replaceSkillNodeFilesBySecretHash, {
      secretHash: options.secretHash,
      project: options.project,
      stage: options.stage,
      skillName: resource.name,
      files: storedFiles,
    });
  }
}

async function syncSkillResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  manifest: CliManifest,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const resource of manifest.resources.filter(
    (entry) => entry.kind === "skill",
  )) {
    const config = asRecord(resource.config, `skill:${resource.name}`);
    const files = config.files;
    if (!Array.isArray(files))
      throw new Error(`skill:${resource.name}.files must be an array`);
    const skill = await ctx.runAction(internal.aws.skills.createSkill, {
      accountId: accountId,
      expectedName: resource.name,
      input: { source: "files", files: files },
    });
    ids[resource.name] = skill.path;
  }

  return ids;
}

async function syncToolResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  scope: ProjectStageScope,
  manifest: CliManifest,
  prune: boolean,
): Promise<Record<string, string>> {
  const desired = manifest.resources.filter((entry) => entry.kind === "tool");
  if (desired.length === 0) return {};
  // Scoped to the stage, not the account: two projects may each define a
  // tool called `system_report` without overwriting one another.
  const existingTools = await ctx.runQuery(
    internal.account.tools.listForStage,
    {
      stageId: scope.stageId,
    },
  );
  const existing = new Map(existingTools.map((tool) => [tool.name, tool]));
  const desiredNames = new Set(desired.map((resource) => resource.name));
  const ids: Record<string, string> = {};

  for (const resource of desired) {
    const config = asRecord(resource.config, `tool:${resource.name}`);
    const upload = await normalizeAccountToolUpload(
      {
        name: resource.name,
        description: stringField(
          config.description ?? resource.description,
          `tool:${resource.name}.description`,
        ),
        inputSchema: asRecord(
          config.inputSchema,
          `tool:${resource.name}.inputSchema`,
        ),
        ...(config.runtime !== undefined
          ? {
              runtime: stringField(
                config.runtime,
                `tool:${resource.name}.runtime`,
              ),
            }
          : {}),
        ...(config.defaultConfig !== undefined
          ? {
              defaultConfig: asRecord(
                config.defaultConfig,
                `tool:${resource.name}.defaultConfig`,
              ),
            }
          : {}),
        bundle: stringField(config.bundle, `tool:${resource.name}.bundle`),
      },
      { requireBundle: true },
    );
    const current = existing.get(resource.name);
    const bundleStorageKey =
      current?.sha256 === upload.sha256
        ? current.bundleStorageKey
        : await putToolBundle(ctx, {
            accountId: accountId,
            sha256: upload.sha256,
            bundle: upload.bundle,
          });
    if (current) {
      await ctx.runMutation(internal.account.tools.update, {
        accountId: accountId,
        toolId: current._id,
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
      ids[resource.name] = current._id;
    } else {
      const toolId = await ctx.runMutation(internal.account.tools.create, {
        accountId: accountId,
        projectId: scope.projectId,
        stageId: scope.stageId,
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
      ids[resource.name] = toolId;
    }
  }

  if (prune === true) {
    for (const tool of existing.values()) {
      if (!desiredNames.has(tool.name)) {
        await ctx.runMutation(internal.account.tools.remove, {
          accountId: accountId,
          toolId: tool._id,
        });
      }
    }
  }

  return ids;
}

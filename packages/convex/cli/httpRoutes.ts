/**
 * Route handlers for the CLI HTTP surface (`cli/http.ts` is the router).
 * One exported handler per route kind, plus the external-resource sync helpers
 * (skills/hooks/mcp bundles, cron reconciliation) the manifest PUT drives.
 */

import type { FunctionArgs } from "convex/server";
import { type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CliManifest, GeneratedIds } from "./types";
import { terminateReservedInstances } from "../config/routes/shared";
import {
  isExternalResourceKind,
  placeholderIds,
  resourceName,
  type ExternalResourceKind,
} from "../model/cliSync";
import { reservedBy } from "../model/cliSyncResources";
import {
  normalizeAccountHookUpload,
  type RequiredAccountHookUpload,
} from "../model/accountHooks";
import { assertMcpRow, normalizeMcpInput, type McpInput } from "../model/mcp";
import { normalizeCreateCronInput } from "../model/cronRules";
import { putHookBundle, storeMcpBundle } from "../model/bundles";
import { remapKeys, stableJson, stripUndefined } from "../model/objects";
import type { ProjectStageScope } from "../model/projectScope";
import { uploadQuotaResponse } from "../model/uploads";
import { json, jsonError, methodNotAllowed } from "../model/httpJson";
import { ClientError } from "../model/clientError";

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
  | { kind: "mcpBundleUpload"; project: string; stage: string }
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

type DesiredCron = Omit<CronResponse, "cronId">;

/** What a prune or single delete is about to remove, as the query names it. */
type DeleteTarget = FunctionArgs<
  typeof internal.cli.sync.deleteTargetsBySecretHash
>["target"];

type ExternalIds = Pick<GeneratedIds, "skills" | "hooks" | "mcp">;

/**
 * `kind:name` of every external resource another stage of the account
 * manages. Skills and hooks are account-wide rows keyed by name, so this set
 * is what keeps a stage-scoped deploy key from replacing them.
 */
type ForeignExternalResources = ReadonlySet<string>;

/** A manifest's skills, hooks and MCP servers, checked before any is stored. */
type PreparedExternal = {
  skills: Array<{ name: string; files: unknown[] }>;
  hooks: Array<{ name: string; upload: RequiredAccountHookUpload }>;
  mcp: Array<{ name: string; input: McpInput }>;
};

/**
 * Who manages the account's external resources. `owned` maps, per kind, each
 * name this stage records and no other stage does to the row it recorded: the
 * only rows a prune removes. MCP servers are stage rows, so another stage's
 * record never disowns one.
 */
type ExternalOwnership = {
  foreign: ForeignExternalResources;
  owned: Record<ExternalResourceKind, ReadonlyMap<string, string>>;
};

/**
 * Refuse to create or replace an account-wide resource whose name is
 * recorded as managed by a different stage.
 */
export function assertNotForeign(
  foreign: ForeignExternalResources,
  kind: "skill" | "hook",
  name: string,
): void {
  if (!foreign.has(`${kind}:${name}`)) return;
  throw new ClientError(
    `${kind}:${name} is managed by another stage of this account and cannot be changed from this one`,
    "conflict",
  );
}

/** GET the stage's env names/digests; values never leave the store. */
export async function handleEnvListRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "envList" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
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
    // A deploy key deploys; it does not carry the stage's secrets out. Reveal
    // stays with a person (`broods login`) or the org secret.
    if ("deployKeyId" in auth) {
      return jsonError(
        403,
        "Deploy keys cannot read environment values; use `broods login` or the org secret",
      );
    }
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
      : jsonError(404, "Environment variable not found");
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
      return jsonError(400, "Request body must include string value");
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

  return methodNotAllowed(["GET", "DELETE", "PUT"]);
}

export function handleLogsRoute(req: Request): Response {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  // Logs now stream via the gateway (NATS live tail + Loki backfill).
  // Use wss://gateway.broods.app/v1/projects/<project>/stages/<stage>/observability/ws instead.
  return jsonError(
    410,
    "Log streaming has moved to the gateway observability WebSocket",
  );
}

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

    return result ? json(result) : jsonError(404, "Manifest not found");
  }
  if (req.method === "PUT")
    return await handleManifestSync(ctx, req, route, auth);

  return methodNotAllowed(["GET", "PUT"]);
}

/**
 * Mint a storage upload URL for a large hosted-MCP bundle (#190); the CLI
 * passes the returned storage id as `bundleStorageId` in the manifest.
 * Minting counts against the account's hourly upload quota.
 */
export async function handleMcpBundleUploadRoute(
  ctx: ActionCtx,
  req: Request,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const grant = await ctx.runMutation(internal.account.uploads.grant, {
    accountId: auth.accountId,
    kind: "mcp",
  });
  if ("retryAt" in grant) {
    return uploadQuotaResponse(grant.retryAt);
  }

  return json({ uploadUrl: grant.uploadUrl });
}

export async function handleResourceDeleteRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "resource" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  if (route.resourceKind === "cron") {
    await deleteCronByName(ctx, auth, route);
  } else {
    if (route.resourceKind !== "agent") {
      await terminateDoomedInstances(ctx, auth, route, {
        kind: route.resourceKind,
        name: route.name,
      });
    }
    const result = await ctx.runMutation(
      internal.cli.sync.deleteResourceBySecretHash,
      {
        secretHash: auth.secretHash,
        project: route.project,
        stage: route.stage,
        kind: route.resourceKind,
        name: route.name,
      },
    );
    if (result.reserved) {
      return jsonError(
        409,
        `Sandbox "${route.name}" still has a reserved instance that could not be terminated. ` +
          "Terminate it from the dashboard, then retry.",
        { code: "sandbox_instance_reserved" },
      );
    }
  }

  return json({ deleted: true });
}

export async function handleRuntimeKeyRoute(
  ctx: ActionCtx,
  req: Request,
  route: Extract<RouteParts, { kind: "runtimeKey" }>,
  auth: CliAuth,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

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
    : jsonError(404, "Project or stage not found");
}

/**
 * Crons are account-wide rows but a job belongs to the stage of the agent it
 * targets, so a name is matched only among this stage's agents. A same-named
 * job of another stage is neither touched nor a conflict; null means create.
 */
export function stageCronByName<T extends { name: string; agentId: string }>(
  existing: T[],
  stageAgentIds: Set<string>,
  name: string,
): T | null {
  return (
    existing.find(
      (job) => job.name === name && stageAgentIds.has(job.agentId),
    ) ?? null
  );
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  return value as Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientError(`${label} config must be an object`);
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

function cronEvents(config: Record<string, unknown>, label: string): unknown[] {
  if (Array.isArray(config.events) && config.events.length > 0)
    return config.events;
  if (typeof config.prompt === "string" && config.prompt.trim()) {
    return [{ role: "user", content: [{ type: "text", text: config.prompt }] }];
  }

  throw new ClientError(`${label}.events must be a non-empty array`);
}

function cronStatus(value: unknown): "active" | "paused" {
  if (value === undefined) return "active";
  if (value === "active" || value === "paused") return value;
  throw new ClientError("Cron job status must be active or paused");
}

// Matches only this stage's crons: a deploy key pinned to dev must not delete
// production's job of the same name.
async function deleteCronByName(
  ctx: ActionCtx,
  auth: CliAuth,
  route: Extract<RouteParts, { kind: "resource" }>,
): Promise<void> {
  const [stage, existing] = await Promise.all([
    ctx.runQuery(internal.cli.sync.getManifestBySecretHash, {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
    }),
    ctx.runQuery(internal.agent.crons.list, { accountId: auth.accountId }),
  ]);
  if (!stage) return;
  const stageAgentIds = new Set<string>(Object.values(stage.ids.agents ?? {}));
  const cron = stageCronByName(existing, stageAgentIds, route.name);
  if (!cron) return;
  await ctx.runMutation(internal.agent.crons.remove, {
    accountId: auth.accountId,
    cronId: cron._id,
  });
}

/**
 * The manifest's crons, keyed by resource name. `legacyName` is a different
 * `config.name` an older sync may have created the cron under.
 */
function desiredCrons(
  manifest: CliManifest,
  agentIds: Record<string, string>,
): Array<{ job: DesiredCron; legacyName?: string }> {
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
        throw new ClientError(
          `Cron job ${resource.name} references unknown deployed agent: ${localAgentName}`,
        );

      // A cron is keyed by its resource name, the key the diff and the
      // generated ids use, whatever `config.name` says.
      const job = stripUndefined({
        name: resource.name,
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
      const legacyName = optionalStringField(config.name);

      return legacyName && legacyName !== resource.name
        ? { job: job, legacyName: legacyName }
        : { job: job };
    });
}

async function externalOwnership(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  stageId: Id<"stages">,
): Promise<ExternalOwnership> {
  const rows = await ctx.runQuery(
    internal.cli.sync.listExternalResourcesForAccount,
    { accountId: accountId },
  );
  const foreign = new Set(
    rows
      .filter((row) => row.stageId !== stageId)
      .map((row) => `${row.kind}:${row.name}`),
  );
  const owned: Record<ExternalResourceKind, Map<string, string>> = {
    skill: new Map(),
    hook: new Map(),
    mcp: new Map(),
  };
  for (const row of rows) {
    if (
      row.stageId === stageId &&
      (row.kind === "mcp" || !foreign.has(`${row.kind}:${row.name}`))
    )
      owned[row.kind].set(row.name, row.externalId);
  }

  return { foreign: foreign, owned: owned };
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
    revision?: unknown;
  };
  const manifest = body.manifest;
  if (!manifest || typeof manifest !== "object") {
    return jsonError(400, "Request body must include manifest");
  }
  if (!manifestMatchesRoute(manifest, route)) {
    return jsonError(400, "Manifest project/stage must match the request path");
  }
  if (
    body.revision !== undefined &&
    (typeof body.revision !== "number" || !Number.isInteger(body.revision))
  ) {
    return jsonError(400, "revision must be an integer");
  }
  const prune = body.prune === true;
  const originalManifest = manifest as CliManifest;
  const scope = await ctx.runMutation(
    internal.cli.sync.ensureScopeBySecretHash,
    {
      secretHash: secretHash,
      project: route.project,
      stage: route.stage,
      revision: body.revision,
    },
  );
  // Skills and hooks are account-wide, so the org secret and a login token
  // may move a name between stages (dev then deploy). Only a stage-scoped
  // deploy key is fenced to the names another stage recorded, read before this
  // sync records anything.
  const fenced = "deployKeyId" in auth;
  const foreign =
    fenced &&
    originalManifest.resources.some((entry) =>
      isExternalResourceKind(entry.kind),
    )
      ? (await externalOwnership(ctx, accountId, scope.stageId)).foreign
      : new Set<string>();
  // The manifest's rules run before the first write, so a manifest they
  // refuse leaves the stage's skills, hooks and MCP servers as they were.
  const external = await prepareExternalResources(
    ctx,
    originalManifest,
    foreign,
  );
  await validateManifest(ctx, scope, originalManifest);
  const externalIds = await syncExternalResources(
    ctx,
    accountId,
    scope,
    external,
  );
  const recordExternal = (pruneRecords: boolean): Promise<null> =>
    ctx.runMutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
      secretHash: secretHash,
      project: route.project,
      stage: route.stage,
      resources: originalManifest.resources as never,
      ids: externalIds,
      prune: pruneRecords,
    });
  await recordExternal(false);
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
  let reservedResources: string[] = [];
  if (prune) {
    // Only once the manifest synced, so a rejected deploy removes nothing, and
    // with ownership read now, so a name another stage recorded meanwhile is
    // not this stage's to remove.
    const { owned } = await externalOwnership(ctx, accountId, scope.stageId);
    await pruneExternalResources(ctx, {
      accountId: accountId,
      stageId: scope.stageId,
      manifest: originalManifest,
      owned: owned,
      secretHash: secretHash,
    });
    await recordExternal(true);
    await terminateDoomedInstances(ctx, auth, route, {
      resources: syncManifest.resources,
    });
    reservedResources = await ctx.runMutation(
      internal.cli.sync.pruneSandboxesBySecretHash,
      {
        secretHash: secretHash,
        manifest: syncManifest,
      },
    );
  }
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

  // Mint or reuse the stage's recoverable runtime API key so the CLI
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
        actorKind: fenced ? "deployKey" : "cli",
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
    warnings: { ...result.warnings, reservedResources: reservedResources },
    deployment: deployment,
    // This sync's own revision: a later sync may already have claimed the next.
    revision: scope.revision,
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

/**
 * Removes the skills, hooks and MCP servers this stage recorded and the
 * manifest no longer declares. Runs after the manifest synced. Hooks and MCP
 * servers go by the row the stage recorded, so a row another stage or the
 * dashboard made, even under the same name, is never removed.
 */
async function pruneExternalResources(
  ctx: ActionCtx,
  options: {
    accountId: Id<"accounts">;
    stageId: Id<"stages">;
    manifest: CliManifest;
    owned: ExternalOwnership["owned"];
    secretHash: string;
  },
): Promise<void> {
  const { accountId, manifest, owned, secretHash, stageId } = options;
  const declared = new Set(
    manifest.resources.map(
      (entry) => `${entry.kind}:${resourceName(entry.name)}`,
    ),
  );
  const undeclared = (kind: ExternalResourceKind): Map<string, string> =>
    new Map(
      [...owned[kind]].filter(([name]) => !declared.has(`${kind}:${name}`)),
    );
  const skills = undeclared("skill");
  const hookIds = new Set(undeclared("hook").values());
  const serverIds = new Set(undeclared("mcp").values());

  for (const name of skills.keys()) {
    await ctx.runAction(internal.aws.skills.remove, {
      accountId: accountId,
      skillName: name,
    });
    // An empty replace drops the files `syncSkillNodeFiles` mirrored.
    await ctx.runMutation(internal.cli.sync.replaceSkillNodeFilesBySecretHash, {
      secretHash: secretHash,
      project: manifest.project,
      stage: manifest.stage,
      skillName: name,
      files: [],
    });
  }
  if (hookIds.size > 0) {
    const rows = await ctx.runQuery(internal.account.hooks.list, {
      accountId: accountId,
    });
    for (const hook of rows.filter((row) => hookIds.has(row._id))) {
      await ctx.runMutation(internal.account.hooks.remove, {
        accountId: accountId,
        hookId: hook._id,
      });
    }
  }
  if (serverIds.size > 0) {
    const rows = await ctx.runQuery(internal.account.mcp.listForStage, {
      stageId: stageId,
    });
    for (const server of rows.filter((row) => serverIds.has(row._id))) {
      await ctx.runMutation(internal.account.mcp.remove, {
        accountId: accountId,
        serverId: server._id,
      });
    }
  }
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
  const mcp = asOptionalRecord(result.mcp);
  if (mcp) {
    result.mcp = remapKeys(mcp, ids.mcp);
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
    throw new ClientError(`${label} must be a non-empty string`);

  return value;
}

/** One CLI skill file, decoded the way the workspace mirror stores it. */
function skillNodeFile(
  entry: unknown,
  skillName: string,
): { path: string; mimeType: string; bytes: ArrayBuffer } {
  const file = asRecord(entry, `skill:${skillName}.files[]`);
  const path = stringField(file.path, `skill:${skillName}.files[].path`);
  const contentBase64 = stringField(
    file.contentBase64,
    `skill:${skillName}.files[].contentBase64`,
  );

  return {
    path: path,
    mimeType:
      typeof file.contentType === "string" ? file.contentType : "text/plain",
    bytes: base64ArrayBuffer(contentBase64),
  };
}

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
  const stageAgentIds = new Set<string>(Object.values(ids.agents ?? {}));
  const cronIds: Record<string, string> = {};
  // Every job's own name claims its cron before any legacy name can, and a
  // cron is claimed once.
  const own = desired.map(({ job }) =>
    stageCronByName(existing, stageAgentIds, job.name),
  );
  const kept = new Set<string>(own.flatMap((row) => (row ? [row._id] : [])));

  for (const [index, { job, legacyName }] of desired.entries()) {
    // Patching a cron found under its legacy name renames it in place.
    const existingJob =
      own[index] ??
      (legacyName
        ? stageCronByName(
            existing.filter((row) => !kept.has(row._id)),
            stageAgentIds,
            legacyName,
          )
        : undefined);
    if (existingJob) {
      kept.add(existingJob._id);
      await ctx.runMutation(internal.agent.crons.update, {
        accountId: accountId,
        cronId: existingJob._id,
        patch: job,
      });
      cronIds[job.name] = existingJob._id;
    } else {
      const created = (await ctx.runMutation(internal.agent.crons.create, {
        accountId: accountId,
        input: job,
      })) as { cronId: string };
      cronIds[job.name] = created.cronId;
    }
  }

  if (prune === true) {
    for (const job of existing) {
      if (!stageAgentIds.has(job.agentId) || kept.has(job._id)) continue;
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
  accountId: Id<"accounts">,
  scope: ProjectStageScope,
  external: PreparedExternal,
): Promise<ExternalIds> {
  const skills = await syncSkillResources(ctx, accountId, external.skills);
  const hooks = await syncHookResources(ctx, accountId, external.hooks);
  const mcp = await syncMcpResources(ctx, accountId, scope, external.mcp);

  return { skills: skills, hooks: hooks, mcp: mcp };
}

async function syncHookResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  desired: PreparedExternal["hooks"],
): Promise<Record<string, string>> {
  if (desired.length === 0) return {};
  const existingHooks = await ctx.runQuery(internal.account.hooks.list, {
    accountId: accountId,
  });
  const existing = new Map(existingHooks.map((hook) => [hook.name, hook]));
  const ids: Record<string, string> = {};

  for (const { name, upload } of desired) {
    const current = existing.get(name);
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
      ids[name] = current._id;
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
      ids[name] = hookId;
    }
  }

  return ids;
}

/**
 * Checks and normalizes the manifest's skills, hooks and MCP servers, all of
 * them before the first upload, so one bad entry cannot leave the others
 * written.
 */
async function prepareExternalResources(
  ctx: ActionCtx,
  manifest: CliManifest,
  foreign: ForeignExternalResources,
): Promise<PreparedExternal> {
  const skills = manifest.resources
    .filter((entry) => entry.kind === "skill")
    .map((resource) => {
      assertNotForeign(foreign, "skill", resource.name);
      const files = asRecord(resource.config, `skill:${resource.name}`).files;
      if (!Array.isArray(files))
        throw new ClientError(`skill:${resource.name}.files must be an array`);
      for (const entry of files) skillNodeFile(entry, resource.name);

      return { name: resource.name, files: files };
    });
  if (skills.length > 0) {
    await ctx.runAction(internal.aws.skills.validateSkills, { skills: skills });
  }
  const hooks: PreparedExternal["hooks"] = [];
  for (const resource of manifest.resources.filter(
    (entry) => entry.kind === "hook",
  )) {
    assertNotForeign(foreign, "hook", resource.name);
    const config = asRecord(resource.config, `hook:${resource.name}`);
    const events = config.events;
    if (!Array.isArray(events))
      throw new ClientError(`hook:${resource.name}.events must be an array`);
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
    hooks.push({ name: resource.name, upload: upload });
  }
  const mcp: PreparedExternal["mcp"] = [];
  for (const resource of manifest.resources.filter(
    (entry) => entry.kind === "mcp",
  )) {
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
    assertMcpRow({ ...input, transport: input.transport ?? "http" });
    mcp.push({ name: resource.name, input: input });
  }

  return { skills: skills, hooks: hooks, mcp: mcp };
}

/**
 * Upsert the manifest's MCP server registrations by name within the stage. A
 * hosted server's bundle is content-addressed and re-uploads only when its
 * sha256 changed.
 */
async function syncMcpResources(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  scope: ProjectStageScope,
  desired: PreparedExternal["mcp"],
): Promise<Record<string, string>> {
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
  const ids: Record<string, string> = {};

  for (const { name, input } of desired) {
    const current = existing.get(name);
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
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      ...(bundleStorageKey !== undefined
        ? { bundleStorageKey: bundleStorageKey, sha256: input.sha256! }
        : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.oauth !== undefined ? { oauth: input.oauth } : {}),
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
      ids[name] = current._id;
    } else {
      const serverId = await ctx.runMutation(internal.account.mcp.create, {
        accountId: accountId,
        projectId: scope.projectId,
        stageId: scope.stageId,
        ...patch,
      });
      ids[name] = serverId;
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
      const { path, mimeType, bytes } = skillNodeFile(entry, resource.name);
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
  desired: PreparedExternal["skills"],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const { name, files } of desired) {
    const skill = await ctx.runAction(internal.aws.skills.createSkill, {
      accountId: accountId,
      expectedName: name,
      input: { source: "files", files: files },
    });
    ids[name] = skill.path;
  }

  return ids;
}

/**
 * Terminate, through core, the reserved instances of the sandbox configs and
 * workspaces a prune or delete is about to drop. Must run while the rows still
 * exist: core's lifecycle route loads the sandbox config by id, and a
 * workspace's namespace is found through its row. A sandbox config whose
 * instance core did not remove is kept; a workspace is deleted regardless.
 */
async function terminateDoomedInstances(
  ctx: ActionCtx,
  auth: CliAuth,
  route: { project: string; stage: string },
  target: DeleteTarget,
): Promise<void> {
  const holders = await ctx.runQuery(
    internal.cli.sync.deleteTargetsBySecretHash,
    {
      secretHash: auth.secretHash,
      project: route.project,
      stage: route.stage,
      target: target,
    },
  );
  if (holders.length === 0) return;
  await terminateReservedInstances(ctx, auth.accountId, (instance): boolean =>
    holders.some((holder): boolean => reservedBy(instance, holder)),
  );
}

/**
 * Runs the manifest sync's and the cron sync's rules without writing. Rows the
 * sync would create get placeholder ids.
 */
async function validateManifest(
  ctx: ActionCtx,
  scope: ProjectStageScope,
  manifest: CliManifest,
): Promise<void> {
  const names = (kind: CliManifest["resources"][number]["kind"]): string[] =>
    manifest.resources
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.name);
  await ctx.runQuery(internal.cli.sync.validateManifestForStage, {
    projectId: scope.projectId,
    stageId: scope.stageId,
    manifest: rewriteExternalResourceRefs(manifest, {
      skills: placeholderIds(names("skill")),
      hooks: placeholderIds(names("hook")),
      mcp: placeholderIds(names("mcp")),
    }),
  });
  const agentNames = names("agent").map((name) => resourceName(name));
  for (const { job } of desiredCrons(manifest, placeholderIds(agentNames))) {
    normalizeCreateCronInput(job);
  }
}

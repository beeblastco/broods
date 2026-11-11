import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  LIVE_DEPLOYMENT_REGIONS,
  type CliManifestResource,
  type DeploymentRegion,
} from "../cli/types";
import { assertStageName, uniqueProjectSlug } from "../lib/slug";
import { kindForStageName } from "../stage";
import {
  assertEnvVarName,
  collectEnvPlaceholderNames,
  toNestedAgentConfig,
} from "./agentConfigCodec";
import type { AccountCipher } from "./envelope";
import { defaultSandboxOf } from "./agentRules";
import { parseInput } from "./inputSchema";
import { configObject, parseOr } from "./storedJson";
import { remapKeys } from "./objects";
import { resolveProject, stageNameEquals } from "./projectScope";
import {
  DISK_WORKSPACE_HINT,
  S3_MOUNT_PROVIDER_HINT,
  sandboxHoldsWorkspace,
  supportsS3WorkspaceMount,
} from "./sandboxProviders";
import {
  browserSandboxRefusal,
  DEFAULT_SANDBOX_PROVIDER,
} from "./sandboxRules";
import { ClientError } from "./clientError";

// Exceeds Convex's 30-minute HTTP action limit plus a 10-minute child Node action.
const MANIFEST_SYNC_TIMEOUT_MS = 45 * 60_000;

// Kinds the account service owns, snapshotted per stage in `cliExternalResources`.
export const EXTERNAL_RESOURCE_KINDS = ["skill", "hook", "mcp"] as const;

export type CliResource = CliManifestResource;

export type ExternalResourceKind = (typeof EXTERNAL_RESOURCE_KINDS)[number];

export async function accountFromSecretHash(
  ctx: QueryCtx | MutationCtx,
  secretHash: string,
): Promise<Doc<"accounts"> | null> {
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
    .unique();
  if (!account || account.status !== "active") return null;

  return account;
}

export function asObject(value: unknown): Record<string, unknown> {
  return parseInput(configObject, value, "Resource config");
}

export function assertBrowserSandboxes(resources: CliResource[]): void {
  const sandboxes = new Map(
    resources
      .filter((entry) => entry.kind === "sandbox")
      .map((entry) => [entry.name, entry]),
  );
  for (const agent of resources.filter((entry) => entry.kind === "agent")) {
    const config = plainRecord(agent.config);
    if (plainRecord(config.browser).enabled !== true) continue;
    const name = defaultSandboxOf(config);
    const sandbox = name === undefined ? undefined : sandboxes.get(name);
    // Core checks a sandbox this manifest does not declare at run start.
    if (name !== undefined && sandbox === undefined) continue;
    const sandboxConfig = plainRecord(sandbox?.config);
    const problem = browserSandboxRefusal(
      sandbox && {
        provider: sandboxProvider(sandbox),
        image: sandboxConfig.image,
        network: plainRecord(sandboxConfig.network),
      },
    );
    if (problem) throw new ClientError(`Agent "${agent.name}": ${problem}`);
  }
}

export function assertEnvRefsResolved(
  resources: CliResource[],
  envValues: Record<string, string>,
  stage: string,
): void {
  // The rewrite walker collects, so collection cannot drift from substitution.
  const referenced = new Set<string>();
  for (const resource of resources) {
    rewriteEnvRefs(asObject(resource.config), referenced);
    // MCP headers and oauth and a workspace's R2 keys hold `${NAME}` strings, not env() refs.
    const config = asObject(resource.config);
    if (resource.kind === "agent") {
      collectEnvPlaceholderNames(config.mcp, referenced);
    }
    if (resource.kind === "mcp") {
      collectEnvPlaceholderNames(
        { headers: config.headers, oauth: config.oauth },
        referenced,
      );
    }
    if (resource.kind === "workspace") {
      collectEnvPlaceholderNames(config.storage, referenced);
    }
  }
  const missing = [...referenced]
    .filter((name) => envValues[name] === undefined)
    .sort();
  if (missing.length === 0) return;
  // `broods env` defaults to the dev stage.
  const flag = `--stage ${stage}`;

  throw new ClientError(
    `env() and \${NAME} references name ${missing.length} variable(s) with no value set for this stage: ${missing.join(", ")}. ` +
      `Set each one with \`broods env set <NAME> ${flag}\`, or put them in .env.local and run \`broods env sync ${flag}\`, then sync again.`,
  );
}

export async function assertNoAccountScopedResourceConflict(
  ctx: MutationCtx,
  options: {
    table: "workspaceConfigs" | "sandboxConfigs";
    accountId: Id<"accounts">;
    name: string;
  },
): Promise<void> {
  const rows = await ctx.db
    .query(options.table)
    .withIndex("by_accountId_and_name", (q) =>
      q.eq("accountId", options.accountId).eq("name", options.name),
    )
    .collect();
  const accountScoped = rows.find((row) => row.stageId === undefined);
  if (!accountScoped) return;

  throw new ClientError(
    `${options.table} "${options.name}" already exists account-wide. ` +
      "Move it to a project/stage or delete it first.",
    "conflict",
  );
}

export function assertSupportedWorkspaceSandboxMounts(
  resources: CliResource[],
): void {
  const sandboxes = new Map(
    resources
      .filter((entry) => entry.kind === "sandbox")
      .map((entry) => [entry.name, entry]),
  );
  const workspaceResources = new Map(
    resources
      .filter((entry) => entry.kind === "workspace")
      .map((entry) => [entry.name, entry]),
  );
  for (const agent of resources.filter((entry) => entry.kind === "agent")) {
    const config = plainRecord(agent.config);
    const workspaces = config.workspaces;
    if (!Array.isArray(workspaces)) continue;
    const defaultSandbox = defaultSandboxOf(config);
    for (const ref of workspaces) {
      const workspace = plainRecord(ref);
      const sandboxName =
        workspace.sandbox === null
          ? undefined
          : typeof workspace.sandbox === "string"
            ? workspace.sandbox
            : defaultSandbox;
      const sandbox = sandboxName ? sandboxes.get(sandboxName) : undefined;
      const storage = plainRecord(
        plainRecord(
          workspaceResources.get(
            String(workspace.workspaceId ?? workspace.name),
          )?.config,
        ).storage,
      ).provider;
      if (storage === "disk") {
        const sandboxConfig = plainRecord(sandbox?.config);
        if (
          sandbox &&
          sandboxHoldsWorkspace("disk", {
            provider: sandboxProvider(sandbox),
            persistent: sandboxConfig.persistent,
          })
        )
          continue;
        throw new ClientError(
          `Agent "${agent.name}" workspace "${String(workspace.name ?? workspace.workspaceId)}": ${DISK_WORKSPACE_HINT}.`,
        );
      }
      if (!sandboxName) continue;
      if (
        !sandbox ||
        supportsS3WorkspaceMount(
          sandboxProvider(sandbox),
          plainRecord(plainRecord(sandbox.config).options),
        )
      )
        continue;
      const workspaceName =
        typeof workspace.name === "string"
          ? workspace.name
          : typeof workspace.workspaceId === "string"
            ? workspace.workspaceId
            : "<unknown>";
      throw new ClientError(
        `Agent "${agent.name}" workspace "${workspaceName}" uses sandbox "${sandbox.name}" ` +
          `(${sandboxProvider(sandbox)}) which does not support S3 workspace mounts. Use ${S3_MOUNT_PROVIDER_HINT}, ` +
          `or set this workspace ref to sandbox: null for read-only S3 access.`,
      );
    }
  }
}

export function assertSupportedWorkspaceStorage(resource: CliResource): void {
  const config = plainRecord(resource.config);
  const storage = plainRecord(config.storage);
  const provider = storage.provider;
  if (provider === undefined || provider === "s3" || provider === "disk")
    return;
  if (provider === "vercel") {
    throw new ClientError(
      `Workspace "${resource.name}" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet. ` +
        `Use storage.provider "s3" or omit storage until Vercel Drive is wired.`,
    );
  }
  throw new ClientError(
    `Workspace "${resource.name}" config.storage.provider must be one of: s3, disk`,
  );
}

export async function authIdForAccount(
  ctx: MutationCtx,
  account: Doc<"accounts">,
): Promise<string | null> {
  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) return null;
  const org = await ctx.db.get(orgId);

  return org?.ownerAuthId ?? null;
}

export async function claimManifestRevision(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  expected: number | undefined,
): Promise<number> {
  const row = await stageSyncRow(ctx, stageId);
  const current = row?.revision ?? 0;
  const now = Date.now();
  if (row?.activeUntil !== undefined && row.activeUntil > now) {
    throw new ClientError(
      "Another manifest sync is still running for this stage. Retry after it finishes.",
      "manifest_conflict",
    );
  }
  if (expected !== undefined && expected !== current) {
    throw new ClientError(
      `Stage changed since your last sync (revision ${current}, you sent ${expected}). Re-sync to see the new diff.`,
      "manifest_conflict",
    );
  }
  const next = current + 1;
  const activeUntil = now + MANIFEST_SYNC_TIMEOUT_MS;
  if (row)
    await ctx.db.patch(row._id, { revision: next, activeUntil: activeUntil });
  else
    await ctx.db.insert("stageSyncs", {
      stageId: stageId,
      revision: next,
      activeUntil: activeUntil,
    });

  return next;
}

export async function decryptSandboxConfig(
  sandbox: Doc<"sandboxConfigs">,
  cipher: AccountCipher,
): Promise<Record<string, unknown>> {
  if (
    !sandbox.encryptedConfig ||
    !sandbox.encryptionIv ||
    !sandbox.encryptionTag
  ) {
    return {};
  }
  const decrypted = await cipher.decrypt("sandboxConfigs:encryptedConfig", {
    ciphertext: sandbox.encryptedConfig,
    iv: sandbox.encryptionIv,
    tag: sandbox.encryptionTag,
  });

  return decrypted ?? {};
}

export async function decryptSandboxManifestConfig(
  sandbox: Doc<"sandboxConfigs">,
  cipher: AccountCipher,
): Promise<Record<string, unknown>> {
  if (
    sandbox.encryptedSourceConfig &&
    sandbox.sourceEncryptionIv &&
    sandbox.sourceEncryptionTag
  ) {
    const decrypted = await cipher.decrypt(
      "sandboxConfigs:encryptedSourceConfig",
      {
        ciphertext: sandbox.encryptedSourceConfig,
        iv: sandbox.sourceEncryptionIv,
        tag: sandbox.sourceEncryptionTag,
      },
    );

    return decrypted ?? {};
  }

  return await decryptSandboxConfig(sandbox, cipher);
}

export function displayStageName(name: string): string {
  const kind = kindForStageName(name);
  if (kind === "development") return "Development";
  if (kind === "production") return "Production";

  return name;
}

export async function ensureProject(
  ctx: MutationCtx,
  account: Doc<"accounts">,
  project: string,
): Promise<Doc<"projects">> {
  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) throw new Error("Account is not linked to a valid org");
  const org = await ctx.db.get(orgId);
  if (!org) throw new Error("Account org not found");

  const name = resourceName(project);
  const projectDoc = await resolveProject(ctx, orgId, name);
  if (projectDoc) return projectDoc;

  const now = Date.now();
  const projectId = await ctx.db.insert("projects", {
    authId: org.ownerAuthId,
    orgId: orgId,
    name: name,
    slug: await uniqueProjectSlug(ctx, orgId, name),
    updatedAt: now,
  });
  const created = await ctx.db.get(projectId);
  if (!created) throw new Error("Failed to create project");

  // Seeded so the dashboard lands on Development even when the first deploy is Production.
  await ctx.db.insert("stages", {
    authId: org.ownerAuthId,
    projectId: projectId,
    name: "Development",
    kind: "development",
    isDefault: true,
    updatedAt: now,
  });

  return created;
}

export async function ensureStage(
  ctx: MutationCtx,
  project: Doc<"projects">,
  stage: string,
): Promise<Doc<"stages">> {
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .collect();
  const name = resourceName(stage);
  const existing = stages.find((entry) => stageNameEquals(entry.name, name));
  const kind = kindForStageName(name);
  if (existing) {
    const fixed = {
      name: displayStageName(name),
      kind: kind,
      isDefault: kind === "development" ? true : existing.isDefault,
    };
    if (existing.kind !== kind || existing.name !== fixed.name) {
      await ctx.db.patch(existing._id, { ...fixed, updatedAt: Date.now() });
    }
    if (kind === "development") {
      for (const stage of stages.filter(
        (entry) => entry._id !== existing._id && entry.isDefault,
      )) {
        await ctx.db.patch(stage._id, {
          isDefault: false,
          updatedAt: Date.now(),
        });
      }
    }

    return existing.kind !== kind || existing.name !== fixed.name
      ? { ...existing, ...fixed }
      : existing;
  }

  const stageId = await ctx.db.insert("stages", {
    authId: project.authId,
    projectId: project._id,
    name: kind === "custom" ? assertStageName(name) : displayStageName(name),
    kind: kind,
    isDefault: kind === "development",
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get(stageId);
  if (!created) throw new Error("Failed to create stage");
  if (kind === "development") {
    for (const stage of stages.filter((entry) => entry.isDefault)) {
      await ctx.db.patch(stage._id, {
        isDefault: false,
        updatedAt: Date.now(),
      });
    }
  }

  return created;
}

// Data stays where Production first deployed: another region is refused, never moved.
export function deploymentRegionToPin(
  stage: Doc<"stages">,
  region: DeploymentRegion | undefined,
): DeploymentRegion | undefined {
  if (stage.kind !== "production") {
    if (region) {
      throw new ClientError("A region applies only to the production stage");
    }

    return undefined;
  }
  if (stage.deploymentRegion) {
    if (region && region !== stage.deploymentRegion) {
      throw new ClientError(
        `${stage.name} already runs in ${stage.deploymentRegion} and cannot move to ${region}`,
        "conflict",
      );
    }

    return undefined;
  }
  if (region && !LIVE_DEPLOYMENT_REGIONS.includes(region)) {
    throw new ClientError(
      `Region ${region} is not available yet. Available: ${LIVE_DEPLOYMENT_REGIONS.join(", ")}`,
    );
  }

  return region ?? LIVE_DEPLOYMENT_REGIONS[0];
}

export function envName(value: string): string {
  const trimmed = value.trim();
  assertEnvVarName(trimmed);

  return trimmed;
}

export function isExternalResourceKind(
  kind: CliManifestResource["kind"],
): kind is ExternalResourceKind {
  return (EXTERNAL_RESOURCE_KINDS as readonly string[]).includes(kind);
}

export async function manifestRevision(
  ctx: QueryCtx | MutationCtx,
  stageId: Id<"stages">,
): Promise<number> {
  return (await stageSyncRow(ctx, stageId))?.revision ?? 0;
}

export function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function renameComparableAgent(agent: Doc<"agentConfigs">): unknown {
  return renameComparableResource(
    agent.description,
    toNestedAgentConfig(agent),
  );
}

export function renameComparableResource(
  description: string | undefined,
  config: unknown,
): unknown {
  return {
    description: description,
    config: config,
  };
}

export async function releaseManifestSync(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  revision: number,
): Promise<void> {
  const row = await stageSyncRow(ctx, stageId);
  if (row?.revision === revision)
    await ctx.db.patch(row._id, { activeUntil: undefined });
}

// `pruneOnly` holds the `kind:name` keys a dev prune chose; a deploy prune sends none.
export function prunes(
  pruneOnly: readonly string[] | undefined,
  kind: CliResource["kind"],
  name: string,
): boolean {
  return pruneOnly === undefined || pruneOnly.includes(`${kind}:${name}`);
}

export function resourceName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ClientError("Resource name is required");

  return trimmed;
}

// Shaped like Convex ids, so id-keyed rules can run before the sync creates any row.
export function placeholderIds(names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name, index): [string, string] => [
      name,
      `placeholder${String(index).padStart(12, "0")}`,
    ]),
  );
}

export function rewriteEnvRefs(
  value: unknown,
  envNames: Set<string>,
): Record<string, unknown> {
  return rewriteEnvRefsValue(value, envNames) as Record<string, unknown>;
}

export function rewriteIdsToNames(
  config: Record<string, unknown>,
  names: {
    workspaces: Record<string, string>;
    sandboxes: Record<string, string>;
    agents?: Record<string, string>;
    skills?: Record<string, string>;
    hooks?: Record<string, string>;
    mcp?: Record<string, string>;
    policies?: Record<string, string>;
  },
): Record<string, unknown> {
  const {
    workspaces: workspaceNames,
    sandboxes: sandboxNames,
    agents: agentNames = {},
    skills: skillNames = {},
    hooks: hookNames = {},
    mcp: mcpNames = {},
    policies: policyNames = {},
  } = names;
  const result = { ...config };
  if (Array.isArray(result.sandboxes)) {
    result.sandboxes = rewriteRefList(result.sandboxes, sandboxNames);
  }
  if (Array.isArray(result.workspaces)) {
    result.workspaces = result.workspaces.map((entry) => {
      const ref = parseOr(configObject, entry);
      if (!ref) return entry;
      const workspaceId =
        typeof ref.workspaceId === "string" && workspaceNames[ref.workspaceId]
          ? workspaceNames[ref.workspaceId]
          : ref.workspaceId;
      const sandbox =
        typeof ref.sandbox === "string" && sandboxNames[ref.sandbox]
          ? sandboxNames[ref.sandbox]
          : ref.sandbox;

      return {
        ...ref,
        workspaceId: workspaceId,
        ...(ref.sandbox !== undefined ? { sandbox: sandbox } : {}),
      };
    });
  }
  const subagent = parseOr(configObject, result.subagent);
  if (subagent && Array.isArray(subagent.allowed)) {
    result.subagent = {
      ...subagent,
      allowed: subagent.allowed.map((entry) =>
        typeof entry === "string" && agentNames[entry]
          ? agentNames[entry]
          : entry,
      ),
    };
  }
  const skills = parseOr(configObject, result.skills);
  if (skills && Array.isArray(skills.allowed)) {
    result.skills = {
      ...skills,
      allowed: skills.allowed.map((entry) =>
        typeof entry === "string" && skillNames[entry]
          ? skillNames[entry]
          : entry,
      ),
    };
  }
  const mcp = parseOr(configObject, result.mcp);
  if (mcp) {
    result.mcp = remapKeys(mcp, mcpNames);
  }
  const hooks = parseOr(configObject, result.hooks);
  if (hooks && Array.isArray(hooks.code)) {
    result.hooks = {
      ...hooks,
      code: hooks.code.map((entry) => {
        const hook = parseOr(configObject, entry);
        if (!hook) return entry;
        const hookId =
          typeof hook.hookId === "string" && hookNames[hook.hookId]
            ? hookNames[hook.hookId]
            : hook.hookId;

        return { ...hook, hookId: hookId };
      }),
    };
  }
  if (Array.isArray(result.policies)) {
    result.policies = rewriteRefList(result.policies, policyNames);
  }

  return result;
}

export function rewriteResourceRefs(
  config: Record<string, unknown>,
  ids: {
    workspaces: Record<string, string>;
    sandboxes: Record<string, string>;
    policies: Record<string, string>;
    mcp?: Record<string, string>;
  },
): Record<string, unknown> {
  const {
    workspaces: workspaceIds,
    sandboxes: sandboxIds,
    policies: policyIds,
    mcp: mcpIds = {},
  } = ids;
  const result = { ...config };
  if (Array.isArray(result.sandboxes)) {
    result.sandboxes = rewriteRefList(result.sandboxes, sandboxIds);
  }
  if (Array.isArray(result.workspaces)) {
    result.workspaces = result.workspaces.map((entry) => {
      const ref = parseOr(configObject, entry);
      if (!ref) return entry;
      const workspaceId =
        typeof entry.workspaceId === "string" && workspaceIds[entry.workspaceId]
          ? workspaceIds[entry.workspaceId]
          : entry.workspaceId;
      const sandbox =
        typeof entry.sandbox === "string" && sandboxIds[entry.sandbox]
          ? sandboxIds[entry.sandbox]
          : entry.sandbox;

      return {
        ...entry,
        workspaceId: workspaceId,
        ...(entry.sandbox !== undefined ? { sandbox: sandbox } : {}),
      };
    });
  }
  if (Array.isArray(result.policies)) {
    result.policies = rewriteRefList(result.policies, policyIds);
  }
  // A key that fails to map to an mcp row id fails normalizeMcpConfig loudly.
  const mcp = parseOr(configObject, result.mcp);
  if (mcp) {
    result.mcp = remapKeys(mcp, mcpIds);
  }

  return result;
}

export function snapshotExternalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotExternalConfig);
  const object = parseOr(configObject, value);
  if (object) {
    return Object.fromEntries(
      Object.entries(object).flatMap(([key, entry]) => {
        if (key === "contentBase64" || key === "bundle") return [];
        if (key === "files" && Array.isArray(entry)) {
          return [
            [
              key,
              entry.map((file) => {
                const fileObject = parseOr(configObject, file);
                if (!fileObject) return snapshotExternalConfig(file);
                const { contentBase64: _contentBase64, ...rest } = fileObject;

                return snapshotExternalConfig(rest);
              }),
            ],
          ];
        }

        return [[key, snapshotExternalConfig(entry)]];
      }),
    );
  }

  return value;
}

function rewriteEnvRefsValue(value: unknown, envNames: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteEnvRefsValue(entry, envNames));
  }
  const object = parseOr(configObject, value);
  if (object) {
    if (object.__beeblastEnv === true && typeof object.name === "string") {
      const name = envName(object.name);
      envNames.add(name);

      return `\${${name}}`;
    }

    return Object.fromEntries(
      Object.entries(object).map(([key, entry]) => [
        key,
        rewriteEnvRefsValue(entry, envNames),
      ]),
    );
  }

  return value;
}

function rewriteRefList(
  entries: unknown[],
  table: Record<string, string>,
): unknown[] {
  return entries.map((entry): unknown =>
    typeof entry === "string" && table[entry] ? table[entry] : entry,
  );
}

function sandboxProvider(sandbox: CliResource): string {
  const provider = plainRecord(sandbox.config).provider;

  return typeof provider === "string" ? provider : DEFAULT_SANDBOX_PROVIDER;
}

async function stageSyncRow(
  ctx: QueryCtx | MutationCtx,
  stageId: Id<"stages">,
): Promise<Doc<"stageSyncs"> | null> {
  return await ctx.db
    .query("stageSyncs")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .unique();
}

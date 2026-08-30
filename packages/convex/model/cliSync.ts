/**
 * Shared primitives for CLI manifest sync: account/project/stage resolution,
 * manifest validation, env-ref and resource-ref rewriting, sandbox config
 * decryption, and the rename-comparison snapshots the sync passes use.
 * The registered Convex functions live in `cli/sync.ts`.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { CliManifestResource } from "../cli/types";
import { uniqueProjectSlug } from "../lib/slug";
import { stageKindForName } from "../stage";
import {
  decryptAgentConfigBlob,
  toNestedAgentConfig,
} from "./agentConfigCodec";
import { isPlainObject, remapKeys } from "./objects";
import { stageNameEquals } from "./projectScope";

export type CliResource = CliManifestResource;

/**
 * Resource kinds owned by the account service and snapshotted per stage in
 * `cliExternalResources`. The one list behind every "is this external" filter
 * and the per-kind id lookups, so adding a kind cannot half-land.
 */
export const EXTERNAL_RESOURCE_KINDS = [
  "skill",
  "tool",
  "hook",
  "mcp",
] as const;

export type ExternalResourceKind = (typeof EXTERNAL_RESOURCE_KINDS)[number];

export function isExternalResourceKind(
  kind: CliManifestResource["kind"],
): kind is ExternalResourceKind {
  return (EXTERNAL_RESOURCE_KINDS as readonly string[]).includes(kind);
}

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
  if (!isPlainObject(value))
    throw new Error("Resource config must be an object");

  return value;
}

/**
 * Rejects a manifest whose `env("NAME")` has no value stored for the stage,
 * which would otherwise reach the runtime as a literal `${NAME}`.
 */
export function assertEnvRefsResolved(
  resources: CliResource[],
  envValues: Record<string, string>,
): void {
  // Reuses the rewrite walker so collection cannot drift from substitution.
  const referenced = new Set<string>();
  for (const resource of resources) {
    rewriteEnvRefs(asObject(resource.config), referenced);
  }
  const missing = [...referenced]
    .filter((name) => envValues[name] === undefined)
    .sort();
  if (missing.length === 0) return;

  throw new Error(
    `env() references ${missing.length} variable(s) with no value set for this stage: ${missing.join(", ")}. ` +
      "Set each one with `broods env set <NAME>` (or put it in .env.local and run `broods dev`), then sync again.",
  );
}

/**
 * Fail loudly when an old account-scoped runtime resource would shadow the new
 * stage-scoped row. Operators must migrate or delete that row explicitly.
 */
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

  throw new Error(
    `${options.table} "${options.name}" is account-scoped legacy data. ` +
      "Migrate it to a project/stage or delete it before syncing code-managed resources.",
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
  for (const agent of resources.filter((entry) => entry.kind === "agent")) {
    const config = plainRecord(agent.config);
    const workspaces = config.workspaces;
    if (!Array.isArray(workspaces)) continue;
    for (const ref of workspaces) {
      const workspace = plainRecord(ref);
      const sandboxName =
        workspace.sandbox === null
          ? undefined
          : typeof workspace.sandbox === "string"
            ? workspace.sandbox
            : typeof config.sandbox === "string"
              ? config.sandbox
              : undefined;
      if (!sandboxName) continue;
      const sandbox = sandboxes.get(sandboxName);
      if (!sandbox || supportsS3WorkspaceMount(sandbox)) continue;
      throw new Error(
        `Agent "${agent.name}" workspace "${String(workspace.name ?? workspace.workspaceId ?? "<unknown>")}" uses sandbox "${sandbox.name}" ` +
          `(${sandboxProvider(sandbox)}) which does not support S3 workspace mounts. Use lambda/sandbox, or daytona with ` +
          `options.mountAwsS3Buckets: true, or set this workspace ref to sandbox: null for read-only S3 access.`,
      );
    }
  }
}

export function assertSupportedWorkspaceStorage(resource: CliResource): void {
  const config = plainRecord(resource.config);
  const storage = plainRecord(config.storage);
  const provider = storage.provider;
  if (provider === undefined || provider === "s3") return;
  if (provider === "vercel") {
    throw new Error(
      `Workspace "${resource.name}" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet. ` +
        `Use storage.provider "s3" or omit storage until Vercel Drive is wired.`,
    );
  }
  throw new Error(
    `Workspace "${resource.name}" config.storage.provider must be one of: s3`,
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

export async function decryptSandboxConfig(
  sandbox: Doc<"sandboxConfigs">,
  secret: string | undefined,
): Promise<Record<string, unknown>> {
  if (
    !secret ||
    !sandbox.encryptedConfig ||
    !sandbox.encryptionIv ||
    !sandbox.encryptionTag
  ) {
    return {};
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: sandbox.encryptedConfig,
      iv: sandbox.encryptionIv,
      tag: sandbox.encryptionTag,
    },
    secret,
  );

  return decrypted ?? {};
}

export async function decryptSandboxManifestConfig(
  sandbox: Doc<"sandboxConfigs">,
  secret: string | undefined,
): Promise<Record<string, unknown>> {
  if (
    secret &&
    sandbox.encryptedSourceConfig &&
    sandbox.sourceEncryptionIv &&
    sandbox.sourceEncryptionTag
  ) {
    const decrypted = await decryptAgentConfigBlob(
      {
        ciphertext: sandbox.encryptedSourceConfig,
        iv: sandbox.sourceEncryptionIv,
        tag: sandbox.sourceEncryptionTag,
      },
      secret,
    );

    return decrypted ?? {};
  }

  return await decryptSandboxConfig(sandbox, secret);
}

export function displayStageName(name: string): string {
  const kind = stageKindForName({ name: name, kind: undefined });
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

  const existing = await ctx.db
    .query("projects")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
  const name = resourceName(project);
  const projectDoc = existing.find(
    (entry) => entry.name === name || entry.slug === name,
  );
  if (projectDoc) return projectDoc;

  const now = Date.now();
  const projectId = await ctx.db.insert("projects", {
    authId: org.ownerAuthId,
    orgId: orgId,
    name: name,
    slug: await uniqueProjectSlug(
      ctx,
      { authId: org.ownerAuthId, orgId: orgId },
      name,
    ),
    updatedAt: now,
  });
  const created = await ctx.db.get(projectId);
  if (!created) throw new Error("Failed to create project");

  // Seed a Development default so the dashboard lands on Development even when
  // the first CLI command deploys straight to Production.
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
  const kind = stageKindForName({ name: name, kind: undefined });
  if (existing) {
    if (existing.kind !== kind || existing.name !== displayStageName(name)) {
      await ctx.db.patch(existing._id, {
        name: displayStageName(name),
        kind: kind,
        isDefault: kind === "development" ? true : existing.isDefault,
        updatedAt: Date.now(),
      });
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

    return existing;
  }

  // Only Development is ever the default; Production/custom stages are
  // never auto-defaulted, even when created first.
  const stageId = await ctx.db.insert("stages", {
    authId: project.authId,
    projectId: project._id,
    name: displayStageName(name),
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

export function envName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid environment variable name: ${value}`);
  }

  return trimmed;
}

export function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function renameComparableAgent(agent: Doc<"agentConfigs">): unknown {
  return renameComparableResource(
    agent.description,
    toNestedAgentConfig({
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
      modelId: agent.modelId,
      systemPrompt: agent.systemPrompt,
      maxTurns: agent.maxTurns,
      outputFormat: agent.outputFormat as Record<string, unknown> | undefined,
      providerOptions: agent.providerOptions as
        | Record<string, unknown>
        | undefined,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      memoryToolEnabled: agent.memoryToolEnabled,
      searchToolEnabled: agent.searchToolEnabled,
      searchToolConfig: agent.searchToolConfig as
        | Record<string, unknown>
        | undefined,
      extraConfig: agent.extraConfig as Record<string, unknown> | undefined,
    }),
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

export function resourceName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Resource name is required");

  return trimmed;
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
    tools?: Record<string, string>;
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
    tools: toolNames = {},
    hooks: hookNames = {},
    mcp: mcpNames = {},
    policies: policyNames = {},
  } = names;
  const result = { ...config };
  if (typeof result.sandbox === "string" && sandboxNames[result.sandbox]) {
    result.sandbox = sandboxNames[result.sandbox];
  }
  if (Array.isArray(result.workspaces)) {
    result.workspaces = result.workspaces.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const workspaceId =
        typeof entry.workspaceId === "string" &&
        workspaceNames[entry.workspaceId]
          ? workspaceNames[entry.workspaceId]
          : entry.workspaceId;
      const sandbox =
        typeof entry.sandbox === "string" && sandboxNames[entry.sandbox]
          ? sandboxNames[entry.sandbox]
          : entry.sandbox;

      return {
        ...entry,
        workspaceId: workspaceId,
        ...(entry.sandbox !== undefined ? { sandbox: sandbox } : {}),
      };
    });
  }
  if (
    isPlainObject(result.subagent) &&
    Array.isArray(result.subagent.allowed)
  ) {
    result.subagent = {
      ...result.subagent,
      allowed: result.subagent.allowed.map((entry) =>
        typeof entry === "string" && agentNames[entry]
          ? agentNames[entry]
          : entry,
      ),
    };
  }
  if (isPlainObject(result.skills) && Array.isArray(result.skills.allowed)) {
    result.skills = {
      ...result.skills,
      allowed: result.skills.allowed.map((entry) =>
        typeof entry === "string" && skillNames[entry]
          ? skillNames[entry]
          : entry,
      ),
    };
  }
  if (isPlainObject(result.tools)) {
    result.tools = remapKeys(result.tools, toolNames);
  }
  if (isPlainObject(result.mcpServers)) {
    result.mcpServers = remapKeys(result.mcpServers, mcpNames);
  }
  if (isPlainObject(result.hooks) && Array.isArray(result.hooks.code)) {
    result.hooks = {
      ...result.hooks,
      code: result.hooks.code.map((entry) => {
        if (!isPlainObject(entry)) return entry;
        const hookId =
          typeof entry.hookId === "string" && hookNames[entry.hookId]
            ? hookNames[entry.hookId]
            : entry.hookId;

        return { ...entry, hookId: hookId };
      }),
    };
  }
  if (isPlainObject(result.policy) && Array.isArray(result.policy.policyIds)) {
    result.policy = {
      ...result.policy,
      policyIds: result.policy.policyIds.map((entry) =>
        typeof entry === "string" && policyNames[entry]
          ? policyNames[entry]
          : entry,
      ),
    };
  }

  return result;
}

export function rewriteResourceRefs(
  config: Record<string, unknown>,
  ids: {
    workspaces: Record<string, string>;
    sandboxes: Record<string, string>;
    policies: Record<string, string>;
    tools: Record<string, string>;
    mcp?: Record<string, string>;
  },
): Record<string, unknown> {
  const {
    workspaces: workspaceIds,
    sandboxes: sandboxIds,
    policies: policyIds,
    tools: toolIds,
    mcp: mcpIds = {},
  } = ids;
  const result = { ...config };
  if (typeof result.sandbox === "string" && sandboxIds[result.sandbox]) {
    result.sandbox = sandboxIds[result.sandbox];
  }
  if (Array.isArray(result.workspaces)) {
    result.workspaces = result.workspaces.map((entry) => {
      if (!isPlainObject(entry)) return entry;
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
  if (isPlainObject(result.policy) && Array.isArray(result.policy.policyIds)) {
    result.policy = {
      ...result.policy,
      policyIds: result.policy.policyIds.map((entry) =>
        typeof entry === "string" && policyIds[entry]
          ? policyIds[entry]
          : entry,
      ),
    };
  }
  // `config.tools` is keyed by account tool id at rest: a key left as a name is
  // read at runtime as a provider tool. Unknown keys are provider tools, so stay.
  if (isPlainObject(result.tools)) {
    result.tools = remapKeys(result.tools, toolIds);
  }
  // `config.mcpServers` keys must end up as mcp row ids; a name that fails to
  // map fails normalizeMcpServersConfig loudly rather than being left behind.
  if (isPlainObject(result.mcpServers)) {
    result.mcpServers = remapKeys(result.mcpServers, mcpIds);
  }

  return result;
}

export function snapshotExternalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotExternalConfig);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        if (key === "contentBase64" || key === "bundle") return [];
        if (key === "files" && Array.isArray(entry)) {
          return [
            [
              key,
              entry.map((file) => {
                if (!isPlainObject(file)) return snapshotExternalConfig(file);
                const { contentBase64: _contentBase64, ...rest } = file;

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
  if (isPlainObject(value)) {
    if (value.__beeblastEnv === true && typeof value.name === "string") {
      const name = envName(value.name);
      envNames.add(name);

      return `\${${name}}`;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteEnvRefsValue(entry, envNames),
      ]),
    );
  }

  return value;
}

function sandboxProvider(sandbox: CliResource): string {
  const provider = plainRecord(sandbox.config).provider;

  return typeof provider === "string" ? provider : "sandbox";
}

function supportsS3WorkspaceMount(sandbox: CliResource): boolean {
  const provider = sandboxProvider(sandbox);
  if (provider === "lambda" || provider === "sandbox") return true;
  if (provider !== "daytona") return false;

  return (
    plainRecord(plainRecord(sandbox.config).options).mountAwsS3Buckets === true
  );
}

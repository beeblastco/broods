/**
 * Compiles `broods/` TypeScript resources into the SaaS CLI manifest.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import module from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentHookEventName,
  CliManifest,
  CliManifestResource,
} from "./contracts.ts";
import {
  build as esbuild,
  transformSync,
  type BuildFailure,
  type Plugin,
} from "esbuild";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  isAccountModelProviderName,
} from "../../convex/model/modelProviders.ts";
import { GENERATED_DIR, PROJECT_DIR, stageFromEnv } from "./config.ts";
import { loadBroodsRuntimeConfig } from "./runtime-config.ts";
import {
  isConnectionDefinition,
  isBroodsConfig,
  isResource,
  type AnyConnectionDefinition,
  type AnyResource,
  type AgentHooks,
  type BroodsConfigDefinition,
  type BroodsProjectConfig,
  type McpServerDefinitionConfig,
  type PolicyResource,
  type SandboxResource,
  type WorkspaceResource,
} from "./resources.ts";

/** Reach every room the app can see, instead of only the declared channels. */
const CHANNEL_REACH_WILDCARD = "*";

export interface CompileOptions {
  cwd?: string;
  project?: string;
  stage?: string;
  command?: "dev" | "deploy";
  useRuntimeStage?: boolean;
}

export interface CompiledProject {
  config: BroodsProjectConfig;
  manifest: CliManifest;
  resources: AnyResource[];
  resourceAliases: ResourceAliases;
  channels: CompiledChannel[];
}

export interface CompiledChannel {
  alias: string;
  type: AnyConnectionDefinition["type"];
  id: string;
  agentName: string;
}

export type ResourceAliases = Partial<
  Record<AnyResource["kind"], Record<string, string>>
>;

type ExportedValue = {
  exportName: string;
  file: string;
  value: unknown;
};

type ExportedResource = {
  exportName: string;
  file: string;
  resource: AnyResource;
};

// The server bounds uploaded bundles: 1 MB for isolate-run hooks, 10 MB for
// hosted MCP server bundles. The CLI enforces the larger bound and lets the
// server reject an oversized hook bundle with its own limit named.
const MAX_BUNDLE_FILE_BYTES = 10_000_000;
const MAX_BUNDLE_TOTAL_BYTES = 20_000_000;
const MAX_BUNDLE_FILES = 200;
const SKIPPED_BUNDLE_DIRECTORIES = new Set(["node_modules", ".git"]);
const UNSAFE_BUNDLE_FILE_NAMES = [
  /^\.env(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const INLINE_AGENT_HOOK_EVENTS = {
  onStart: "agent.started",
  onStepFinish: "agent.step.finished",
  onToolCall: "tool.call.started",
  onToolResult: "tool.result",
  onFinish: "agent.finished",
  onApproval: "agent.approval.required",
  onError: "agent.failed",
  onSubagentFinish: "subagent.task.finished",
  onMessageReceived: "channel.message.received",
  onMessageSending: "channel.message.sending",
} as const satisfies Record<keyof AgentHooks, AgentHookEventName>;

type InlineAgentHookName = keyof typeof INLINE_AGENT_HOOK_EVENTS;

export async function compileProject(
  options: CompileOptions = {},
): Promise<CompiledProject> {
  const cwd = options.cwd ?? process.cwd();
  loadBroodsRuntimeConfig(cwd);
  const root = resolve(cwd, PROJECT_DIR);
  const files = await listTypeScriptFiles(root);
  const exports = await loadExports(files);
  const config = await findConfig(exports, cwd, options.project);
  const resourceExports = exports
    .filter((entry): entry is ExportedValue & { value: AnyResource } =>
      isResource(entry.value),
    )
    .map((entry): ExportedResource => ({
      exportName: entry.exportName,
      file: entry.file,
      resource: entry.value,
    }));
  const resources = resourceExports.map((entry) => entry.resource);
  assertUniqueResources(resources);
  assertExportedHarnessSandboxes(resources);
  const channels = compileChannels(resourceExports, exports);
  const reach = declaredReach(resources);
  for (const resource of resources) assertKnownConfigKeys(resource);
  for (const resource of resources) assertSupportedWorkspaceStorage(resource);
  for (const resource of resources)
    assertSupportedWorkspaceIsolationShape(resource);
  assertWorkspaceIsolationConsistency(resources);
  assertSupportedWorkspaceSandboxMounts(resources);
  assertConnectionReach(resourceExports, reach);
  const resourceAliases = aliasesForResources(resourceExports);
  const stage = resolveStage(
    config,
    options.stage ??
      (options.useRuntimeStage === false ? undefined : stageFromEnv()),
    options.command ?? "dev",
  );
  const manifestResources = (
    await Promise.all(
      resourceExports.map((entry) => toManifestResources(entry, root, reach)),
    )
  )
    .flat()
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  assertUniqueResources(manifestResources);

  return {
    config: config,
    resources: resources,
    resourceAliases: resourceAliases,
    channels: channels,
    manifest: {
      version: 1,
      project: config.project!,
      stage: stage,
      resources: manifestResources,
    },
  };
}

/**
 * Collects the distinct account/environment variable names referenced via
 * `env("NAME")` (the `{ __beeblastEnv }` marker) across every resource config in a
 * compiled manifest, sorted. `dev` uses this to auto-sync exactly those vars
 * from the local environment to the cloud — never unrelated `.env.local` keys.
 */
export function collectEnvRefNames(manifest: CliManifest): string[] {
  const names = new Set<string>();

  for (const resource of manifest.resources)
    collectEnvRefNamesFromValue(resource.config, names);

  return [...names].sort();
}

function collectEnvRefNamesFromValue(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectEnvRefNamesFromValue(entry, names);

    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__beeblastEnv === true && typeof record.name === "string") {
      names.add(record.name);

      return;
    }
    for (const entry of Object.values(record))
      collectEnvRefNamesFromValue(entry, names);
  }
}

function resolveStage(
  config: BroodsProjectConfig,
  explicit: string | undefined,
  command: "dev" | "deploy",
): string {
  if (explicit) return explicit;
  const configured = config.stages?.[command];
  if (configured) return configured;

  return command === "deploy" ? "production" : "development";
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === GENERATED_DIR || entry.name === "generated")
          continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }

  await walk(root);

  return results.sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  );
}

async function loadExports(files: string[]): Promise<ExportedValue[]> {
  registerTypeScriptLoader();
  const values: ExportedValue[] = [];
  for (const file of files) {
    const href = `${pathToFileURL(file).href}?t=${Date.now()}`;
    const mod = (await import(href)) as Record<string, unknown>;
    values.push(
      ...Object.entries(mod).map(([exportName, value]) => ({
        exportName: exportName,
        file: file,
        value: value,
      })),
    );
  }

  return values;
}

/** Guards against stacking one loader hook per `compileProject` call. */
let typeScriptLoaderRegistered = false;

/**
 * Teaches Node how to `import()` the project's `.ts` resource files.
 *
 * Node erases type syntax and nothing else, so an `enum`, a decorator or a
 * parameter property in `broods/` throws there while loading fine under Bun.
 * Handing the source to esbuild — already a dependency, for bundling custom
 * tools — makes both runtimes compile the same file, which is what lets
 * `broods` run on plain `node`. A load hook keeps each module's own URL, so a
 * resource that reads a file relative to `import.meta.url` still resolves
 * against its source directory. No-op under Bun, which loads TypeScript
 * natively and ships no `registerHooks`.
 */
function registerTypeScriptLoader(): void {
  if (typeScriptLoaderRegistered) return;
  typeScriptLoaderRegistered = true;
  if (typeof module.registerHooks !== "function") return;
  module.registerHooks({
    load: (url, context, nextLoad) => {
      // `loadExports` appends a cache-busting query the file system cannot see.
      const [href] = url.split("?");
      if (
        href === undefined ||
        !href.startsWith("file:") ||
        !href.endsWith(".ts")
      )
        return nextLoad(url, context);
      const path = fileURLToPath(href);

      return {
        format: "module",
        shortCircuit: true,
        source: transformSync(readFileSync(path, "utf8"), {
          loader: "ts",
          format: "esm",
          sourcefile: path,
          sourcemap: "inline",
        }).code,
      };
    },
  });
}

async function findConfig(
  exports: ExportedValue[],
  cwd: string,
  explicitProject: string | undefined,
): Promise<BroodsProjectConfig> {
  const config = exports.find(
    (entry): entry is ExportedValue & { value: BroodsConfigDefinition } =>
      isBroodsConfig(entry.value),
  )?.value;
  const configValue = config?.config ?? {};
  const project =
    explicitProject ??
    process.env.BROODS_PROJECT ??
    configValue.project ??
    normalizeProjectName(basename(resolve(cwd)));
  if (!project.trim()) {
    throw new Error(
      "Project name is required. Pass --project <name> or set BROODS_PROJECT.",
    );
  }

  return {
    ...configValue,
    project: project,
  };
}

/**
 * Top-level agent config keys the code-first surface accepts. Mirrors
 * `AgentDefinitionConfig` in resources.ts; keep both in sync when core gains a
 * new agent field.
 */
const KNOWN_AGENT_CONFIG_KEYS = new Set([
  "agent",
  "harness",
  "model",
  "provider",
  "session",
  "hooks",
  "connections",
  "tools",
  "mcpServers",
  "denyTools",
  "sandbox",
  "workspaces",
  "subagent",
  "skills",
  "scheduler",
  "policies",
  "publicAccess",
]);

/** Common typos mapped to the key the author almost certainly meant. */
const AGENT_KEY_SUGGESTIONS: Record<string, string> = {
  workspace: "workspaces",
  skill: "skills",
  policy: "policies",
  tool: "tools",
  mcp: "mcpServers",
  mcpServer: "mcpServers",
  channel: "connections",
  channels: "connections",
  hook: "hooks",
  subagents: "subagent",
  sandboxes: "sandbox",
  systemPrompt: "agent",
  system: "agent",
};

/**
 * Rejects unknown top-level keys on a resource config so a typo such as
 * `workspace:` (instead of `workspaces:`) fails loudly at compile time — the way
 * a Convex validator rejects unknown fields — instead of being silently dropped
 * by the sync pipeline. Runs during `dev`/`deploy`, so it surfaces in the watch
 * loop even though the CLI transpiles resource files without typechecking
 * them.
 * @throws when an agent config carries a key outside the known set
 */
function assertKnownConfigKeys(resource: AnyResource): void {
  if (resource.kind !== "agent") return;
  const config = resource.config as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (KNOWN_AGENT_CONFIG_KEYS.has(key)) continue;
    const suggestion = AGENT_KEY_SUGGESTIONS[key];
    const hint = suggestion
      ? ` Did you mean "${suggestion}"?`
      : ` Allowed keys: ${[...KNOWN_AGENT_CONFIG_KEYS].sort().join(", ")}.`;
    throw new Error(
      `Agent "${resource.name}" has an unknown config key "${key}".${hint}`,
    );
  }
}

/**
 * Runtime validation for code-first workspace storage. TypeScript catches this
 * when callers typecheck, but `broods dev/deploy` must also fail before
 * upload because the CLI imports resource modules without typechecking them.
 */
function assertSupportedWorkspaceStorage(resource: AnyResource): void {
  if (resource.kind !== "workspace") return;
  const config = resource.config as unknown as Record<string, unknown>;
  const storage = config.storage;
  if (storage === undefined) return;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    throw new Error(
      `Workspace "${resource.name}" config.storage must be an object`,
    );
  }
  const provider = (storage as Record<string, unknown>).provider;
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

function assertSupportedWorkspaceIsolationShape(resource: AnyResource): void {
  if (resource.kind !== "workspace") return;
  const config = resource.config as unknown as Record<string, unknown>;
  if (typeof config.partitioned === "string") {
    throw new Error(
      `Workspace "${resource.name}" config.partitioned must be a boolean; string modes are not supported.`,
    );
  }
  if (config.isolation !== undefined) {
    throw new Error(
      `Workspace "${resource.name}" config.isolation is no longer supported; use partitioned: true.`,
    );
  }
}

function assertWorkspaceIsolationConsistency(resources: AnyResource[]): void {
  const workspaceResources = new Map(
    resources
      .filter(
        (resource): resource is WorkspaceResource =>
          resource.kind === "workspace",
      )
      .map((resource) => [resource.name, resource]),
  );

  for (const resource of resources) {
    if (resource.kind !== "agent") continue;
    const config = resource.config as Record<string, unknown>;
    const channels = config.connections;
    if (channels !== undefined && !Array.isArray(channels)) {
      throw new Error(
        `Agent "${resource.name}" config.connections must be an array of connection definitions`,
      );
    }
    const channelDefinitions = Array.isArray(channels)
      ? channels.filter(isConnectionDefinition)
      : [];
    const channelIds = new Set<string>();
    for (const channel of channelDefinitions) {
      const config = channel.config as Record<string, unknown>;
      const channelId = typeof config.id === "string" ? config.id : undefined;
      if (channelId) {
        if (channelIds.has(channelId))
          throw new Error(`Duplicate channel id: ${channelId}`);
        channelIds.add(channelId);
      }
      if (channel.partition) {
        assertPartitionShape(
          channel.partition,
          `Agent "${resource.name}" connection "${channel.type}"`,
        );
      }
      if (
        channel.config &&
        typeof channel.config === "object" &&
        ("workspaceIsolationScope" in channel.config ||
          "workspaceScope" in channel.config)
      ) {
        throw new Error(
          `Agent "${resource.name}" connection "${channel.type}" uses workspaceScope, which is no longer supported; use partition.`,
        );
      }
    }

    const attachedWorkspaces = Array.isArray(config.workspaces)
      ? config.workspaces
          .map((entry) => resolveLocalWorkspace(entry, workspaceResources))
          .filter((entry): entry is WorkspaceResource => Boolean(entry))
      : [];
    const partitionedWorkspaces = attachedWorkspaces.filter(
      (workspace) =>
        (workspace.config as unknown as Record<string, unknown>).partitioned ===
        true,
    );
    const partitionedChannels = channelDefinitions.filter(
      (channel) => channel.partition,
    );

    if (partitionedChannels.length > 0 && partitionedWorkspaces.length === 0) {
      const channel = partitionedChannels[0]!;
      throw new Error(
        `Agent "${resource.name}" connection "${channel.type}" defines partition, but no attached workspace has partitioned: true.`,
      );
    }

    if (partitionedWorkspaces.length > 0) {
      for (const channel of channelDefinitions) {
        if (!channel.partition) {
          throw new Error(
            `Agent "${resource.name}" attaches partitioned workspace "${partitionedWorkspaces[0]!.name}", but connection "${channel.type}" does not define partition.`,
          );
        }
      }
    }
  }
}

function assertPartitionShape(
  partition: AnyConnectionDefinition["partition"],
  name: string,
): void {
  if (!partition) return;
  if (partition.by === "shared") {
    if ("alias" in partition && partition.alias !== undefined) {
      throw new Error(
        `${name} partition.alias is only supported when partition.by is conversation`,
      );
    }

    return;
  }
  if (partition.by !== "conversation") {
    throw new Error(
      `${name} partition.by must be one of: shared, conversation`,
    );
  }
  if (typeof partition.alias !== "string" || partition.alias.length === 0) {
    throw new Error(
      `${name} partition.alias is required when partition.by is conversation`,
    );
  }
  // The alias becomes a path segment under the workspace root, so keep it to
  // characters that cannot escape or confuse the mount.
  if (!/^[A-Za-z0-9._-]+$/.test(partition.alias)) {
    throw new Error(
      `${name} partition.alias must use only letters, numbers, dots, underscores, or hyphens`,
    );
  }
  // The charset above still admits the two relative segments, which would walk
  // the alias out of its own namespace.
  if (partition.alias === "." || partition.alias === "..") {
    throw new Error(`${name} partition.alias must not be "." or ".."`);
  }
}

function resolveLocalWorkspace(
  entry: unknown,
  workspaces: Map<string, WorkspaceResource>,
): WorkspaceResource | undefined {
  if (isResource(entry) && entry.kind === "workspace") return entry;
  if (typeof entry === "string") return workspaces.get(entry);
  if (entry && typeof entry === "object" && "workspace" in entry) {
    const workspace = (entry as { workspace: unknown }).workspace;
    if (isResource(workspace) && workspace.kind === "workspace")
      return workspace;
    if (typeof workspace === "string") return workspaces.get(workspace);
  }

  return undefined;
}

function assertSupportedWorkspaceSandboxMounts(resources: AnyResource[]): void {
  const sandboxes = new Map(
    resources
      .filter((resource) => resource.kind === "sandbox")
      .map((resource) => [resource.name, resource]),
  );
  for (const resource of resources) {
    if (resource.kind !== "agent") continue;
    const config = resource.config as Record<string, unknown>;
    const agentSandbox = resolveLocalSandbox(config.sandbox, sandboxes);
    const workspaces = config.workspaces;
    if (!Array.isArray(workspaces)) continue;
    for (const entry of workspaces) {
      const workspaceName = workspaceNameFor(entry);
      const sandbox = effectiveWorkspaceSandbox(entry, agentSandbox, sandboxes);
      if (!sandbox || supportsS3WorkspaceMount(sandbox)) continue;
      throw new Error(
        `Agent "${resource.name}" workspace "${workspaceName}" uses sandbox "${sandbox.name}" (${sandboxProvider(sandbox)}) ` +
          `which does not support S3 workspace mounts. Use lambda/sandbox, or daytona with options.mountAwsS3Buckets: true, ` +
          `or set this workspace ref to sandbox: null for read-only S3 access.`,
      );
    }
  }
}

function resolveLocalSandbox(
  value: unknown,
  sandboxes: Map<string, SandboxResource>,
): SandboxResource | undefined {
  if (isResource(value) && value.kind === "sandbox") return value;
  if (typeof value === "string") return sandboxes.get(value);

  return undefined;
}

function effectiveWorkspaceSandbox(
  entry: unknown,
  agentSandbox: SandboxResource | undefined,
  sandboxes: Map<string, SandboxResource>,
): SandboxResource | undefined {
  if (entry && typeof entry === "object" && "sandbox" in entry) {
    const sandbox = (entry as { sandbox?: unknown }).sandbox;
    if (sandbox === null) return undefined;

    return resolveLocalSandbox(sandbox, sandboxes);
  }

  return agentSandbox;
}

function workspaceNameFor(entry: unknown): string {
  if (isResource(entry) && entry.kind === "workspace") return entry.name;
  if (entry && typeof entry === "object" && "workspace" in entry) {
    const workspace = (entry as { workspace: unknown }).workspace;
    if (isResource(workspace)) return workspace.name;
    if (typeof workspace === "string") return workspace;
  }

  return "<unknown>";
}

function supportsS3WorkspaceMount(sandbox: SandboxResource): boolean {
  const provider = sandboxProvider(sandbox);
  if (provider === "lambda" || provider === "sandbox") return true;
  if (provider !== "daytona") return false;
  const options = (sandbox.config as { options?: unknown }).options;

  return Boolean(
    options &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    (options as Record<string, unknown>).mountAwsS3Buckets === true,
  );
}

function sandboxProvider(sandbox: SandboxResource): string {
  return typeof sandbox.config.provider === "string"
    ? sandbox.config.provider
    : "sandbox";
}

function assertExportedHarnessSandboxes(resources: AnyResource[]): void {
  const exportedSandboxNames = new Set(
    resources
      .filter(
        (resource): resource is SandboxResource => resource.kind === "sandbox",
      )
      .map((sandbox) => sandbox.name),
  );
  for (const resource of resources) {
    if (resource.kind !== "agent") continue;
    const sandbox = resource.config.harness?.sandbox;
    if (
      isResource(sandbox) &&
      sandbox.kind === "sandbox" &&
      !exportedSandboxNames.has(sandbox.name)
    ) {
      throw new Error(
        `Agent "${resource.name}" harness references sandbox "${sandbox.name}", but that sandbox is not exported from broods/`,
      );
    }
  }
}

function assertUniqueResources(
  resources: Array<{ kind: string; name: string }>,
): void {
  const seen = new Set<string>();
  for (const resource of resources) {
    const key = `${resource.kind}:${resource.name}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate resource: ${key}`);
    }
    seen.add(key);
  }
}

function aliasesForResources(resources: ExportedResource[]): ResourceAliases {
  const aliases: ResourceAliases = {};
  const seenAliases = new Set<string>();
  for (const { exportName, resource } of resources) {
    if (exportName === "default" || !isValidIdentifier(exportName)) continue;
    const key = `${resource.kind}:${exportName}`;
    if (seenAliases.has(key)) {
      throw new Error(
        `Duplicate export alias for ${resource.kind}: ${exportName}`,
      );
    }
    seenAliases.add(key);
    aliases[resource.kind] ??= {};
    aliases[resource.kind]![resource.name] = exportName;
  }

  return aliases;
}

function compileChannels(
  resources: ExportedResource[],
  exports: ExportedValue[],
): CompiledChannel[] {
  const exportedAliases = new Map<AnyConnectionDefinition, string>();
  for (const entry of exports) {
    if (
      !isConnectionDefinition(entry.value) ||
      entry.exportName === "default" ||
      !isValidIdentifier(entry.exportName)
    )
      continue;
    const previous = exportedAliases.get(entry.value);
    if (previous && previous !== entry.exportName) {
      throw new Error(
        `Channel is exported more than once: ${previous}, ${entry.exportName}`,
      );
    }
    exportedAliases.set(entry.value, entry.exportName);
  }

  const owners = new Map<AnyConnectionDefinition, string>();
  const aliases = new Set<string>();
  const compiled: CompiledChannel[] = [];

  for (const { exportName, resource } of resources) {
    if (resource.kind !== "agent") continue;
    const value = (resource.config as { connections?: unknown }).connections;
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(
        `Agent "${resource.name}" config.connections must be an array of connection definitions`,
      );
    }
    const types = new Set<string>();
    for (const entry of value) {
      if (!isConnectionDefinition(entry)) {
        throw new Error(
          `Agent "${resource.name}" config.connections must contain connection definitions`,
        );
      }
      const owner = owners.get(entry);
      if (owner && owner !== resource.name) {
        throw new Error(
          `Channel ${entry.type} is already attached to agent "${owner}" and cannot also attach to "${resource.name}"`,
        );
      }
      if (types.has(entry.type)) {
        throw new Error(
          `Agent "${resource.name}" cannot configure more than one ${entry.type} channel`,
        );
      }
      owners.set(entry, resource.name);
      types.add(entry.type);
      const fallbackAgent =
        exportName !== "default" && isValidIdentifier(exportName)
          ? exportName
          : resource.name;
      const alias =
        exportedAliases.get(entry) ??
        `${fallbackAgent}${capitalize(entry.type)}Channel`;
      if (aliases.has(alias))
        throw new Error(`Duplicate channel export alias: ${alias}`);
      aliases.add(alias);
      compiled.push({
        alias: alias,
        type: entry.type,
        id: alias,
        agentName: resource.name,
      });
    }
  }

  for (const [channel, alias] of exportedAliases) {
    if (!owners.has(channel))
      throw new Error(
        `Channel "${alias}" must be attached to exactly one agent`,
      );
  }

  return compiled.sort((left, right) => left.alias.localeCompare(right.alias));
}

type DeclaredReach = Map<AnyConnectionDefinition, Set<string>>;

/**
 * A connection with no declared channel answers nowhere, which is never what
 * anyone means. Make the author choose here rather than discover the silence
 * on a live webhook.
 */
function assertConnectionReach(
  resources: ExportedResource[],
  reach: DeclaredReach,
): void {
  for (const { resource } of resources) {
    if (resource.kind !== "agent") continue;
    const connections = (resource.config as { connections?: unknown })
      .connections;
    if (!Array.isArray(connections)) continue;
    for (const connection of connections) {
      if (!isConnectionDefinition(connection)) continue;
      if (connectionReach(connection, reach).length > 0) continue;
      throw new Error(
        `Agent "${resource.name}" connection "${connection.type}" reaches no rooms: ` +
          `declare a ${connection.type} channel for it, or set allowedChannelIds: ["*"] to answer everywhere`,
      );
    }
  }
}

/**
 * The rooms a connection answers in: every channel declared against it, plus
 * any id named on the connection itself. The wildcard swallows the rest, since
 * "everywhere" and "these two rooms" cannot both be true.
 */
function connectionReach(
  connection: AnyConnectionDefinition,
  reach: DeclaredReach,
): string[] {
  const named = connection.config.allowedChannelIds ?? [];
  if (named.includes(CHANNEL_REACH_WILDCARD)) return [CHANNEL_REACH_WILDCARD];

  return [...new Set([...(reach.get(connection) ?? []), ...named])];
}

/**
 * A connection reaches exactly the rooms declared as channels against it. That
 * list becomes the adapter's allow list, so an undeclared room is dropped while
 * parsing the webhook, before any record read or policy call.
 */
function declaredReach(resources: AnyResource[]): DeclaredReach {
  const reach: DeclaredReach = new Map();
  for (const resource of resources) {
    if (resource.kind !== "channelRecord") continue;
    const config = resource.config as {
      connection?: unknown;
      externalId?: unknown;
    };
    if (!isConnectionDefinition(config.connection)) continue;
    const ids = channelExternalIds(resource.name, config.externalId);
    if (ids.length === 0) continue;
    const declared = reach.get(config.connection) ?? new Set<string>();
    for (const id of ids) declared.add(id);
    reach.set(config.connection, declared);
  }

  return reach;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

async function toManifestResources(
  entry: ExportedResource,
  projectRoot: string,
  reach: DeclaredReach,
): Promise<CliManifestResource[]> {
  const resource = entry.resource;
  if (resource.kind === "agent") {
    const normalized = normalizeAgentConfig(resource, projectRoot, reach);

    return [
      ...(normalized.hookResource ? [normalized.hookResource] : []),
      {
        kind: resource.kind,
        name: resource.name,
        ...(resource.description ? { description: resource.description } : {}),
        config: normalized.config,
      },
    ];
  }

  if (resource.kind === "channelRecord") {
    const config = resource.config as Record<string, unknown>;
    const ids = channelExternalIds(resource.name, config.externalId);

    // Suffix with the id, never an index: deleting the first of three would
    // renumber the rest, so cliSync would prune and recreate rows that never
    // changed.
    return ids.map((id) => ({
      kind: resource.kind,
      name: ids.length === 1 ? resource.name : `${resource.name}-${id}`,
      ...(resource.description ? { description: resource.description } : {}),
      config: normalizeChannelConfig(resource.name, {
        ...config,
        externalId: id,
      }),
    }));
  }

  return [
    {
      kind: resource.kind,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      config: await normalizeConfig(entry, projectRoot),
    },
  ];
}

/**
 * The ids one channel declares. A single string stays one record; a list fans
 * out to one record per id, so several rooms share one set of rules.
 */
function channelExternalIds(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    assertNotReachWildcard(name, value);

    return [value];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Channel "${name}" externalId must be a string or an array`,
    );
  }
  if (value.length === 0) {
    throw new Error(`Channel "${name}" externalId must not be an empty array`);
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `Channel "${name}" externalId must be an array of non-empty strings`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Channel "${name}" externalId lists ${id} twice`);
    }
    assertNotReachWildcard(name, id);
    seen.add(id);
  }

  return value;
}

/**
 * A record whose id is `*` matches only a chat whose id is literally an
 * asterisk, so it binds nothing while still opening the connection's reach. It
 * deploys clean and the bot looks wired up, so refuse it here.
 */
function assertNotReachWildcard(name: string, id: string): void {
  if (id !== CHANNEL_REACH_WILDCARD) return;

  throw new Error(
    `Channel "${name}" cannot use "${CHANNEL_REACH_WILDCARD}" as its id: a record matches one exact room. ` +
      `To answer everywhere, set allowedChannelIds: ["${CHANNEL_REACH_WILDCARD}"] on the connection; ` +
      `undeclared rooms already fall back to its agent.`,
  );
}

async function normalizeConfig(
  entry: ExportedResource,
  projectRoot: string,
): Promise<unknown> {
  const resource = entry.resource;
  if (resource.kind === "skill") {
    return await normalizeSkillConfig(
      resource.config as { path: string },
      projectRoot,
    );
  }

  if (resource.kind === "workspace") {
    const config = { ...(resource.config as Record<string, unknown>) };
    // Authoring says `partitioned`; storage still reads `isolation`.
    if (config.partitioned !== undefined) {
      if (typeof config.partitioned !== "boolean") {
        throw new Error(
          `Workspace "${resource.name}" config.partitioned must be a boolean`,
        );
      }
      const partitioned = config.partitioned;
      delete config.partitioned;
      if (partitioned) config.isolation = true;
    }

    return rewriteValues(config);
  }

  if (resource.kind === "mcp") {
    return await normalizeMcpConfig(
      entry,
      resource.config as McpServerDefinitionConfig,
      projectRoot,
    );
  }

  if (resource.kind === "policy") {
    const config = { ...(resource.config as Record<string, unknown>) };
    config.version = config.version ?? 1;

    return rewriteValues(config);
  }

  if (resource.kind === "cron") {
    const config = { ...(resource.config as Record<string, unknown>) };
    const agent = config.agent;
    config.agentId = isResource(agent) ? agent.name : agent;
    config.name = config.name ?? resource.name;
    delete config.agent;
    // Mirror the agent direct API: collapse the `input` shorthand into the
    // canonical events list so local and remote manifests diff identically.
    if (typeof config.input === "string") {
      config.events = [
        { role: "user", content: [{ type: "text", text: config.input }] },
      ];
      delete config.input;
    }

    return rewriteValues(config);
  }

  return rewriteValues(resource.config);
}

const CANONICAL_PROVIDER_KEYS = new Set(["apiKey", "base_url", "baseURL"]);
const KNOWN_HARNESS_KEYS = new Set([
  "activeTools",
  "debug",
  "inactiveTools",
  "permissionMode",
  "sandbox",
  "startupTimeoutMs",
  "type",
  "webSearch",
]);
const KNOWN_HARNESS_DEBUG_KEYS = new Set(["enabled", "level", "subsystems"]);

/**
 * Suggest the canonical key for a common misspelling, else "". A setting the SDK
 * has never heard of is fine — it reaches the provider's Vercel AI SDK factory
 * untouched — but a casing slip on one of the few keys broods reads itself
 * (`apiKey`, `base_url`) would silently do nothing, so those still throw.
 */
function suggestProviderKey(key: string): string {
  if (CANONICAL_PROVIDER_KEYS.has(key)) {
    return "";
  }
  const canonical = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (canonical === "baseurl") return `"base_url" or "baseURL"`;
  if (canonical === "apikey") return `"apiKey"`;

  return "";
}

/**
 * Validates each agent's `config.provider` at compile time so a misspelled
 * option — most commonly the camel `baseUrl` instead of `base_url`/`baseURL` —
 * throws inside the `broods dev` watcher (and `deploy`) instead of surfacing as
 * a 400 at run time. Values may be `env("NAME")` refs, so only keys are checked.
 */
export function validateProviderConfig(
  agentName: string,
  provider: unknown,
): void {
  if (provider === undefined || provider === null) return;
  if (typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`Agent "${agentName}" config.provider must be an object`);
  }
  for (const [providerName, settings] of Object.entries(
    provider as Record<string, unknown>,
  )) {
    if (!isAccountModelProviderName(providerName)) {
      throw new Error(
        `Agent "${agentName}" config.provider.${providerName} is not a supported provider (expected one of: ${ACCOUNT_MODEL_PROVIDER_NAMES.join(", ")})`,
      );
    }
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings)
    ) {
      throw new Error(
        `Agent "${agentName}" config.provider.${providerName} must be an object`,
      );
    }
    const record = settings as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const suggestion = suggestProviderKey(key);
      if (suggestion) {
        throw new Error(
          `Agent "${agentName}" config.provider.${providerName} has unknown option "${key}" — did you mean ${suggestion}?`,
        );
      }
    }
    if (
      providerName === "custom" &&
      record.base_url === undefined &&
      record.baseURL === undefined
    ) {
      throw new Error(
        `Agent "${agentName}" config.provider.custom.base_url is required (use "base_url" or "baseURL")`,
      );
    }
  }
}

function validateHarnessConfig(agentName: string, harness: unknown): void {
  if (harness === undefined || harness === null) return;
  if (typeof harness !== "object" || Array.isArray(harness)) {
    throw new Error(`Agent "${agentName}" config.harness must be an object`);
  }
  const config = harness as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN_HARNESS_KEYS.has(key)) {
      throw new Error(
        `Agent "${agentName}" config.harness has unknown option "${key}"`,
      );
    }
  }
  if (
    config.type !== "claude-code" &&
    config.type !== "codex" &&
    config.type !== "deepagents" &&
    config.type !== "opencode" &&
    config.type !== "pi"
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.type must be claude-code, codex, deepagents, opencode, or pi`,
    );
  }
  if (config.sandbox === undefined) {
    throw new Error(
      `Agent "${agentName}" config.harness.sandbox is required for ${config.type}`,
    );
  }
  if (
    config.sandbox !== undefined &&
    !(
      typeof config.sandbox === "string" ||
      (isResource(config.sandbox) && config.sandbox.kind === "sandbox")
    )
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.sandbox must be a defineSandbox resource or sandbox name`,
    );
  }
  if (
    config.permissionMode !== undefined &&
    config.permissionMode !== "allow-reads" &&
    config.permissionMode !== "allow-edits" &&
    config.permissionMode !== "allow-all"
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.permissionMode must be allow-reads, allow-edits, or allow-all`,
    );
  }
  if (
    config.type === "codex" &&
    config.permissionMode !== undefined &&
    config.permissionMode !== "allow-all"
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.permissionMode must be allow-all for codex`,
    );
  }
  if (
    config.startupTimeoutMs !== undefined &&
    (typeof config.startupTimeoutMs !== "number" ||
      !Number.isSafeInteger(config.startupTimeoutMs) ||
      config.startupTimeoutMs < 1 ||
      config.startupTimeoutMs > 600_000)
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.startupTimeoutMs must be an integer from 1 to 600000`,
    );
  }
  if (config.webSearch !== undefined && typeof config.webSearch !== "boolean") {
    throw new Error(
      `Agent "${agentName}" config.harness.webSearch must be a boolean`,
    );
  }
  if (config.type !== "codex" && config.webSearch !== undefined) {
    throw new Error(
      `Agent "${agentName}" config.harness.webSearch is only supported by codex`,
    );
  }
  if (config.type === "pi" && config.startupTimeoutMs !== undefined) {
    throw new Error(
      `Agent "${agentName}" config.harness.startupTimeoutMs is not supported by pi`,
    );
  }
  validateHarnessStringArray(agentName, config.activeTools, "activeTools");
  validateHarnessStringArray(agentName, config.inactiveTools, "inactiveTools");
  if (config.activeTools !== undefined && config.inactiveTools !== undefined) {
    throw new Error(
      `Agent "${agentName}" config.harness must use either activeTools or inactiveTools, not both`,
    );
  }
  validateHarnessDebugConfig(agentName, config.debug);
}

function validateHarnessDebugConfig(agentName: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Agent "${agentName}" config.harness.debug must be an object`,
    );
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN_HARNESS_DEBUG_KEYS.has(key)) {
      throw new Error(
        `Agent "${agentName}" config.harness.debug has unknown option "${key}"`,
      );
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(
      `Agent "${agentName}" config.harness.debug.enabled must be a boolean`,
    );
  }
  if (
    config.level !== undefined &&
    config.level !== "error" &&
    config.level !== "warn" &&
    config.level !== "info" &&
    config.level !== "debug" &&
    config.level !== "trace"
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.debug.level must be error, warn, info, debug, or trace`,
    );
  }
  validateHarnessStringArray(agentName, config.subsystems, "debug.subsystems");
}

function validateHarnessStringArray(
  agentName: string,
  value: unknown,
  field: string,
): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      !value.every(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      ))
  ) {
    throw new Error(
      `Agent "${agentName}" config.harness.${field} must be an array of non-empty strings`,
    );
  }
}

function normalizeAgentConfig(
  resource: Extract<AnyResource, { kind: "agent" }>,
  _projectRoot: string,
  reach: DeclaredReach,
): { config: unknown; hookResource?: CliManifestResource } {
  const config = { ...(resource.config as Record<string, unknown>) };
  validateProviderConfig(resource.name, config.provider);
  validateHarnessConfig(resource.name, config.harness);
  if (
    config.harness &&
    typeof config.harness === "object" &&
    !Array.isArray(config.harness)
  ) {
    const harness = {
      ...(config.harness as Record<string, unknown>),
    };
    if (config.sandbox !== undefined) {
      throw new Error(
        `Agent "${resource.name}" must configure the AI SDK harness sandbox on defineHarness, not defineAgent`,
      );
    }
    config.sandbox = isResource(harness.sandbox)
      ? harness.sandbox.name
      : harness.sandbox;
    delete harness.sandbox;
    config.harness = harness;
  }
  const inlineHooks = normalizeInlineAgentHooks(resource.name, config.hooks);
  if (inlineHooks) {
    config.hooks = inlineHooks.agentHooksConfig;
  } else if (config.hooks !== undefined) {
    config.hooks = stripInlineHookKeys(config.hooks, resource.name);
  }
  if (config.connections !== undefined) {
    if (!Array.isArray(config.connections)) {
      throw new Error(
        `Agent "${resource.name}" config.connections must be an array of connection definitions`,
      );
    }
    config.channels = Object.fromEntries(
      config.connections.map((channel) => {
        if (!isConnectionDefinition(channel)) {
          throw new Error(
            `Agent "${resource.name}" config.connections must contain connection definitions`,
          );
        }
        const channelId = `${resource.name}${capitalize(channel.type)}Channel`;
        const allowedChannelIds = connectionReach(channel, reach);

        return [
          channel.type,
          {
            id: channelId,
            ...channel.config,
            ...(channel.partition ? { partition: channel.partition } : {}),
            allowedChannelIds: allowedChannelIds,
          },
        ];
      }),
    );
    delete config.connections;
  }
  if (isResource(config.sandbox)) {
    config.sandbox = config.sandbox.name;
  }
  if (Array.isArray(config.workspaces)) {
    config.workspaces = config.workspaces.map((workspace) =>
      normalizeWorkspaceRef(workspace, resource.name),
    );
  }
  if (config.policies !== undefined) {
    const policies = normalizePolicyRefs(config.policies, resource.name);
    if (policies) config.policies = policies;
    else delete config.policies;
  }

  return {
    config: rewriteValues(config),
    ...(inlineHooks?.hookResource
      ? { hookResource: inlineHooks.hookResource }
      : {}),
  };
}

function normalizeInlineAgentHooks(
  agentName: string,
  hooks: unknown,
):
  | {
      agentHooksConfig: Record<string, unknown>;
      hookResource: CliManifestResource;
    }
  | undefined {
  if (hooks === undefined) return undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`Agent "${agentName}" config.hooks must be an object`);
  }
  const hookConfig = hooks as Record<string, unknown>;
  const entries = (
    Object.keys(INLINE_AGENT_HOOK_EVENTS) as InlineAgentHookName[]
  ).flatMap((name) => {
    const handler = hookConfig[name];
    if (handler === undefined) return [];
    if (typeof handler !== "function") {
      throw new Error(
        `Agent "${agentName}" config.hooks.${name} must be a function`,
      );
    }

    return [
      {
        name: name,
        event: INLINE_AGENT_HOOK_EVENTS[name],
        source: toHookFunctionExpression(handler.toString()),
      },
    ];
  });

  if (entries.length === 0) return undefined;

  const hookName = `${agentName}-hooks`;
  const bundle = transpileInlineHookBundle(agentName, entries);
  const bundleSize = Buffer.byteLength(bundle);
  if (bundleSize > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(
      `Agent "${agentName}" hook bundle is too large (${bundleSize} bytes, max ${MAX_BUNDLE_FILE_BYTES})`,
    );
  }
  const events = entries.map((entry) => entry.event);
  const agentHooksConfig = stripInlineHookKeys(hookConfig, agentName);
  agentHooksConfig.code = [{ hookId: hookName }];

  return {
    agentHooksConfig: agentHooksConfig,
    hookResource: {
      kind: "hook",
      name: hookName,
      description: `Inline hooks for agent ${agentName}`,
      config: {
        events: events,
        bundle: bundle,
        sha256: sha256Hex(bundle),
      },
    },
  };
}

function stripInlineHookKeys(
  hooks: unknown,
  agentName: string,
): Record<string, unknown> {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`Agent "${agentName}" config.hooks must be an object`);
  }
  const entries = Object.entries(hooks as Record<string, unknown>);
  for (const [key] of entries) {
    if (key === "webhooks" || key in INLINE_AGENT_HOOK_EVENTS) continue;
    throw new Error(
      `Agent "${agentName}" config.hooks.${key} is not supported. ` +
        `Use inline hook callbacks or hooks.webhooks.`,
    );
  }
  const result = Object.fromEntries(
    entries.filter(([key]) => key === "webhooks"),
  );

  return result;
}

// `handler.toString()` on an object-method-shorthand hook (`onStart(ctx) {}`)
// yields `onStart(ctx) {}`, which is not a valid expression when emitted as an
// object-literal value in the bundle. Prefix `function ` to make it a named
// function expression; arrows and function expressions pass through untouched.
function toHookFunctionExpression(source: string): string {
  const trimmed = source.trim();
  if (
    /^(async\s+)?function\b/.test(trimmed) || // function expression
    /^(async\s*)?\(/.test(trimmed) || // (args) => arrow
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(trimmed) // single-arg arrow
  ) {
    return trimmed;
  }
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) {
    return trimmed.replace(/^(async\s+)?/, "$1function ");
  }

  return trimmed;
}

function transpileInlineHookBundle(
  agentName: string,
  entries: Array<{ event: AgentHookEventName; source: string }>,
): string {
  const moduleSource = `export default {\n${entries
    .map((entry) => `  ${JSON.stringify(entry.event)}: ${entry.source},`)
    .join("\n")}\n};\n`;
  try {
    return transformSync(moduleSource, { loader: "ts" }).code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Agent "${agentName}" inline hooks failed to transpile: ${message}`,
    );
  }
}

/**
 * Resolves the policies attached to an agent down to the names the manifest
 * stores. Attachment is only the list: each policy carries its own mode.
 */
function normalizePolicyRefs(
  refs: unknown,
  agentName: string,
): string[] | undefined {
  if (!Array.isArray(refs)) {
    throw new Error(`Agent "${agentName}" config.policies must be an array`);
  }
  const names = refs.map((entry) => {
    if (isResource(entry) && entry.kind === "policy")
      return (entry as PolicyResource).name;
    if (typeof entry === "string") return entry;
    throw new Error(
      `Agent "${agentName}" config.policies must contain definePolicy(...) resources or strings`,
    );
  });

  return names.length > 0 ? names : undefined;
}

/**
 * Import the built bundle and require the fetch-style default export the
 * Lambda host expects (same shape check the child-runner applies), so a
 * server that can never serve throws at deploy time instead of uploading.
 */
async function assertServableMcpBundle(
  manifestPath: string,
  bundle: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "broods-mcp-"));
  try {
    const file = join(dir, "server.mjs");
    await writeFile(file, bundle, "utf8");
    let serverModule: Record<string, unknown>;
    try {
      serverModule = (await import(pathToFileURL(file).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new Error(
        `MCP server bundle ${manifestPath} failed to import: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const handler = serverModule.default;
    const servable =
      typeof handler === "function" ||
      (typeof handler === "object" &&
        handler !== null &&
        typeof (handler as { fetch?: unknown }).fetch === "function");
    if (!servable) {
      throw new Error(
        `MCP server bundle ${manifestPath} default export must be a fetch handler (createMcpHandler)`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run one esbuild bundle build, mapping failures to a deploy-time error. */
async function buildBundleModule(options: {
  entryPoint: string;
  label: string;
  manifestPath: string;
  plugins?: Plugin[];
}): Promise<string> {
  const build = await esbuild({
    entryPoints: [options.entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    minify: false,
    write: false,
    logLevel: "silent",
    plugins: options.plugins ?? [],
  }).catch((error: unknown) => {
    // esbuild throws BuildFailure for source errors, but a plain Error for
    // install/platform problems — surface that cause instead of masking it.
    const details = isBuildFailure(error)
      ? error.errors
          .map((entry) => entry.text)
          .filter(Boolean)
          .join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(
      `${options.label} ${options.manifestPath} failed to build${details ? `: ${details}` : ""}`,
    );
  });
  if (build.outputFiles.length !== 1) {
    throw new Error(
      `${options.label} ${options.manifestPath} failed to build: expected one output file`,
    );
  }

  return build.outputFiles[0]!.text;
}

async function normalizeSkillConfig(
  config: { path: string },
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const skillRoot = resolveContainedResourcePath(
    projectRoot,
    config.path,
    "Skill",
  );
  const manifestPath = relative(projectRoot, skillRoot).split("\\").join("/");
  const files = await readBundleFiles(skillRoot);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Skill folder ${config.path} must contain SKILL.md`);
  }

  return {
    source: "files",
    path: manifestPath,
    files: files,
  };
}

/**
 * An mcp resource with `url` syncs as-is (external server); one with `path`
 * bundles the module whose default export is a fetch-style MCP handler, and
 * the row becomes `transport: "hosted"` on the backend (#331 phase 2).
 */
async function normalizeMcpConfig(
  entry: ExportedResource,
  config: McpServerDefinitionConfig,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const { path: serverPath, ...rest } = config;
  if (serverPath !== undefined && config.url !== undefined) {
    throw new Error(
      `MCP server "${entry.resource.name}" declares both url and path; pick one`,
    );
  }
  if (serverPath === undefined) {
    if (config.url === undefined) {
      throw new Error(
        `MCP server "${entry.resource.name}" needs url (external) or path (hosted)`,
      );
    }

    return rewriteValues(rest) as Record<string, unknown>;
  }

  const bundlePath = resolveContainedResourcePath(
    projectRoot,
    serverPath,
    "MCP server",
  );
  const manifestPath = relative(projectRoot, bundlePath).split("\\").join("/");
  assertSafeBundlePath(manifestPath, "MCP server");
  const bundle = await buildBundleModule({
    entryPoint: bundlePath,
    label: "MCP server bundle",
    manifestPath: manifestPath,
  });
  const bundleSize = Buffer.byteLength(bundle);
  if (bundleSize > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(
      `MCP server bundle ${manifestPath} is too large (${bundleSize} bytes, max ${MAX_BUNDLE_FILE_BYTES})`,
    );
  }
  await assertServableMcpBundle(manifestPath, bundle);

  return {
    ...(rewriteValues(rest) as Record<string, unknown>),
    bundle: bundle,
  };
}

/**
 * Normalizes one agent `workspaces` entry into the manifest wire shape
 * `{ name, workspaceId, sandbox? }`. Accepts a bare `defineWorkspace(...)`
 * resource or the `{ workspace, sandbox? }` override form; the workspace name
 * doubles as the `workspaceId` placeholder that the backend resolves to a real
 * id, and a per-workspace `sandbox` (resource, name, or `null`) is preserved.
 */
function normalizeWorkspaceRef(
  entry: unknown,
  agentName: string,
): Record<string, unknown> {
  if (isResource(entry)) {
    return { name: entry.name, workspaceId: entry.name };
  }
  if (entry && typeof entry === "object" && "workspace" in entry) {
    const ref = (entry as { workspace: unknown }).workspace;
    const name = isResource(ref) ? ref.name : ref;
    if (typeof name !== "string") {
      throw new Error(
        `Agent ${agentName} workspace ref must be a defineWorkspace(...) resource or its name`,
      );
    }
    const normalized: Record<string, unknown> = {
      name: name,
      workspaceId: name,
    };
    if ("sandbox" in entry) {
      const sandbox = (entry as { sandbox?: unknown }).sandbox;
      normalized.sandbox =
        sandbox === null ? null : isResource(sandbox) ? sandbox.name : sandbox;
    }

    return normalized;
  }
  throw new Error(
    `Agent ${agentName} workspaces must be defineWorkspace(...) resources or { workspace, sandbox } refs`,
  );
}

function resolveContainedResourcePath(
  projectRoot: string,
  resourcePath: string,
  kind: "Skill" | "MCP server",
): string {
  if (resourcePath.trim().length === 0)
    throw new Error(`${kind} path is required`);
  if (resourcePath.includes("\0"))
    throw new Error(`${kind} path must not contain null bytes`);
  const root = resolve(projectRoot);
  const target = resolve(root, resourcePath);
  const rel = relative(root, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;

  throw new Error(
    `${kind} path ${resourcePath} must stay inside ${PROJECT_DIR}/`,
  );
}

// The SDK says `connection` and `agents`; storage says `platform` and
// `agentBindings`. Drop the credentials too, or `rewriteValues` inlines them.
function normalizeChannelConfig(name: string, value: unknown): unknown {
  const config = { ...(value as Record<string, unknown>) };
  const connection = config.connection;
  if (!isConnectionDefinition(connection)) {
    throw new Error(
      `Channel "${name}" config.connection must be a connection definition`,
    );
  }
  delete config.connection;
  config.platform = connection.type;

  assertPartitionShape(
    config.partition as AnyConnectionDefinition["partition"],
    `Channel "${name}"`,
  );

  return rewriteValues(config);
}

function rewriteValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValues(entry));
  }
  if (isResource(value)) {
    return value.name;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteValues(entry)]),
    );
  }

  return value;
}

async function readBundleFiles(
  root: string,
): Promise<Array<Record<string, unknown>>> {
  const files: Array<Record<string, unknown>> = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      if (entry.isDirectory()) {
        if (shouldSkipBundleEntry(entry.name)) continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        if (shouldSkipBundleEntry(entry.name) || isUnsafeBundlePath(rel))
          continue;
        const bytes = await readFile(absolute);
        if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) {
          throw new Error(
            `Skill bundle file ${rel} is too large (${bytes.byteLength} bytes, max ${MAX_BUNDLE_FILE_BYTES})`,
          );
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error(
            `Skill bundle at ${root} is too large (${totalBytes} bytes, max ${MAX_BUNDLE_TOTAL_BYTES})`,
          );
        }
        if (files.length >= MAX_BUNDLE_FILES) {
          throw new Error(
            `Skill bundle at ${root} has too many files (max ${MAX_BUNDLE_FILES})`,
          );
        }
        files.push({
          path: rel,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
          contentBase64: bytes.toString("base64"),
          contentType: contentTypeForPath(rel),
        });
      }
    }
  }

  await walk(root);

  return files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function shouldSkipBundleEntry(name: string): boolean {
  return name.startsWith(".") || SKIPPED_BUNDLE_DIRECTORIES.has(name);
}

function assertSafeBundlePath(
  path: string,
  kind: "Skill" | "MCP server",
): void {
  if (isUnsafeBundlePath(path)) {
    throw new Error(
      `${kind} bundle path ${path} looks like a hidden file or secret and will not be bundled`,
    );
  }
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return (
    error instanceof Error && Array.isArray((error as BuildFailure).errors)
  );
}

function isUnsafeBundlePath(path: string): boolean {
  const parts = path.split("/");

  return parts.some(
    (part) =>
      part.startsWith(".") ||
      UNSAFE_BUNDLE_FILE_NAMES.some((pattern) => pattern.test(part)),
  );
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return "application/javascript";
  if (path.endsWith(".ts")) return "text/typescript; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";

  return "application/octet-stream";
}

function normalizeProjectName(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

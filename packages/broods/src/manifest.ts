/**
 * Compiles `broods/` TypeScript resources into the SaaS CLI manifest.
 */

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CliManifest, CliManifestResource } from "./contracts.ts";
import { GENERATED_DIR, PROJECT_DIR } from "./config.ts";
import { loadBroodsRuntimeConfig } from "./runtime-config.ts";
import {
  isChannelDefinition,
  isBroodsConfig,
  isResource,
  type AnyChannelDefinition,
  type AnyResource,
  type BroodsConfigDefinition,
  type BroodsProjectConfig,
  type SandboxResource,
} from "./resources.ts";

export interface CompileOptions {
  cwd?: string;
  project?: string;
  environment?: string;
  command?: "dev" | "deploy";
  useRuntimeEnvironment?: boolean;
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
  type: AnyChannelDefinition["type"];
  agentName: string;
}

export type ResourceAliases = Partial<Record<AnyResource["kind"], Record<string, string>>>;

type ExportedValue = {
  exportName: string;
  value: unknown;
};

type ExportedResource = {
  exportName: string;
  resource: AnyResource;
};

const MAX_BUNDLE_FILE_BYTES = 1_000_000;
const MAX_BUNDLE_TOTAL_BYTES = 5_000_000;
const MAX_BUNDLE_FILES = 200;
const SKIPPED_BUNDLE_DIRECTORIES = new Set(["node_modules", ".git"]);
const UNSAFE_BUNDLE_FILE_NAMES = [
  /^\.env(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

export async function compileProject(options: CompileOptions = {}): Promise<CompiledProject> {
  const cwd = options.cwd ?? process.cwd();
  loadBroodsRuntimeConfig(cwd);
  const root = resolve(cwd, PROJECT_DIR);
  const files = await listTypeScriptFiles(root);
  const exports = await loadExports(files);
  const config = await findConfig(exports, cwd, options.project);
  const resourceExports = exports
    .filter((entry): entry is ExportedValue & { value: AnyResource } => isResource(entry.value))
    .map((entry): ExportedResource => ({ exportName: entry.exportName, resource: entry.value }));
  const resources = resourceExports.map((entry) => entry.resource);
  assertUniqueResources(resources);
  const channels = compileChannels(resourceExports, exports);
  for (const resource of resources) assertKnownConfigKeys(resource);
  for (const resource of resources) assertSupportedWorkspaceStorage(resource);
  assertSupportedWorkspaceSandboxMounts(resources);
  const resourceAliases = aliasesForResources(resourceExports);
  const environment = resolveEnvironment(
    config,
    options.environment ?? (options.useRuntimeEnvironment === false ? undefined : process.env.BROODS_ENVIRONMENT),
    options.command ?? "dev",
  );
  const manifestResources = (await Promise.all(resources.map((resource) => toManifestResource(resource, root)))).sort((a, b) =>
    `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`),
  );

  return {
    config: config,
    resources: resources,
    resourceAliases: resourceAliases,
    channels: channels,
    manifest: {
      version: 1,
      project: config.project!,
      environment: environment,
      resources: manifestResources,
    },
  };
}

/**
 * Collects the distinct account/environment variable names referenced via
 * `env.NAME` (the `{ __beeblastEnv }` marker) across every resource config in a
 * compiled manifest, sorted. `dev` uses this to auto-sync exactly those vars
 * from the local environment to the cloud — never unrelated `.env.local` keys.
 */
export function collectEnvRefNames(manifest: CliManifest): string[] {
  const names = new Set<string>();

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.__beeblastEnv === true && typeof record.name === "string") {
        names.add(record.name);
        return;
      }
      for (const entry of Object.values(record)) walk(entry);
    }
  }

  for (const resource of manifest.resources) walk(resource.config);

  return [...names].sort();
}

function resolveEnvironment(
  config: BroodsProjectConfig,
  explicit: string | undefined,
  command: "dev" | "deploy",
): string {
  if (explicit) return explicit;
  const configured = config.environments?.[command];
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
        if (entry.name === GENERATED_DIR || entry.name === "generated") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

async function loadExports(files: string[]): Promise<ExportedValue[]> {
  const values: ExportedValue[] = [];
  for (const file of files) {
    const href = `${pathToFileURL(file).href}?t=${Date.now()}`;
    const mod = await import(href) as Record<string, unknown>;
    values.push(...Object.entries(mod).map(([exportName, value]) => ({ exportName, value })));
  }
  return values;
}

async function findConfig(
  exports: ExportedValue[],
  cwd: string,
  explicitProject: string | undefined,
): Promise<BroodsProjectConfig> {
  const config = exports.find((entry): entry is ExportedValue & { value: BroodsConfigDefinition } =>
    isBroodsConfig(entry.value)
  )?.value;
  const configValue = config?.config ?? {};
  const project = explicitProject ??
    process.env.BROODS_PROJECT ??
    configValue.project ??
    normalizeProjectName(basename(resolve(cwd)));
  if (!project.trim()) {
    throw new Error("Project name is required. Pass --project <name> or set BROODS_PROJECT.");
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
  "model",
  "provider",
  "session",
  "hooks",
  "channels",
  "tools",
  "sandbox",
  "workspaces",
  "subagent",
  "skills",
  "publicAccess",
]);

/** Common typos mapped to the key the author almost certainly meant. */
const AGENT_KEY_SUGGESTIONS: Record<string, string> = {
  workspace: "workspaces",
  skill: "skills",
  tool: "tools",
  channel: "channels",
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
 * loop even though `bun` does not run `tsc`.
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
    throw new Error(`Agent "${resource.name}" has an unknown config key "${key}".${hint}`);
  }
}

/**
 * Runtime validation for code-first workspace storage. TypeScript catches this
 * when callers typecheck, but `broods dev/deploy` must also fail before
 * upload because the CLI loads resource modules directly with Bun.
 */
function assertSupportedWorkspaceStorage(resource: AnyResource): void {
  if (resource.kind !== "workspace") return;
  const config = resource.config as unknown as Record<string, unknown>;
  const storage = config.storage;
  if (storage === undefined) return;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    throw new Error(`Workspace "${resource.name}" config.storage must be an object`);
  }
  const provider = (storage as Record<string, unknown>).provider;
  if (provider === undefined || provider === "s3") return;
  if (provider === "vercel") {
    throw new Error(
      `Workspace "${resource.name}" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet. ` +
        `Use storage.provider "s3" or omit storage until Vercel Drive is wired.`,
    );
  }
  throw new Error(`Workspace "${resource.name}" config.storage.provider must be one of: s3`);
}

function assertSupportedWorkspaceSandboxMounts(resources: AnyResource[]): void {
  const sandboxes = new Map(resources.filter((resource) => resource.kind === "sandbox").map((resource) => [resource.name, resource]));
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

function resolveLocalSandbox(value: unknown, sandboxes: Map<string, SandboxResource>): SandboxResource | undefined {
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
  return Boolean(options && typeof options === "object" && !Array.isArray(options) &&
    (options as Record<string, unknown>).mountAwsS3Buckets === true);
}

function sandboxProvider(sandbox: SandboxResource): string {
  return typeof sandbox.config.provider === "string" ? sandbox.config.provider : "lambda";
}

function assertUniqueResources(resources: AnyResource[]): void {
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
      throw new Error(`Duplicate export alias for ${resource.kind}: ${exportName}`);
    }
    seenAliases.add(key);
    aliases[resource.kind] ??= {};
    aliases[resource.kind]![resource.name] = exportName;
  }

  return aliases;
}

function compileChannels(resources: ExportedResource[], exports: ExportedValue[]): CompiledChannel[] {
  const exportedAliases = new Map<AnyChannelDefinition, string>();
  for (const entry of exports) {
    if (!isChannelDefinition(entry.value) || entry.exportName === "default" || !isValidIdentifier(entry.exportName)) continue;
    const previous = exportedAliases.get(entry.value);
    if (previous && previous !== entry.exportName) {
      throw new Error(`Channel is exported more than once: ${previous}, ${entry.exportName}`);
    }
    exportedAliases.set(entry.value, entry.exportName);
  }

  const owners = new Map<AnyChannelDefinition, string>();
  const aliases = new Set<string>();
  const compiled: CompiledChannel[] = [];

  for (const { exportName, resource } of resources) {
    if (resource.kind !== "agent") continue;
    const value = (resource.config as { channels?: unknown }).channels;
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(`Agent "${resource.name}" config.channels must be an array of channel definitions`);
    }
    const types = new Set<string>();
    for (const entry of value) {
      if (!isChannelDefinition(entry)) {
        throw new Error(`Agent "${resource.name}" config.channels must contain channel definitions`);
      }
      const owner = owners.get(entry);
      if (owner && owner !== resource.name) {
        throw new Error(`Channel ${entry.type} is already attached to agent "${owner}" and cannot also attach to "${resource.name}"`);
      }
      if (types.has(entry.type)) {
        throw new Error(`Agent "${resource.name}" cannot configure more than one ${entry.type} channel`);
      }
      owners.set(entry, resource.name);
      types.add(entry.type);
      const fallbackAgent = exportName !== "default" && isValidIdentifier(exportName) ? exportName : resource.name;
      const alias = exportedAliases.get(entry) ?? `${fallbackAgent}${capitalize(entry.type)}Channel`;
      if (aliases.has(alias)) throw new Error(`Duplicate channel export alias: ${alias}`);
      aliases.add(alias);
      compiled.push({ alias, type: entry.type, agentName: resource.name });
    }
  }

  for (const [channel, alias] of exportedAliases) {
    if (!owners.has(channel)) throw new Error(`Channel "${alias}" must be attached to exactly one agent`);
  }

  return compiled.sort((left, right) => left.alias.localeCompare(right.alias));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

async function toManifestResource(resource: AnyResource, projectRoot: string): Promise<CliManifestResource> {
  return {
    kind: resource.kind,
    name: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    config: await normalizeConfig(resource, projectRoot),
  };
}

async function normalizeConfig(resource: AnyResource, projectRoot: string): Promise<unknown> {
  if (resource.kind === "agent") {
    const config = { ...(resource.config as Record<string, unknown>) };
    if (config.channels !== undefined) {
      if (!Array.isArray(config.channels)) {
        throw new Error(`Agent "${resource.name}" config.channels must be an array of channel definitions`);
      }
      config.channels = Object.fromEntries(config.channels.map((channel) => {
        if (!isChannelDefinition(channel)) {
          throw new Error(`Agent "${resource.name}" config.channels must contain channel definitions`);
        }
        return [channel.type, channel.config];
      }));
    }
    if (isResource(config.sandbox)) {
      config.sandbox = config.sandbox.name;
    }
    if (Array.isArray(config.workspaces)) {
      config.workspaces = config.workspaces.map((workspace) => normalizeWorkspaceRef(workspace, resource.name));
    }
    return rewriteValues(config);
  }

  if (resource.kind === "skill") {
    return await normalizeSkillConfig(resource.config as { path: string }, projectRoot);
  }

  if (resource.kind === "tool") {
    return await normalizeToolConfig(resource.config as {
      path: string;
      description: string;
      inputSchema: Record<string, unknown>;
      defaultConfig?: Record<string, unknown>;
    }, projectRoot);
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
      config.events = [{ role: "user", content: [{ type: "text", text: config.input }] }];
      delete config.input;
    }
    return rewriteValues(config);
  }

  return rewriteValues(resource.config);
}

async function normalizeSkillConfig(config: { path: string }, projectRoot: string): Promise<Record<string, unknown>> {
  const skillRoot = resolveContainedResourcePath(projectRoot, config.path, "Skill");
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

async function normalizeToolConfig(
  config: {
    path: string;
    description: string;
    inputSchema: Record<string, unknown>;
    defaultConfig?: Record<string, unknown>;
  },
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const bundlePath = resolveContainedResourcePath(projectRoot, config.path, "Tool");
  const manifestPath = relative(projectRoot, bundlePath).split("\\").join("/");
  assertSafeBundlePath(manifestPath, "Tool");
  const sourceSize = Buffer.byteLength(await readFile(bundlePath));
  if (sourceSize > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(`Tool source ${manifestPath} is too large (${sourceSize} bytes, max ${MAX_BUNDLE_FILE_BYTES})`);
  }
  const build = await Bun.build({
    entrypoints: [bundlePath],
    root: projectRoot,
    target: "node",
    format: "esm",
    minify: false,
  });
  if (!build.success || build.outputs.length !== 1) {
    const details = build.logs.map((entry) => entry.message).filter(Boolean).join("; ");
    throw new Error(`Tool bundle ${manifestPath} failed to build${details ? `: ${details}` : ""}`);
  }
  const bundle = await build.outputs[0]!.text();
  const bundleSize = Buffer.byteLength(bundle);
  if (bundleSize > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(`Tool bundle ${manifestPath} is too large (${bundleSize} bytes, max ${MAX_BUNDLE_FILE_BYTES})`);
  }

  return {
    path: manifestPath,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.defaultConfig !== undefined ? { defaultConfig: config.defaultConfig } : {}),
    bundle: bundle,
    sha256: sha256Hex(bundle),
  };
}

/**
 * Normalizes one agent `workspaces` entry into the manifest wire shape
 * `{ name, workspaceId, sandbox? }`. Accepts a bare `defineWorkspace(...)`
 * resource or the `{ workspace, sandbox? }` override form; the workspace name
 * doubles as the `workspaceId` placeholder that the backend resolves to a real
 * id, and a per-workspace `sandbox` (resource, name, or `null`) is preserved.
 */
function normalizeWorkspaceRef(entry: unknown, agentName: string): Record<string, unknown> {
  if (isResource(entry)) {
    return { name: entry.name, workspaceId: entry.name };
  }
  if (entry && typeof entry === "object" && "workspace" in entry) {
    const ref = (entry as { workspace: unknown }).workspace;
    const name = isResource(ref) ? ref.name : ref;
    if (typeof name !== "string") {
      throw new Error(`Agent ${agentName} workspace ref must be a defineWorkspace(...) resource or its name`);
    }
    const normalized: Record<string, unknown> = { name: name, workspaceId: name };
    if ("sandbox" in entry) {
      const sandbox = (entry as { sandbox?: unknown }).sandbox;
      normalized.sandbox = sandbox === null ? null : isResource(sandbox) ? sandbox.name : sandbox;
    }
    return normalized;
  }
  throw new Error(`Agent ${agentName} workspaces must be defineWorkspace(...) resources or { workspace, sandbox } refs`);
}

function resolveContainedResourcePath(projectRoot: string, resourcePath: string, kind: "Skill" | "Tool"): string {
  if (resourcePath.trim().length === 0) throw new Error(`${kind} path is required`);
  if (resourcePath.includes("\0")) throw new Error(`${kind} path must not contain null bytes`);
  const root = resolve(projectRoot);
  const target = resolve(root, resourcePath);
  const rel = relative(root, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;

  throw new Error(`${kind} path ${resourcePath} must stay inside ${PROJECT_DIR}/`);
}

function rewriteValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValues(entry));
  }
  if (isResource(value)) {
    return value.name;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteValues(entry)]));
  }

  return value;
}

async function readBundleFiles(root: string): Promise<Array<Record<string, unknown>>> {
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
        if (shouldSkipBundleEntry(entry.name) || isUnsafeBundlePath(rel)) continue;
        const bytes = await readFile(absolute);
        if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) {
          throw new Error(`Skill bundle file ${rel} is too large (${bytes.byteLength} bytes, max ${MAX_BUNDLE_FILE_BYTES})`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error(`Skill bundle at ${root} is too large (${totalBytes} bytes, max ${MAX_BUNDLE_TOTAL_BYTES})`);
        }
        if (files.length >= MAX_BUNDLE_FILES) {
          throw new Error(`Skill bundle at ${root} has too many files (max ${MAX_BUNDLE_FILES})`);
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

function assertSafeBundlePath(path: string, kind: "Skill" | "Tool"): void {
  if (isUnsafeBundlePath(path)) {
    throw new Error(`${kind} bundle path ${path} looks like a hidden file or secret and will not be bundled`);
  }
}

function isUnsafeBundlePath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) =>
    part.startsWith(".") ||
    UNSAFE_BUNDLE_FILE_NAMES.some((pattern) => pattern.test(part))
  );
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
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

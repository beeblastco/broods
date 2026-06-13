/**
 * Compiles `filthypanty/` TypeScript resources into the SaaS CLI manifest.
 */

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { CliManifest, CliManifestResource } from "./contracts.ts";
import { GENERATED_DIR, PROJECT_DIR } from "./config.ts";
import {
  isFilthyPantyConfig,
  isResource,
  type AnyResource,
  type FilthyPantyProjectConfig,
} from "./resources.ts";

export interface CompileOptions {
  cwd?: string;
  project?: string;
  environment?: string;
  command?: "dev" | "deploy";
}

export interface CompiledProject {
  config: FilthyPantyProjectConfig;
  manifest: CliManifest;
  resources: AnyResource[];
}

export async function compileProject(options: CompileOptions = {}): Promise<CompiledProject> {
  const cwd = options.cwd ?? process.cwd();
  const root = resolve(cwd, PROJECT_DIR);
  const files = await listTypeScriptFiles(root);
  const exports = await loadExports(files);
  const config = await findConfig(exports, cwd, options.project);
  const resources = exports.filter(isResource);
  assertUniqueResources(resources);
  const environment = resolveEnvironment(config, options.environment, options.command ?? "dev");
  const manifestResources = (await Promise.all(resources.map((resource) => toManifestResource(resource, root)))).sort((a, b) =>
    `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`),
  );

  return {
    config: config,
    resources: resources,
    manifest: {
      version: 1,
      project: config.project!,
      environment: environment,
      resources: manifestResources,
    },
  };
}

export function resolveEnvironment(
  config: FilthyPantyProjectConfig,
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

async function loadExports(files: string[]): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const file of files) {
    const href = `${pathToFileURL(file).href}?t=${Date.now()}`;
    const mod = await import(href) as Record<string, unknown>;
    values.push(...Object.values(mod));
  }
  return values;
}

async function findConfig(
  exports: unknown[],
  cwd: string,
  explicitProject: string | undefined,
): Promise<FilthyPantyProjectConfig> {
  const config = exports.find(isFilthyPantyConfig)?.config ?? {};
  const project = explicitProject ??
    process.env.FILTHY_PANTY_PROJECT ??
    config.project ??
    await inferProjectName(cwd);
  if (!project.trim()) {
    throw new Error("Project name is required. Pass --project <name> or set FILTHY_PANTY_PROJECT.");
  }

  return {
    ...config,
    project: project,
  };
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

  if (resource.kind === "cronJob") {
    const config = { ...(resource.config as Record<string, unknown>) };
    const agent = config.agent;
    config.agentId = isResource(agent) ? agent.name : agent;
    config.name = config.name ?? resource.name;
    delete config.agent;
    return rewriteValues(config);
  }

  return rewriteValues(resource.config);
}

async function normalizeSkillConfig(config: { path: string }, projectRoot: string): Promise<Record<string, unknown>> {
  const skillRoot = resolve(projectRoot, config.path);
  const files = await readBundleFiles(skillRoot);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Skill folder ${config.path} must contain SKILL.md`);
  }

  return {
    source: "files",
    path: config.path,
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
  const bundle = await readFile(resolve(projectRoot, config.path), "utf8");

  return {
    path: config.path,
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

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
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

async function inferProjectName(cwd: string): Promise<string> {
  return normalizeProjectName(basename(resolve(cwd)));
}

function normalizeProjectName(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compiles `filthypanty/` TypeScript resources into the SaaS CLI manifest.
 */

import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CliManifest, CliManifestResource } from "./contracts.ts";
import { PROJECT_CONFIG_FILE, PROJECT_DIR } from "./config.ts";
import {
  isFilthyPantyConfig,
  isResource,
  type AnyResource,
  type FilthyPantyProjectConfig,
} from "./resources.ts";

export interface CompileOptions {
  cwd?: string;
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
  const config = findConfig(exports);
  const resources = exports.filter(isResource);
  assertUniqueResources(resources);
  const environment = resolveEnvironment(config, options.environment, options.command ?? "dev");
  const manifestResources = resources.map(toManifestResource).sort((a, b) =>
    `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`),
  );

  return {
    config: config,
    resources: resources,
    manifest: {
      version: 1,
      project: config.project,
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
        if (entry.name === "generated") continue;
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

function findConfig(exports: unknown[]): FilthyPantyProjectConfig {
  const config = exports.find(isFilthyPantyConfig)?.config;
  if (!config) {
    throw new Error(`${PROJECT_DIR}/${PROJECT_CONFIG_FILE} must export default defineFilthyPanty(...)`);
  }
  if (!config.project?.trim()) {
    throw new Error("filthy-panty config must include a project name");
  }

  return config;
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

function toManifestResource(resource: AnyResource): CliManifestResource {
  return {
    kind: resource.kind,
    name: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    config: normalizeConfig(resource),
  };
}

function normalizeConfig(resource: AnyResource): unknown {
  if (resource.kind === "agent") {
    const config = { ...(resource.config as Record<string, unknown>) };
    if (isResource(config.sandbox)) {
      config.sandbox = config.sandbox.name;
    }
    if (Array.isArray(config.workspaces)) {
      config.workspaces = config.workspaces.map((workspace) => {
        if (!isResource(workspace)) {
          throw new Error(`Agent ${resource.name} workspaces must be defineWorkspace(...) resources`);
        }

        return { name: workspace.name, workspaceId: workspace.name };
      });
    }
    return rewriteValues(config);
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

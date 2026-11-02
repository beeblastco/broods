// Synchronous and dependency-free: the BroodsClient constructor calls it without awaiting.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStoredAuth, stageFromEnv } from "./config.ts";

export interface BroodsRuntimeConfig {
  dashboardUrl?: string;
  baseUrl?: string;
  token?: string;
  project?: string;
  stage?: string;
}

interface EnvCacheEntry {
  mtimeMs: number;
}

const envFileCache = new Map<string, EnvCacheEntry>();

const realEnvSnapshot = new Set(Object.keys(process.env));

const loadedFromFiles = new Set<string>();

export function loadBroodsRuntimeConfig(
  cwd = process.cwd(),
): BroodsRuntimeConfig {
  loadEnvFiles(cwd);
  const stored = readStoredAuth();

  return {
    dashboardUrl: process.env.BROODS_DASHBOARD_URL ?? stored?.dashboardUrl,
    baseUrl: process.env.BROODS_BASE_URL ?? stored?.baseUrl,
    // From the resolved login only, so it always belongs to the same server.
    token: stored?.token,
    project: process.env.BROODS_PROJECT,
    stage: stageFromEnv(),
  };
}

// An agent shell that could `echo $BROODS_API_KEY` could call the stage as the developer.
export function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !name.startsWith("BROODS_")) {
      env[name] = value;
    }
  }

  return env;
}

// Reads the files, not a startup snapshot: Bun loads `.env.local` before any user code runs.
export function isShellOwnedEnv(name: string, cwd = process.cwd()): boolean {
  const current = process.env[name];
  if (current === undefined) return false;
  const root = resolve(cwd);
  for (const file of [".env.local", ".env"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const values = parseEnv(readFileSync(path, "utf8"));
    if (values[name] !== undefined) return values[name] !== current;
  }

  return true;
}

// Never overwrites a shell export (`BROODS_STAGE=x broods dev`), only keys an earlier load set.
function loadEnvFiles(cwd: string): void {
  const root = resolve(cwd);
  // `dev` children inherit the parent's loaded values, so they cannot tell them from the shell's.
  const forceReload = process.env.BROODS_RELOAD_ENV === "1";

  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) {
      envFileCache.delete(path);
      continue;
    }
    const mtimeMs = statSync(path).mtimeMs;
    const cached = envFileCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) continue;
    envFileCache.set(path, { mtimeMs: mtimeMs });

    for (const [key, value] of Object.entries(
      parseEnv(readFileSync(path, "utf8")),
    )) {
      if (
        forceReload ||
        !realEnvSnapshot.has(key) ||
        loadedFromFiles.has(key)
      ) {
        process.env[key] = value;
        loadedFromFiles.add(key);
      }
    }
  }
}

export function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;
    const key = assignment.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(assignment.slice(eq + 1).trim());
  }

  return values;
}

function unquoteEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const commentIndex = value.indexOf(" #");

  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

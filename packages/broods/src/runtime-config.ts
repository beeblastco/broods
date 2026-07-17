/**
 * Runtime config (dashboard URL, token, project, environment) for SDK/CLI callers.
 *
 * Reads `.env`/`.env.local` from the target project directory (`cwd`, which is
 * not always the directory the process started in) so a generated client picks
 * up package-local config without wiring up dotenv. Kept zero-dependency and
 * synchronous so the BroodsClient constructor can call it without awaiting.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { USER_CONFIG_PATH, stripTrailingSlash } from "./config.ts";

export interface BroodsRuntimeConfig {
  /** Dashboard UI base URL; only used for browser login and deep links. */
  dashboardUrl?: string;
  /** Convex control-plane base URL for /v1/account/* calls. */
  baseUrl?: string;
  token?: string;
  project?: string;
  environment?: string;
}

interface EnvCacheEntry {
  mtimeMs: number;
}

const envFileCache = new Map<string, EnvCacheEntry>();

/**
 * Snapshot of `process.env` keys captured once at module load time. Represents
 * the "real" shell environment before any `.env`/`.env.local` loading. Used to
 * decide which variables `loadEnvFiles` is allowed to set: it will never touch
 * a key that was already present at startup (i.e. set in the shell), but it
 * *will* overwrite keys it loaded itself on a previous call.
 */
const realEnvSnapshot = new Set(Object.keys(process.env));

/**
 * Keys that were loaded from a `.env`/`.env.local` file by this module. On
 * re-read (file mtime changed) these can be overwritten; keys outside this set
 * that were present at startup are treated as part of the real environment and
 * left untouched.
 */
const loadedFromFiles = new Set<string>();

export function loadBroodsRuntimeConfig(
  cwd = process.cwd(),
): BroodsRuntimeConfig {
  loadEnvFiles(cwd);
  const stored = readStoredAuthSync();

  return {
    dashboardUrl: process.env.BROODS_DASHBOARD_URL ?? stored?.dashboardUrl,
    baseUrl: process.env.BROODS_BASE_URL ?? stored?.baseUrl,
    token: process.env.BROODS_TOKEN ?? stored?.token,
    project: process.env.BROODS_PROJECT,
    environment: process.env.BROODS_ENVIRONMENT,
  };
}

/**
 * Loads `.env` then `.env.local` from `cwd` into `process.env`, so `.env.local`
 * overrides `.env`. A variable is only set when:
 *
 *  1. It was NOT present in the real shell environment at module load time, OR
 *  2. It was previously loaded from a `.env`/`.env.local` file by this module.
 *
 * This lets `dev` child processes pick up `.env.local` edits while still
 * respecting variables exported in the shell (`BROODS_ENVIRONMENT=staging broods dev`).
 *
 * Cached by file path + mtime so unchanged files are not re-read.
 */
function loadEnvFiles(cwd: string): void {
  const root = resolve(cwd);
  // When BROODS_RELOAD_ENV is set (by `dev` child processes), skip the
  // real-env guard so `.env.local` edits are always picked up even when the
  // child inherited stale values from the parent's process.env.
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
    envFileCache.set(path, { mtimeMs });

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

/** Parses dotenv-style `KEY=value` lines, tolerating `export `, comments, and blanks. */
function parseEnv(source: string): Record<string, string> {
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
  // Double-quoted: strip the quotes and unescape \n and \".
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  // Single-quoted: strip the quotes, keep the contents literal.
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Unquoted: drop a trailing ` # comment`, if present.
  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

/**
 * Reads the CLI-stored auth (Convex URL + token) synchronously so the client
 * constructor can use it without awaiting. Returns null when the file is
 * absent, malformed, or predates the Convex-direct control plane.
 */
function readStoredAuthSync(): {
  baseUrl: string;
  dashboardUrl?: string;
  token: string;
} | null {
  try {
    const value = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf8")) as {
      baseUrl?: unknown;
      dashboardUrl?: unknown;
      token?: unknown;
    };
    if (typeof value.baseUrl !== "string" || typeof value.token !== "string")
      return null;
    return {
      baseUrl: stripTrailingSlash(value.baseUrl),
      ...(typeof value.dashboardUrl === "string"
        ? { dashboardUrl: stripTrailingSlash(value.dashboardUrl) }
        : {}),
      token: value.token,
    };
  } catch {
    return null;
  }
}

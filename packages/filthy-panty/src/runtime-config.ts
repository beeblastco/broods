/**
 * Runtime config (dashboard URL, token, project, environment) for SDK/CLI callers.
 *
 * Reads `.env`/`.env.local` from the target project directory (`cwd`, which is
 * not always the directory the process started in) so a generated client picks
 * up package-local config without wiring up dotenv. Kept zero-dependency and
 * synchronous so the FilthyPantyClient constructor can call it without awaiting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { USER_CONFIG_PATH, stripTrailingSlash } from "./config.ts";

export interface FilthyPantyRuntimeConfig {
  dashboardUrl?: string;
  token?: string;
  project?: string;
  environment?: string;
}

let loadedEnvForCwd: string | null = null;

export function loadFilthyPantyRuntimeConfig(cwd = process.cwd()): FilthyPantyRuntimeConfig {
  loadEnvFiles(cwd);
  const stored = readStoredAuthSync();

  return {
    dashboardUrl: process.env.FILTHY_PANTY_DASHBOARD_URL ?? stored?.dashboardUrl,
    token: process.env.FILTHY_PANTY_TOKEN ?? stored?.token,
    project: process.env.FILTHY_PANTY_PROJECT,
    environment: process.env.FILTHY_PANTY_ENVIRONMENT,
  };
}

/**
 * Loads `.env` then `.env.local` from `cwd` into `process.env`, so `.env.local`
 * overrides `.env` while neither clobbers a variable already set in the real
 * environment. Memoized per resolved cwd so repeated client/compile calls don't
 * re-read the files.
 */
function loadEnvFiles(cwd: string): void {
  const root = resolve(cwd);
  if (loadedEnvForCwd === root) return;
  loadedEnvForCwd = root;

  const originallySet = new Set(Object.keys(process.env));
  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      if (!originallySet.has(key)) process.env[key] = value;
    }
  }
}

/** Parses dotenv-style `KEY=value` lines, tolerating `export `, comments, and blanks. */
function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
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
 * Reads the CLI-stored auth (dashboard URL + token) synchronously so the client
 * constructor can use it without awaiting. Returns null when the file is absent
 * or malformed.
 */
function readStoredAuthSync(): { dashboardUrl: string; token: string } | null {
  try {
    const value = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf8")) as {
      dashboardUrl?: unknown;
      token?: unknown;
    };
    if (typeof value.dashboardUrl !== "string" || typeof value.token !== "string") return null;
    return {
      dashboardUrl: stripTrailingSlash(value.dashboardUrl),
      token: value.token,
    };
  } catch {
    return null;
  }
}

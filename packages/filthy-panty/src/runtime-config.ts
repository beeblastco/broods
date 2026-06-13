/**
 * Runtime config loading for Node/Bun SDK usage.
 * Generated clients use this so app code does not manually wire CLI auth.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

function loadEnvFiles(cwd: string): void {
  const root = resolve(cwd);
  if (loadedEnvForCwd === root) return;
  loadedEnvForCwd = root;

  const originallySet = new Set(Object.keys(process.env));
  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const values = parseEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (originallySet.has(key)) continue;
      process.env[key] = value;
    }
  }
}

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
    try {
      const legacyPath = join(homedir(), ".filthy-panty", "config.json");
      if (legacyPath === USER_CONFIG_PATH) return null;
      const value = JSON.parse(readFileSync(legacyPath, "utf8")) as {
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
}

function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(normalized.slice(index + 1).trim());
  }

  return values;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }

  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

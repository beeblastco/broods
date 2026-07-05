/**
 * Local project/auth configuration helpers for the CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_DIR = "broods";
export const GENERATED_DIR = "_generated";
export const USER_CONFIG_PATH = join(homedir(), ".broods", "config.json");

export interface StoredAuthConfig {
  dashboardUrl: string;
  /**
   * Base URL of the Convex control plane serving the /api/cli/* routes.
   * Absent in legacy logins, which reach the same routes through the
   * dashboard's proxy at `dashboardUrl`.
   */
  controlUrl?: string;
  token: string;
  createdAt: string;
  user?: {
    authId: string;
    email?: string;
    name?: string;
  };
  org?: {
    id: string;
    name: string;
    slug: string;
  };
  account?: {
    id: string;
    username: string;
  };
}

export async function readStoredAuth(): Promise<StoredAuthConfig | null> {
  const envToken = process.env.BROODS_TOKEN;
  const envUrl = process.env.BROODS_DASHBOARD_URL ?? process.env.BROODS_CONTROL_URL;
  if (envToken && envUrl) {
    return {
      dashboardUrl: envUrl,
      ...(process.env.BROODS_CONTROL_URL ? { controlUrl: process.env.BROODS_CONTROL_URL } : {}),
      token: envToken,
      createdAt: new Date().toISOString(),
    };
  }

  try {
    return JSON.parse(await readFile(USER_CONFIG_PATH, "utf8")) as StoredAuthConfig;
  } catch {
    return null;
  }
}

export async function writeStoredAuth(config: StoredAuthConfig): Promise<void> {
  await mkdir(dirname(USER_CONFIG_PATH), { recursive: true });
  await writeFile(USER_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The base URL the CLI control-plane client should call. Legacy logins have no
 * controlUrl and fall back to the dashboard, whose /api/cli/* proxy forwards to
 * the same Convex routes.
 */
export function controlUrlFromAuth(auth: Pick<StoredAuthConfig, "dashboardUrl" | "controlUrl">): string {
  return stripTrailingSlash(auth.controlUrl ?? auth.dashboardUrl);
}

/**
 * Local project/auth configuration helpers for the CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_DIR = "filthypanty";
export const GENERATED_DIR = "_generated";
export const USER_CONFIG_PATH = join(homedir(), ".filthy-panty", "config.json");

export interface StoredAuthConfig {
  dashboardUrl: string;
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
  const envToken = process.env.FILTHY_PANTY_TOKEN;
  const envUrl = process.env.FILTHY_PANTY_DASHBOARD_URL;
  if (envToken && envUrl) {
    return {
      dashboardUrl: envUrl,
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

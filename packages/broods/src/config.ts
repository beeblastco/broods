/**
 * Local project/auth configuration helpers for the CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_DIR = "broods";
export const GENERATED_DIR = "_generated";
export const USER_CONFIG_PATH = join(homedir(), ".broods", "config.json");

// Host naming we control, used only to pair a dashboard with its API origin
// before login has advertised one. Not part of the public config surface.
const BROODS_APEX_DOMAIN = "broods.app";
const DASHBOARD_HOST_PREFIX = "dashboard";
const GATEWAY_HOST_PREFIX = "gateway";

export interface StoredAuthConfig {
  /**
   * Base URL of the Convex control plane serving the /v1/account/* routes
   * (the Convex deployment directly, or the gateway's unified domain).
   * All sync/env/deploy calls go here.
   */
  baseUrl: string;
  /**
   * Base URL of the dashboard UI. Only used for browser login and deep
   * links; absent for env-based auth.
   */
  dashboardUrl?: string;
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
  const envConvexUrl = process.env.BROODS_BASE_URL;
  if (envToken && envConvexUrl) {
    return {
      baseUrl: stripTrailingSlash(envConvexUrl),
      token: envToken,
      createdAt: new Date().toISOString(),
    };
  }

  try {
    const stored = JSON.parse(
      await readFile(USER_CONFIG_PATH, "utf8"),
    ) as StoredAuthConfig;
    // Auth stored before the Convex-direct control plane has no baseUrl;
    // treat it as logged out so the user re-authenticates.
    if (typeof stored.baseUrl !== "string" || !stored.baseUrl) return null;

    return stored;
  } catch {
    return null;
  }
}

export async function writeStoredAuth(config: StoredAuthConfig): Promise<void> {
  await mkdir(dirname(USER_CONFIG_PATH), { recursive: true });
  await writeFile(
    USER_CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;

  return value.slice(0, end);
}

/**
 * Guesses the API origin for a dashboard origin, but only for hosts we own and
 * therefore know the naming convention of. Any other host — a self-hosted or
 * custom domain — returns undefined so the caller waits for the base URL that
 * login advertises instead of inventing one that would not resolve.
 */
export function gatewayUrlForDashboard(
  dashboardUrl: string,
): string | undefined {
  try {
    const url = new URL(dashboardUrl);
    if (!url.hostname.startsWith(`${DASHBOARD_HOST_PREFIX}.`)) return undefined;
    const rest = url.hostname.slice(DASHBOARD_HOST_PREFIX.length + 1);
    if (rest !== BROODS_APEX_DOMAIN && !rest.endsWith(`.${BROODS_APEX_DOMAIN}`))
      return undefined;
    url.hostname = `${GATEWAY_HOST_PREFIX}.${rest}`;

    return stripTrailingSlash(url.origin);
  } catch {
    return undefined;
  }
}

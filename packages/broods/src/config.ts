/**
 * Local project/auth configuration helpers for the CLI.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

/**
 * `~/.broods/config.json`: every CLI login on this machine, keyed by server
 * base URL, so logging in to one environment never replaces another.
 */
interface StoredAuthFile {
  /** Base URL of the most recent login, used when nothing names a server. */
  current: string;
  logins: Record<string, StoredAuthConfig>;
}

/**
 * Resolves the login this invocation acts as. BROODS_TOKEN + BROODS_BASE_URL
 * win outright. Otherwise it is the stored login for one server, named by
 * `baseUrl`, then BROODS_BASE_URL, then the login whose dashboard is
 * BROODS_DASHBOARD_URL, then the most recent login. Null when that server has
 * no login, so a dev project never quietly runs on a prod token.
 */
export function readStoredAuth(baseUrl?: string): StoredAuthConfig | null {
  const envToken = process.env.BROODS_TOKEN;
  const envBaseUrl = baseUrl ?? process.env.BROODS_BASE_URL;
  if (envToken && envBaseUrl) {
    return {
      baseUrl: stripTrailingSlash(envBaseUrl),
      token: envToken,
      createdAt: new Date().toISOString(),
    };
  }

  const file = readStoredAuthFile();
  if (!file) return null;
  if (envBaseUrl) return file.logins[stripTrailingSlash(envBaseUrl)] ?? null;
  const envDashboardUrl = process.env.BROODS_DASHBOARD_URL;
  if (envDashboardUrl) {
    const dashboardUrl = stripTrailingSlash(envDashboardUrl);

    return (
      Object.values(file.logins).find(
        (login) => login.dashboardUrl === dashboardUrl,
      ) ?? null
    );
  }

  return file.logins[file.current] ?? null;
}

/** Stores `config` as the login for its server and makes it the most recent one. */
export async function writeStoredAuth(config: StoredAuthConfig): Promise<void> {
  const logins = readStoredAuthFile()?.logins ?? {};
  const file: StoredAuthFile = {
    current: config.baseUrl,
    logins: { ...logins, [config.baseUrl]: config },
  };
  await mkdir(dirname(USER_CONFIG_PATH), { recursive: true });
  await writeFile(
    USER_CONFIG_PATH,
    `${JSON.stringify(file, null, 2)}\n`,
    "utf8",
  );
}

export function stageFromEnv(): string | undefined {
  return process.env.BROODS_STAGE;
}

export function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;

  return value.slice(0, end);
}

/**
 * Guesses the API origin for a dashboard origin, but only for hosts we own and
 * therefore know the naming convention of. Any other host, self-hosted or on a
 * custom domain, returns undefined so the caller waits for the base URL that
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

/**
 * Reads the login file. A missing, malformed or single-login file from an
 * older CLI reads as null, which means logged out.
 */
function readStoredAuthFile(): StoredAuthFile | null {
  try {
    const file = JSON.parse(
      readFileSync(USER_CONFIG_PATH, "utf8"),
    ) as Partial<StoredAuthFile>;
    if (typeof file.current !== "string" || !file.logins) return null;

    return { current: file.current, logins: file.logins };
  } catch {
    return null;
  }
}

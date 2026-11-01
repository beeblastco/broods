import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_DIR = "broods";
export const GENERATED_DIR = "_generated";
export const USER_CONFIG_PATH = join(homedir(), ".broods", "config.json");

const BROODS_APEX_DOMAIN = "broods.app";
const DASHBOARD_HOST_PREFIX = "dashboard";
const GATEWAY_HOST_PREFIX = "gateway";

export interface StoredAuthConfig {
  baseUrl: string;
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

interface StoredAuthFile {
  current: string;
  logins: Record<string, StoredAuthConfig>;
}

/** Null when the named server has no login, so a dev project never runs on a prod token. */
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

export async function writeStoredAuth(config: StoredAuthConfig): Promise<void> {
  const logins = readStoredAuthFile()?.logins ?? {};
  const file: StoredAuthFile = {
    current: config.baseUrl,
    logins: { ...logins, [config.baseUrl]: config },
  };
  await mkdir(dirname(USER_CONFIG_PATH), { recursive: true, mode: 0o700 });
  // `mode` only applies on create; an older CLI made this directory 0755.
  await chmod(dirname(USER_CONFIG_PATH), 0o700);
  await writePrivateFile(
    USER_CONFIG_PATH,
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

export async function writePrivateFile(
  path: string,
  body: string,
): Promise<void> {
  await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
  // `mode` only applies on create; an older CLI made this file 0644.
  await chmod(path, 0o600);
}

export function stageFromEnv(): string | undefined {
  return process.env.BROODS_STAGE;
}

export function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;

  return value.slice(0, end);
}

/** Only hosts we own; any other host waits for the base URL login advertises. */
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

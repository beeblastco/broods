/**
 * HTTP client for the SaaS CLI API exposed by the dashboard/Convex backend.
 */

import type { CliManifest, GeneratedIds } from "./contracts.ts";
import { stripTrailingSlash } from "./config.ts";

export interface SyncClientOptions {
  dashboardUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RemoteManifestResponse {
  manifest: CliManifest;
  ids: GeneratedIds;
  /** Non-fatal deploy advisories (e.g. referenced-but-unset env vars). */
  warnings?: { missingEnv?: string[] };
  /**
   * The environment's runtime API key context. `apiKey` (plaintext) is present
   * only the first time the key is minted (or after a rotate); later deploys
   * carry just the masked `keyHint`. Used to write `FILTHY_PANTY_API_KEY` locally.
   */
  deployment?: {
    accountId: string;
    endpointId: string;
    projectSlug: string;
    environmentSlug: string;
    keyHint: string;
    apiKey: string | null;
  } | null;
}

export interface CliOnboardingOrg {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  accountStatus: "active" | "missing" | "disabled";
}

export interface CliOnboardingProject {
  id: string;
  name: string;
  slug: string;
}

export interface CliOnboardingContext {
  currentOrgId: string;
  orgs: CliOnboardingOrg[];
  projects: CliOnboardingProject[];
}

/** A stored environment variable as listed by the CLI (name only; value is write-only). */
export interface CliEnvVar {
  name: string;
  updatedAt: number;
}

/** A single runtime/deploy log line as returned by the CLI logs endpoint. */
export interface CliLogEntry {
  timestamp: number;
  message: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  logGroup: string;
  logStream?: string;
  functionName: string;
  requestId?: string;
}

export type DiffOperation = "create" | "update" | "delete" | "rename";

export interface DiffEntry {
  operation: DiffOperation;
  kind: string;
  name: string;
  previousName?: string;
}

export class FilthyPantySyncClient {
  private readonly dashboardUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SyncClientOptions) {
    this.dashboardUrl = stripTrailingSlash(options.dashboardUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getManifest(project: string, environment: string): Promise<RemoteManifestResponse | null> {
    const response = await this.request(project, environment, "/manifest", { method: "GET" });
    if (response.status === 404) return null;
    await assertOk(response, "Fetch manifest failed");
    return await response.json() as RemoteManifestResponse;
  }

  async putManifest(manifest: CliManifest, prune: boolean, rotateRuntimeKey = false): Promise<RemoteManifestResponse> {
    const response = await this.request(manifest.project, manifest.environment, "/manifest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, prune, rotateRuntimeKey }),
    });
    await assertOk(response, "Sync manifest failed");
    return await response.json() as RemoteManifestResponse;
  }

  async setEnv(project: string, environment: string, name: string, value: string): Promise<void> {
    const response = await this.request(project, environment, `/env/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    await assertOk(response, "Set environment variable failed");
  }

  /**
   * Lists the names of the environment's stored variables (values stay
   * server-side and encrypted, so only names and last-updated times return).
   */
  async listEnv(project: string, environment: string): Promise<CliEnvVar[]> {
    const response = await this.request(project, environment, "/env", { method: "GET" });
    await assertOk(response, "List environment variables failed");
    const payload = await response.json() as { variables?: CliEnvVar[] };

    return payload.variables ?? [];
  }

  /** Reveals a single env var's plaintext value, or null when it is not set. The reveal is audited server-side. */
  async getEnv(project: string, environment: string, name: string): Promise<string | null> {
    const response = await this.request(project, environment, `/env/${encodeURIComponent(name)}`, { method: "GET" });
    if (response.status === 404) return null;
    await assertOk(response, "Read environment variable failed");
    const payload = await response.json() as { value?: string };

    return payload.value ?? null;
  }

  async removeEnv(project: string, environment: string, name: string): Promise<void> {
    const response = await this.request(project, environment, `/env/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    await assertOk(response, "Remove environment variable failed");
  }

  async logs(
    project: string,
    environment: string,
    options: { limit?: number; errorOnly?: boolean; lookbackMs?: number } = {},
  ): Promise<{ logs: CliLogEntry[] }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.errorOnly !== undefined) params.set("errorOnly", options.errorOnly ? "1" : "0");
    if (options.lookbackMs !== undefined) params.set("lookbackMs", String(options.lookbackMs));
    const suffix = params.size > 0 ? `/logs?${params}` : "/logs";
    const response = await this.request(project, environment, suffix, { method: "GET" });
    await assertOk(response, "Fetch logs failed");
    return await response.json() as { logs: CliLogEntry[] };
  }

  async getOnboarding(): Promise<CliOnboardingContext> {
    const response = await this.fetchImpl(`${this.dashboardUrl}/api/cli/onboarding`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    await assertOk(response, "Fetch CLI onboarding context failed");

    return await response.json() as CliOnboardingContext;
  }

  async selectOnboardingOrg(orgId: string): Promise<CliOnboardingContext> {
    const response = await this.fetchImpl(`${this.dashboardUrl}/api/cli/onboarding`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orgId: orgId }),
    });
    await assertOk(response, "Select CLI org failed");

    return await response.json() as CliOnboardingContext;
  }

  private async request(project: string, environment: string, suffix: string, init: RequestInit): Promise<Response> {
    const url = `${this.dashboardUrl}/api/cli/projects/${encodeURIComponent(project)}` +
      `/environments/${encodeURIComponent(environment)}${suffix}`;
    return await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
  }
}

export function diffManifests(local: CliManifest, remote: CliManifest | null): DiffEntry[] {
  const remoteResources = new Map((remote?.resources ?? []).map((entry) => [`${entry.kind}:${entry.name}`, entry]));
  const localResources = new Map(local.resources.map((entry) => [`${entry.kind}:${entry.name}`, entry]));
  const entries: DiffEntry[] = [];
  const unmatchedLocal: Array<{ key: string; resource: CliManifest["resources"][number] }> = [];
  const unmatchedRemote: Array<{ key: string; resource: CliManifest["resources"][number] }> = [];

  for (const [key, resource] of localResources) {
    const remoteResource = remoteResources.get(key);
    if (!remoteResource) {
      unmatchedLocal.push({ key: key, resource: resource });
    } else if (stableJson(snapshotResource(remoteResource)) !== stableJson(snapshotResource(resource))) {
      entries.push({ operation: "update", kind: resource.kind, name: resource.name });
    }
  }

  for (const [key, resource] of remoteResources) {
    if (!localResources.has(key)) {
      unmatchedRemote.push({ key: key, resource: resource });
    }
  }

  const renamedRemoteKeys = new Set<string>();
  const renamedLocalKeys = new Set<string>();
  for (const localEntry of unmatchedLocal) {
    const match = unmatchedRemote.find((remoteEntry) =>
      !renamedRemoteKeys.has(remoteEntry.key) &&
      isRenamableKind(localEntry.resource.kind) &&
      localEntry.resource.kind === remoteEntry.resource.kind &&
      stableJson(renameSnapshot(localEntry.resource)) === stableJson(renameSnapshot(remoteEntry.resource))
    );
    if (!match) continue;
    renamedLocalKeys.add(localEntry.key);
    renamedRemoteKeys.add(match.key);
    entries.push({
      operation: "rename",
      kind: localEntry.resource.kind,
      name: localEntry.resource.name,
      previousName: match.resource.name,
    });
  }

  for (const { key, resource } of unmatchedLocal) {
    if (!renamedLocalKeys.has(key)) {
      entries.push({ operation: "create", kind: resource.kind, name: resource.name });
    }
  }

  for (const { key, resource } of unmatchedRemote) {
    if (!renamedRemoteKeys.has(key)) {
      entries.push({ operation: "delete", kind: resource.kind, name: resource.name });
    }
  }

  return entries.sort((a, b) => diffSortKey(a).localeCompare(diffSortKey(b)));
}

function snapshotResource(resource: { kind: string; config: unknown } & Record<string, unknown>): unknown {
  const normalized = normalizeEnvRefs(resource) as typeof resource;
  if (resource.kind !== "skill" && resource.kind !== "tool") return normalized;

  return {
    ...normalized,
    config: stripArtifactContent(normalized.config),
  };
}

function renameSnapshot(resource: { kind: string; config: unknown } & Record<string, unknown>): unknown {
  const normalized = snapshotResource(resource) as Record<string, unknown>;
  const { name: _name, ...rest } = normalized;

  return rest;
}

function isRenamableKind(kind: string): boolean {
  return kind === "agent" || kind === "workspace" || kind === "sandbox";
}

function diffSortKey(entry: DiffEntry): string {
  const rank: Record<DiffOperation, number> = {
    create: 0,
    rename: 1,
    update: 2,
    delete: 3,
  };

  return `${rank[entry.operation]}:${entry.kind}:${entry.previousName ?? ""}:${entry.name}`;
}

function normalizeEnvRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEnvRefs);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__beeblastEnv === true && typeof record.name === "string") {
      return `\${${record.name}}`;
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, normalizeEnvRefs(entry)]),
    );
  }

  return value;
}

function stripArtifactContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripArtifactContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      if (key === "contentBase64" || key === "bundle") return [];
      return [[key, stripArtifactContent(entry)]];
    }));
  }

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortValue(entry)]));
  }

  return value;
}

async function assertOk(response: Response, message: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${message}: ${response.status} ${await response.text()}`);
  }
}

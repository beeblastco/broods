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
}

export type DiffOperation = "create" | "update" | "delete";

export interface DiffEntry {
  operation: DiffOperation;
  kind: string;
  name: string;
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

  async putManifest(manifest: CliManifest, prune: boolean): Promise<RemoteManifestResponse> {
    const response = await this.request(manifest.project, manifest.environment, "/manifest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, prune }),
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

  async logs(project: string, environment: string, options: { limit?: number; errorOnly?: boolean } = {}) {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.errorOnly !== undefined) params.set("errorOnly", options.errorOnly ? "1" : "0");
    const suffix = params.size > 0 ? `/logs?${params}` : "/logs";
    const response = await this.request(project, environment, suffix, { method: "GET" });
    await assertOk(response, "Fetch logs failed");
    return await response.json() as { logs: unknown[] };
  }

  async run(project: string, environment: string, agentName: string, body: unknown): Promise<Response> {
    return await this.request(project, environment, `/agents/${encodeURIComponent(agentName)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(body),
    });
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

  for (const [key, resource] of localResources) {
    const remoteResource = remoteResources.get(key);
    if (!remoteResource) {
      entries.push({ operation: "create", kind: resource.kind, name: resource.name });
    } else if (stableJson(snapshotResource(remoteResource)) !== stableJson(snapshotResource(resource))) {
      entries.push({ operation: "update", kind: resource.kind, name: resource.name });
    }
  }

  for (const [key, resource] of remoteResources) {
    if (!localResources.has(key)) {
      entries.push({ operation: "delete", kind: resource.kind, name: resource.name });
    }
  }

  return entries.sort((a, b) => `${a.operation}:${a.kind}:${a.name}`.localeCompare(`${b.operation}:${b.kind}:${b.name}`));
}

function snapshotResource(resource: { kind: string; config: unknown } & Record<string, unknown>): unknown {
  const normalized = normalizeEnvRefs(resource) as typeof resource;
  if (resource.kind !== "skill" && resource.kind !== "tool") return normalized;

  return {
    ...normalized,
    config: stripArtifactContent(normalized.config),
  };
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

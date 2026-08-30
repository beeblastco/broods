/**
 * HTTP client for the SaaS CLI API exposed by the dashboard/Convex backend.
 */

import { createHash } from "node:crypto";
import type { CliManifest, GeneratedIds } from "./contracts.ts";
import { stripTrailingSlash } from "./config.ts";
import { INLINE_MCP_BUNDLE_BYTES } from "./manifest.ts";

export interface SyncClientOptions {
  /**
   * Base URL serving the /v1/account/* control-plane routes: the Convex
   * deployment directly, or the gateway's unified domain in front of it.
   */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RemoteManifestResponse {
  manifest: CliManifest;
  ids: GeneratedIds;
  /** Non-fatal deploy advisories (e.g. policy refs that resolve to nothing). */
  warnings?: { missingPolicies?: string[] };
  /**
   * The stage's runtime API key context. Deployments include the plaintext
   * `apiKey` so the CLI can write `BROODS_API_KEY` locally.
   */
  deployment?: {
    accountId: string;
    endpointId: string;
    projectSlug: string;
    stageSlug: string;
    /** Decides the webhook URL shape; only production keeps the bare one. */
    stageKind?: "development" | "production" | "custom";
    keyHint: string;
    apiKey: string;
  } | null;
}

export interface CliOnboardingOrg {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  /** Absent on backends that predate plan reporting. */
  plan?: "free" | "pro" | "enterprise";
  accountStatus: "active" | "missing" | "disabled";
}

export interface CliOnboardingProject {
  id: string;
  name: string;
  slug: string;
}

export interface CliOnboardingAccount {
  id: string;
  username: string;
  status: "active" | "disabled";
}

export interface CliOnboardingUser {
  authId: string;
  email: string;
  name: string;
}

export interface CliOnboardingContext {
  currentOrgId: string;
  orgs: CliOnboardingOrg[];
  projects: CliOnboardingProject[];
  /** The API account backing the current org; absent on older backends. */
  account?: CliOnboardingAccount | null;
  user?: CliOnboardingUser;
}

/** One stage of a project, as listed by `broods stage list`. */
export interface CliStage {
  id: string;
  name: string;
  kind: "development" | "production" | "custom";
  isDefault: boolean;
  deploymentRegion?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
  agentCount: number;
  variableCount: number;
  updatedAt: number;
}

/** A project of the logged-in account's org, with the counts `broods project` prints. */
export interface CliProject {
  id: string;
  name: string;
  slug: string;
  /** No stage, agent, variable, deployment or workspace file left in it. */
  empty: boolean;
  stageCount: number;
  agentCount: number;
  variableCount: number;
  deploymentCount: number;
  fileCount: number;
  updatedAt: number;
}

/** A stored environment variable as listed by the CLI (name only; value is write-only). */
export interface CliEnvVar {
  name: string;
  updatedAt: number;
  /** SHA-256 hex of the stored value; absent until the variable's next write. */
  valueDigest?: string;
}

export type DiffOperation = "create" | "update" | "delete" | "rename";

export interface DiffEntry {
  operation: DiffOperation;
  kind: string;
  name: string;
  previousName?: string;
}

export class BroodsSyncClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SyncClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getManifest(
    project: string,
    stage: string,
  ): Promise<RemoteManifestResponse | null> {
    const response = await this.request(project, stage, "/manifest", {
      method: "GET",
    });
    if (response.status === 404) return null;
    await assertOk(response, "Fetch manifest failed");

    return (await response.json()) as RemoteManifestResponse;
  }

  async putManifest(
    manifest: CliManifest,
    prune: boolean,
    rotateRuntimeKey = false,
  ): Promise<RemoteManifestResponse> {
    const uploaded = await this.externalizeLargeMcpBundles(manifest);
    const response = await this.request(
      manifest.project,
      manifest.stage,
      "/manifest",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: uploaded,
          prune: prune,
          rotateRuntimeKey: rotateRuntimeKey,
        }),
      },
    );
    await assertOk(response, "Sync manifest failed");

    return (await response.json()) as RemoteManifestResponse;
  }

  /**
   * An MCP bundle past the inline threshold cannot ride the manifest JSON
   * (the config plane caps request bodies around 20 MB), so it travels
   * through Convex file storage instead: mint an upload URL, POST the module
   * source, and swap the resource's `bundle` for the returned storage id
   * plus its sha256 (#190). Small bundles stay inline, one request as before.
   */
  private async externalizeLargeMcpBundles(
    manifest: CliManifest,
  ): Promise<CliManifest> {
    const large = manifest.resources.filter(
      (resource) =>
        resource.kind === "mcp" &&
        typeof (resource.config as { bundle?: unknown })?.bundle === "string" &&
        Buffer.byteLength((resource.config as { bundle: string }).bundle) >
          INLINE_MCP_BUNDLE_BYTES,
    );
    if (large.length === 0) return manifest;

    const resources = await Promise.all(
      manifest.resources.map(async (resource) => {
        if (!large.includes(resource)) return resource;
        const config = resource.config as { bundle: string } & Record<
          string,
          unknown
        >;
        const { bundle, ...rest } = config;
        const storageId = await this.uploadMcpBundle(
          manifest.project,
          manifest.stage,
          bundle,
        );

        return {
          ...resource,
          config: {
            ...rest,
            bundleStorageId: storageId,
            sha256: createHash("sha256").update(bundle).digest("hex"),
          },
        };
      }),
    );

    return { ...manifest, resources: resources };
  }

  /** POST one bundle's module source to a minted upload URL; returns the storage id. */
  private async uploadMcpBundle(
    project: string,
    stage: string,
    bundle: string,
  ): Promise<string> {
    const minted = await this.request(project, stage, "/mcp-bundle-uploads", {
      method: "POST",
    });
    await assertOk(minted, "Mint bundle upload URL failed");
    const { uploadUrl } = (await minted.json()) as { uploadUrl?: string };
    if (!uploadUrl)
      throw new Error(
        "Mint bundle upload URL failed: response omitted uploadUrl",
      );
    const stored = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/javascript" },
      body: bundle,
    });
    await assertOk(stored, "Bundle upload failed");
    const { storageId } = (await stored.json()) as { storageId?: string };
    if (!storageId)
      throw new Error("Bundle upload failed: response omitted storageId");

    return storageId;
  }

  /**
   * Recovers the stage's runtime API key so the CLI can reconnect to a
   * dashboard-created project without redeploying. Returns null when the project/
   * stage is unknown.
   */
  async getRuntimeKey(
    project: string,
    stage: string,
  ): Promise<{
    apiKey: string;
    keyHint: string;
    endpointId?: string;
    projectSlug?: string;
    stageSlug?: string;
  } | null> {
    const response = await this.request(project, stage, "/runtime-key", {
      method: "GET",
    });
    if (response.status === 404) return null;
    await assertOk(response, "Fetch runtime key failed");
    const payload = (await response.json()) as {
      apiKey?: string;
      keyHint?: string;
      endpointId?: string;
      projectSlug?: string;
      stageSlug?: string;
    };

    if (!payload.apiKey)
      throw new Error("Fetch runtime key failed: response omitted apiKey");

    return {
      apiKey: payload.apiKey,
      keyHint: payload.keyHint ?? "",
      ...(payload.endpointId ? { endpointId: payload.endpointId } : {}),
      ...(payload.projectSlug ? { projectSlug: payload.projectSlug } : {}),
      ...(payload.stageSlug ? { stageSlug: payload.stageSlug } : {}),
    };
  }

  async setEnv(
    project: string,
    stage: string,
    name: string,
    value: string,
  ): Promise<void> {
    const response = await this.request(
      project,
      stage,
      `/env/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: value }),
      },
    );
    await assertOk(response, "Set environment variable failed");
  }

  /**
   * Lists the names of the stage's stored variables (values stay
   * server-side and encrypted, so only names and last-updated times return).
   */
  async listEnv(project: string, stage: string): Promise<CliEnvVar[]> {
    const response = await this.request(project, stage, "/env", {
      method: "GET",
    });
    await assertOk(response, "List environment variables failed");
    const payload = (await response.json()) as { variables?: CliEnvVar[] };

    return payload.variables ?? [];
  }

  /** Reveals a single env var's plaintext value, or null when it is not set. The reveal is audited server-side. */
  async getEnv(
    project: string,
    stage: string,
    name: string,
  ): Promise<string | null> {
    const response = await this.request(
      project,
      stage,
      `/env/${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    if (response.status === 404) return null;
    await assertOk(response, "Read environment variable failed");
    const payload = (await response.json()) as { value?: string };

    return payload.value ?? null;
  }

  async removeEnv(project: string, stage: string, name: string): Promise<void> {
    const response = await this.request(
      project,
      stage,
      `/env/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      },
    );
    await assertOk(response, "Remove environment variable failed");
  }

  async getOnboarding(): Promise<CliOnboardingContext> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/onboarding`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );
    await assertOk(response, "Fetch CLI onboarding context failed");

    return (await response.json()) as CliOnboardingContext;
  }

  async selectOnboardingOrg(orgId: string): Promise<CliOnboardingContext> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/onboarding`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId: orgId }),
      },
    );
    await assertOk(response, "Select CLI org failed");

    return (await response.json()) as CliOnboardingContext;
  }

  async listStages(project: string): Promise<CliStage[]> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/stages?project=${encodeURIComponent(project)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );
    assertRouteMounted(response, "/v1/account/stages", "broods stage");
    await assertOk(response, "List stages failed");
    const payload = (await response.json()) as { stages?: CliStage[] };

    return payload.stages ?? [];
  }

  async createStage(
    project: string,
    name: string,
    duplicateFrom?: string,
  ): Promise<{ stage: CliStage; clonedFrom: string | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/account/stages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: project,
        name: name,
        ...(duplicateFrom ? { from: duplicateFrom } : {}),
      }),
    });
    assertRouteMounted(response, "/v1/account/stages", "broods stage");
    await assertOk(response, "Create stage failed");

    return (await response.json()) as {
      stage: CliStage;
      clonedFrom: string | null;
    };
  }

  /** Every project in the logged-in account's org, empty ones sorted last. */
  async listProjects(): Promise<CliProject[]> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/projects`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );
    assertRouteMounted(response, "/v1/account/projects", "broods project");
    await assertOk(response, "List projects failed");
    const payload = (await response.json()) as { projects?: CliProject[] };

    return payload.projects ?? [];
  }

  /**
   * Deletes a project and everything under it: stages, agents, canvas, env
   * vars, crons and workspace files. Takes the project id from `listProjects`
   * (names are not unique). Returns what the project held, or null when the id
   * matches nothing.
   */
  async deleteProject(projectId: string): Promise<CliProject | null> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/projects?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );
    assertRouteMounted(response, "/v1/account/projects", "broods project");
    if (response.status === 404) return null;
    await assertOk(response, "Delete project failed");
    const payload = (await response.json()) as { deleted?: CliProject };

    return payload.deleted ?? null;
  }

  async createOnboardingOrg(name: string): Promise<CliOnboardingContext> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/account/onboarding`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ createOrgName: name }),
      },
    );
    await assertOk(response, "Create CLI org failed");

    return (await response.json()) as CliOnboardingContext;
  }

  private async request(
    project: string,
    stage: string,
    suffix: string,
    init: RequestInit,
  ): Promise<Response> {
    const url =
      `${this.baseUrl}/v1/account/projects/${encodeURIComponent(project)}` +
      `/stages/${encodeURIComponent(stage)}${suffix}`;

    return await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
  }
}

export function diffManifests(
  local: CliManifest,
  remote: CliManifest | null,
): DiffEntry[] {
  const remoteResources = new Map(
    (remote?.resources ?? []).map((entry) => [
      `${entry.kind}:${entry.name}`,
      entry,
    ]),
  );
  const localResources = new Map(
    local.resources.map((entry) => [`${entry.kind}:${entry.name}`, entry]),
  );
  const entries: DiffEntry[] = [];
  const unmatchedLocal: Array<{
    key: string;
    resource: CliManifest["resources"][number];
  }> = [];
  const unmatchedRemote: Array<{
    key: string;
    resource: CliManifest["resources"][number];
  }> = [];

  for (const [key, resource] of localResources) {
    const remoteResource = remoteResources.get(key);
    if (!remoteResource) {
      unmatchedLocal.push({ key: key, resource: resource });
    } else if (
      stableJson(snapshotResource(remoteResource)) !==
      stableJson(snapshotResource(resource))
    ) {
      entries.push({
        operation: "update",
        kind: resource.kind,
        name: resource.name,
      });
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
    const match = unmatchedRemote.find(
      (remoteEntry) =>
        !renamedRemoteKeys.has(remoteEntry.key) &&
        isRenamableKind(localEntry.resource.kind) &&
        localEntry.resource.kind === remoteEntry.resource.kind &&
        stableJson(renameSnapshot(localEntry.resource)) ===
          stableJson(renameSnapshot(remoteEntry.resource)),
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
      entries.push({
        operation: "create",
        kind: resource.kind,
        name: resource.name,
      });
    }
  }

  for (const { key, resource } of unmatchedRemote) {
    if (!renamedRemoteKeys.has(key)) {
      entries.push({
        operation: "delete",
        kind: resource.kind,
        name: resource.name,
      });
    }
  }

  return entries.sort((a, b) => diffSortKey(a).localeCompare(diffSortKey(b)));
}

function snapshotResource(
  resource: { kind: string; config: unknown } & Record<string, unknown>,
): unknown {
  const normalized = normalizeEnvRefs(resource) as typeof resource;
  if (resource.kind !== "skill" && resource.kind !== "hook") return normalized;

  return {
    ...normalized,
    config: stripArtifactContent(normalized.config),
  };
}

function renameSnapshot(
  resource: { kind: string; config: unknown } & Record<string, unknown>,
): unknown {
  const normalized = snapshotResource(resource) as Record<string, unknown>;
  const { name: _name, ...rest } = normalized;

  return rest;
}

function isRenamableKind(kind: string): boolean {
  return (
    kind === "agent" ||
    kind === "workspace" ||
    kind === "sandbox" ||
    kind === "policy"
  );
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
      Object.entries(record).map(([key, entry]) => [
        key,
        normalizeEnvRefs(entry),
      ]),
    );
  }

  return value;
}

function stripArtifactContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripArtifactContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        if (key === "contentBase64" || key === "bundle") return [];

        return [[key, stripArtifactContent(entry)]];
      }),
    );
  }

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }

  return value;
}

/**
 * A 404 that is not JSON came from the router, not the handler: the deployment
 * predates the route. Says so, rather than letting it read as "not found".
 */
function assertRouteMounted(
  response: Response,
  route: string,
  command: string,
): void {
  if (response.status !== 404) return;
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) return;

  throw new Error(
    `This broods deployment has no ${route} route yet. Update the backend to use \`${command}\`.`,
  );
}

/**
 * Turns a failed response into an error carrying the server's own reason. The
 * config plane answers with `{ error, detail? }`, and `detail` is where manifest
 * validation failures (an unset `env()` ref, an unsupported mount) explain
 * themselves — printing the raw JSON instead buries them.
 */
async function assertOk(response: Response, message: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  let reason = body;
  try {
    const parsed = JSON.parse(body) as { error?: string; detail?: string };
    reason = parsed.detail ?? parsed.error ?? body;
  } catch {
    // Not JSON: the raw body is the best reason available.
  }

  throw new Error(`${message}: ${response.status} ${reason}`);
}

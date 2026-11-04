import type {
  CliManifest,
  DeploymentRegion,
  GeneratedIds,
  CliManifestResource,
} from "./contracts.ts";
import { stripTrailingSlash } from "./config.ts";
import { INLINE_MCP_BUNDLE_BYTES, sha256Hex } from "./manifest.ts";
import { snapshotResource } from "../../convex/model/manifestSnapshot.ts";
import type { StageSource } from "../../convex/model/stageSource.ts";
import { stableJson } from "../../convex/model/objects.ts";
import { StageSessionRefusedError } from "./observability-client.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export interface SyncClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RemoteManifestResponse {
  manifest: CliManifest;
  ids: GeneratedIds;
  revision?: number;
  /** sha256 of the stage's manifest as `broods diff` compares it. */
  manifestHash?: string;
  /** The stored source revision the stage now runs, when the sync carried source. */
  sourceRevision?: number;
  warnings?: { missingPolicies?: string[]; reservedResources?: string[] };
  deployment?: {
    accountId: string;
    endpointId: string;
    projectSlug: string;
    stageSlug: string;
    stageKind?: "development" | "production" | "custom";
    keyHint: string;
    apiKey: string;
    userTokenSecretHint?: string;
  } | null;
}

export interface CliOnboardingOrg {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  plan?: "free" | "pro";
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
  account?: CliOnboardingAccount | null;
  user?: CliOnboardingUser;
}

export interface CliStageSession {
  token: string;
  expiresAt: number;
  projectSlug: string;
  stageSlug: string;
}

export interface CliStage {
  id: string;
  name: string;
  kind: "development" | "production" | "custom";
  isDefault: boolean;
  deploymentRegion?: DeploymentRegion;
  agentCount: number;
  variableCount: number;
  updatedAt: number;
}

export interface CliProject {
  id: string;
  name: string;
  slug: string;
  empty: boolean;
  stageCount: number;
  agentCount: number;
  variableCount: number;
  deploymentCount: number;
  fileCount: number;
  updatedAt: number;
}

/** A project's link to a GitHub repo; each stage with a branch deploys on push to it. */
export interface CliGitHubLink {
  fullName: string;
  /** The folder holding `broods/`; "" is the repo root. */
  rootDirectory: string;
  productionBranch?: string;
  developmentBranch?: string;
  /** False on a plan without environments: the keys are repo secrets any branch can read. */
  protectedSecrets: boolean;
  /** The PR carrying the workflow, when a protected branch refused a direct commit. */
  setupPullRequestUrl?: string;
}

/** What `broods github` shows: the org's GitHub accounts, the project's link and latest runs. */
export interface CliGitHubStatus {
  /** False when the server has no GitHub App. */
  configured: boolean;
  /** Whether the caller may connect accounts (an org admin). */
  canConnect: boolean;
  /** Whether the caller may link or unlink this project (`keys:write`). */
  canLink: boolean;
  webUrl?: string;
  installations: Array<{
    installationId: number;
    login: string;
    accountType: "User" | "Organization";
  }>;
  repo?: CliGitHubLink;
  deploys: Array<{
    branch: string;
    sha: string;
    status: string;
    conclusion?: string;
    url: string;
    updatedAt: number;
  }>;
}

/** A repo a connected GitHub account lets this org link. */
export interface CliGitHubRepo {
  installationId: number;
  repoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * A link request. A branch left out takes its default (the repo's default
 * branch for Production, `dev` for Development); `null` deploys no such stage.
 */
export interface CliGitHubLinkInput {
  /** `owner/name`. */
  repo: string;
  /** The folder holding `broods/`, needed when the repo has several. */
  folder?: string;
  /** The Broods API the workflow deploys to. */
  baseUrl: string;
  productionBranch?: string | null;
  developmentBranch?: string | null;
}

/** A stored environment variable as listed by the CLI (name only; value is write-only). */
export interface CliEnvVar {
  name: string;
  updatedAt: number;
  valueDigest: string;
}

export type DiffOperation = "create" | "update" | "delete" | "rename";

export interface DiffEntry {
  operation: DiffOperation;
  kind: string;
  name: string;
  previousName?: string;
}

export class ManifestConflictError extends Error {}

export class RouteNotMountedError extends Error {}

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
    revision?: number,
    source?: StageSource,
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
          ...(revision !== undefined ? { revision: revision } : {}),
          ...(source ? { source: source } : {}),
        }),
      },
      // A sync deploys MCP bundles and can hold the connection for minutes.
      null,
    );
    await assertOk(response, "Sync manifest failed");

    return (await response.json()) as RemoteManifestResponse;
  }

  // The config plane caps request bodies near 20 MB.
  private async externalizeLargeMcpBundles(
    manifest: CliManifest,
  ): Promise<CliManifest> {
    if (
      manifest.resources.every(
        (resource): boolean => largeBundleOf(resource) === null,
      )
    ) {
      return manifest;
    }

    const resources = await Promise.all(
      manifest.resources.map(async (resource): Promise<CliManifestResource> => {
        const bundle = largeBundleOf(resource);
        if (bundle === null) return resource;
        const { bundle: _bundle, ...rest } = resource.config as Record<
          string,
          unknown
        >;
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
            sha256: sha256Hex(bundle),
          },
        };
      }),
    );

    return { ...manifest, resources: resources };
  }

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
    // Bundles run to tens of MB, so no fixed timeout fits a slow uplink.
    const stored = await this.send(
      uploadUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/javascript" },
        body: bundle,
      },
      null,
    );
    await assertOk(stored, "Bundle upload failed");
    const { storageId } = (await stored.json()) as { storageId?: string };
    if (!storageId)
      throw new Error("Bundle upload failed: response omitted storageId");

    return storageId;
  }

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

  async rotateUserTokenSecret(
    project: string,
    stage: string,
  ): Promise<{ secret: string; hint: string } | null> {
    const response = await this.request(project, stage, "/user-token-secret", {
      method: "POST",
    });
    if (response.status === 404) return null;
    await assertOk(response, "Rotate user token signing secret failed");
    const payload = (await response.json()) as {
      secret?: string;
      hint?: string;
    };
    if (!payload.secret || !payload.hint) {
      throw new Error(
        "Rotate user token signing secret failed: response omitted the secret",
      );
    }

    return { secret: payload.secret, hint: payload.hint };
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

  async listEnv(project: string, stage: string): Promise<CliEnvVar[]> {
    const response = await this.request(project, stage, "/env", {
      method: "GET",
    });
    await assertOk(response, "List environment variables failed");
    const payload = (await response.json()) as { variables?: CliEnvVar[] };

    return payload.variables ?? [];
  }

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
    const response = await this.send(`${this.baseUrl}/v1/account/onboarding`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    assertRouteMounted(response, "/v1/account/onboarding", "broods org");
    await assertOk(response, "Fetch CLI onboarding context failed");

    return (await response.json()) as CliOnboardingContext;
  }

  async selectOnboardingOrg(orgId: string): Promise<CliOnboardingContext> {
    const response = await this.send(`${this.baseUrl}/v1/account/onboarding`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orgId: orgId }),
    });
    await assertOk(response, "Select CLI org failed");

    return (await response.json()) as CliOnboardingContext;
  }

  async listStages(project: string): Promise<CliStage[]> {
    const response = await this.send(
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
    const response = await this.send(`${this.baseUrl}/v1/account/stages`, {
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

  async mintStageSession(
    project: string,
    stage: string,
  ): Promise<CliStageSession> {
    const response = await this.send(
      `${this.baseUrl}/v1/account/stage-session`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: project, stage: stage }),
      },
    );
    assertRouteMounted(response, "/v1/account/stage-session", "broods logs");
    try {
      await assertOk(response, "Open stage session failed");
    } catch (error) {
      // No login or no deployment: a retry gets the same answer.
      if (response.status === 401 || response.status === 404) {
        throw new StageSessionRefusedError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }

    return (await response.json()) as CliStageSession;
  }

  async listProjects(): Promise<CliProject[]> {
    const response = await this.send(`${this.baseUrl}/v1/account/projects`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    assertRouteMounted(response, "/v1/account/projects", "broods project");
    await assertOk(response, "List projects failed");
    const payload = (await response.json()) as { projects?: CliProject[] };

    return payload.projects ?? [];
  }

  async deleteProject(projectId: string): Promise<CliProject | null> {
    const response = await this.send(
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

  /** The project's GitHub link and the org's connected accounts. */
  async githubStatus(project: string): Promise<CliGitHubStatus> {
    return await this.github<CliGitHubStatus>("GET", "", project);
  }

  /** The repos the project may link, across the org's connected accounts. */
  async githubRepos(project: string): Promise<CliGitHubRepo[]> {
    const payload = await this.github<{ repos: CliGitHubRepo[] }>(
      "GET",
      "/repos",
      project,
    );

    return payload.repos;
  }

  /** Links a repo: seals a key per mapped stage into it and commits the deploy workflow. */
  async githubLink(
    project: string,
    input: CliGitHubLinkInput,
  ): Promise<CliGitHubLink> {
    const payload = await this.github<{ repo: CliGitHubLink }>(
      "POST",
      "/link",
      project,
      input,
    );

    return payload.repo;
  }

  /** Unlinks the project's repo and revokes its keys; the repo keeps its workflow. */
  async githubUnlink(project: string): Promise<void> {
    await this.github("DELETE", "/link", project);
  }

  /** Page that installs the Broods GitHub App on another account; it returns to the dashboard. */
  async githubConnect(): Promise<{ url: string }> {
    return await this.github<{ url: string }>("POST", "/connect");
  }

  async createOnboardingOrg(name: string): Promise<CliOnboardingContext> {
    const response = await this.send(`${this.baseUrl}/v1/account/onboarding`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ createOrgName: name }),
    });
    await assertOk(response, "Create CLI org failed");

    return (await response.json()) as CliOnboardingContext;
  }

  // A `broods github` call: `/v1/account/github{suffix}?project=`, with a `broods login` token.
  private async github<T = unknown>(
    method: string,
    suffix: string,
    project?: string,
    body?: unknown,
  ): Promise<T> {
    const query = project ? `?project=${encodeURIComponent(project)}` : "";
    const response = await this.send(
      `${this.baseUrl}/v1/account/github${suffix}${query}`,
      {
        method: method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      // Linking writes the repo's secrets, branch and workflow on GitHub.
      method === "POST" ? 120_000 : undefined,
    );
    assertRouteMounted(response, "/v1/account/github", "broods github");
    await assertOk(response, `GitHub ${method} ${suffix || "status"} failed`);

    return (await response.json()) as T;
  }

  private async request(
    project: string,
    stage: string,
    suffix: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
    timeoutMs?: number | null,
  ): Promise<Response> {
    const url =
      `${this.baseUrl}/v1/account/projects/${encodeURIComponent(project)}` +
      `/stages/${encodeURIComponent(stage)}${suffix}`;

    return await this.send(
      url,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...init.headers,
        },
      },
      timeoutMs,
    );
  }

  private async send(
    url: string,
    init: RequestInit,
    timeoutMs?: number | null,
  ): Promise<Response> {
    return await cliFetch(url, init, {
      fetch: this.fetchImpl,
      timeoutMs: timeoutMs,
    });
  }
}

export async function cliFetch(
  url: string,
  init: RequestInit,
  options: { fetch?: typeof fetch; timeoutMs?: number | null } = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs =
    options.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
  try {
    return await fetchImpl(
      url,
      timeoutMs === null
        ? init
        : { ...init, signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (error) {
    throw new Error(
      `Cannot reach ${new URL(url).origin}: ${networkFailureReason(error, timeoutMs)}`,
      { cause: error },
    );
  }
}

export function diffManifests(
  local: CliManifest,
  remote: CliManifest | null,
): DiffEntry[] {
  const remoteResources = new Map(
    (remote?.resources ?? []).map((entry): [string, CliManifestResource] => [
      `${entry.kind}:${entry.name}`,
      entry,
    ]),
  );
  const localResources = new Map(
    local.resources.map((entry): [string, CliManifestResource] => [
      `${entry.kind}:${entry.name}`,
      entry,
    ]),
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
      (remoteEntry): boolean =>
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

  return entries.sort((a, b): number =>
    diffSortKey(a).localeCompare(diffSortKey(b)),
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

function isRenamableKind(kind: string): boolean {
  return (
    kind === "agent" ||
    kind === "workspace" ||
    kind === "sandbox" ||
    kind === "policy"
  );
}

function renameSnapshot(
  resource: { kind: string; config: unknown } & Record<string, unknown>,
): unknown {
  const normalized = snapshotResource(resource) as Record<string, unknown>;
  const { name: _name, ...rest } = normalized;

  return rest;
}

async function assertOk(response: Response, message: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  const { message: reason = body, code } = errorEnvelope(body);
  if (code === "manifest_conflict") throw new ManifestConflictError(reason);
  const hint =
    response.status === 401 ? "\nRun `broods login` to sign in again." : "";

  throw new Error(`${message}: ${response.status} ${reason}${hint}`);
}

function errorEnvelope(body: string): { message?: string; code?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  const error =
    typeof parsed === "object" && parsed !== null && "error" in parsed
      ? parsed.error
      : undefined;
  if (typeof error !== "object" || error === null) return {};

  return {
    ...("message" in error && typeof error.message === "string"
      ? { message: error.message }
      : {}),
    ...("code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

// A 404 that is not JSON came from the router, not a handler: the server predates the route.
function assertRouteMounted(
  response: Response,
  route: string,
  command: string,
): void {
  if (response.status !== 404) return;
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) return;

  throw new RouteNotMountedError(
    `This broods server is older than your CLI and does not support \`${command}\` yet (no ${route} route).`,
  );
}

function networkFailureReason(
  error: unknown,
  timeoutMs: number | null,
): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError" && timeoutMs !== null) {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  // Node wraps the socket error in `cause` under a bare "fetch failed"; Bun throws it.
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  if (cause.message) return cause.message;

  return "code" in cause && typeof cause.code === "string"
    ? cause.code
    : error.message;
}

function largeBundleOf(
  resource: CliManifest["resources"][number],
): string | null {
  if (resource.kind !== "mcp") return null;
  const bundle = (resource.config as { bundle?: unknown })?.bundle;
  if (typeof bundle !== "string") return null;

  return Buffer.byteLength(bundle) > INLINE_MCP_BUNDLE_BYTES ? bundle : null;
}

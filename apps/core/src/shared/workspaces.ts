import { supportsS3WorkspaceMount } from "@broods/convex/model/sandboxProviders";
import { assertNoRetiredImageOptions } from "@broods/convex/model/sandboxRules";
import type { ChannelPartition, AgentConfig } from "./domain/agent-config.ts";
import type {
  SandboxConfig,
  SandboxConfigRecord,
} from "./domain/sandbox-config.ts";
import type {
  WorkspaceIsolation,
  WorkspaceRuntimeConfig,
  WorkspaceStorageConfig,
} from "./domain/workspace-config.ts";
import {
  agentNamespaceFolder,
  normalizeFilesystemNamespace,
} from "./runtime-keys.ts";
import { resolveSandboxLifecycle } from "./sandbox.ts";
import {
  resolveSandboxSpecs,
  type SandboxControlPlane,
} from "./sandbox-sizes.ts";
import { getStorage } from "./storage.ts";

export type WorkspaceSandboxConfig = SandboxConfig & {
  storage?: WorkspaceStorageConfig;
  controlPlane?: SandboxControlPlane;
};

export interface ResolvedWorkspace {
  name: string;
  workspaceId: string;
  namespace: string;
  description?: string;
  config: WorkspaceRuntimeConfig;
  // Unset: the workspace is read-only (no write, edit, grep or bash).
  sandbox?: WorkspaceSandboxConfig;
  // Unset: read/glob read S3 directly, which lags writes made through a mount.
  readMount?: SandboxConfig;
}

export interface ResolvedAgentSandbox {
  name: string;
  description?: string;
  sandbox: WorkspaceSandboxConfig;
}

// In both lists the first entry is the default.
export interface ResolvedAgentRuntime {
  sandboxes: ResolvedAgentSandbox[];
  workspaces: ResolvedWorkspace[];
}

export interface WorkspaceIsolationScope {
  agentId?: string;
  channelName?: string;
  channelScopeKey?: string;
  conversationKey?: string;
  partition?: ChannelPartition;
}

export interface AgentRuntimeIdentity {
  accountId?: string;
  agentId?: string;
}

interface LoadedSandbox {
  record: SandboxConfigRecord;
  sandbox: WorkspaceSandboxConfig;
}

// Account cleanup asks this too, so the machine it releases is the one reserved.
export function agentSandboxReservation(
  sandbox: WorkspaceSandboxConfig,
  accountId: string | undefined,
  agentId: string | undefined,
  sandboxId: string,
): string | undefined {
  if (sandbox.persistent !== true || !accountId) {
    return undefined;
  }
  const pinned = sandbox.options?.reservationKey;
  if (typeof pinned === "string" && pinned.trim().length > 0) {
    return pinnedSandboxReservationKey(accountId, pinned.trim());
  }
  if (!agentId) {
    return undefined;
  }

  return agentSandboxReservationKey(accountId, agentId, sandboxId);
}

export function agentSandboxReservationKey(
  accountId: string,
  agentId: string,
  sandboxId: string,
): string {
  return normalizeFilesystemNamespace(`${accountId}:${agentId}:${sandboxId}`);
}

export function isolatedWorkspaceNamespace(
  baseNamespace: string,
  isolation: WorkspaceIsolation | undefined,
  scope: WorkspaceIsolationScope = {},
): string {
  if (isolation === undefined) {
    return baseNamespace;
  }
  if (isolation === "agent") {
    if (!scope.agentId) {
      throw new Error('Workspace isolation "agent" requires an agent identity');
    }

    return `${baseNamespace}/${agentNamespaceFolder(scope.agentId)}`;
  }

  const partition = scope.partition;
  if (!partition) {
    if (!scope.channelName) {
      return baseNamespace;
    }
    throw new Error(
      "Workspace isolation requires the active channel to define partition",
    );
  }

  if (partition.by === "shared") {
    return baseNamespace;
  }

  const conversationKey = scope.conversationKey ?? scope.channelScopeKey;
  if (!conversationKey) {
    throw new Error(
      "Conversation workspace isolation requires an active conversation key",
    );
  }

  return `${baseNamespace}/${partition.alias}/${normalizeFilesystemNamespace(conversationKey)}`;
}

// The registry is keyed by reservation key alone, so unscoped pinned text could
// reconnect to another account's reserved machine.
export function pinnedSandboxReservationKey(
  accountId: string,
  reservationKey: string,
): string {
  return normalizeFilesystemNamespace(`${accountId}:pinned:${reservationKey}`);
}

export async function resolveAgentRuntime(
  agentConfig: AgentConfig,
  identity: AgentRuntimeIdentity,
  isolationScope: WorkspaceIsolationScope = {},
): Promise<ResolvedAgentRuntime> {
  const accountId = identity.accountId;
  const storage = getStorage();
  const sandboxCache = new Map<string, Promise<LoadedSandbox>>();

  // Workspaces inheriting the default take the unreserved copy and reserve on their namespace.
  async function loadAgentSandbox(
    sandboxId: string,
  ): Promise<ResolvedAgentSandbox> {
    const loaded = await loadSandbox(sandboxId);

    return {
      name: loaded.record.name,
      ...(loaded.record.description
        ? { description: loaded.record.description }
        : {}),
      sandbox: reservedAgentSandbox(
        loaded.sandbox,
        accountId,
        identity.agentId,
        sandboxId,
      ),
    };
  }

  function loadSandbox(sandboxId: string): Promise<LoadedSandbox> {
    if (!accountId) {
      throw new Error("Cannot resolve sandbox reference without an account");
    }
    const cached = sandboxCache.get(sandboxId);
    if (cached) {
      return cached;
    }
    const loading = storage.sandboxConfigs
      .getById(accountId, sandboxId)
      .then((record): LoadedSandbox => {
        if (!record) {
          throw new Error(`Referenced sandbox not found: ${sandboxId}`);
        }
        // Write-time validation misses rows stored before `snapshot` replaced these.
        assertNoRetiredImageOptions(
          record.config.provider,
          record.config.options ?? {},
        );

        return {
          record: record,
          sandbox: {
            ...record.config,
            controlPlane: sandboxControlPlane(accountId, record),
          },
        };
      });
    sandboxCache.set(sandboxId, loading);

    return loading;
  }

  async function loadWorkspaces(
    defaultSandboxId: string | undefined,
  ): Promise<ResolvedWorkspace[]> {
    const sandbox = defaultSandboxId
      ? (await loadSandbox(defaultSandboxId)).sandbox
      : undefined;
    const workspaces: ResolvedWorkspace[] = [];
    for (const ref of agentConfig.workspaces ?? []) {
      if (!accountId) {
        throw new Error(
          "Cannot resolve workspace reference without an account",
        );
      }
      const record = await storage.workspaceConfigs.getById(
        accountId,
        ref.workspaceId,
      );
      if (!record) {
        throw new Error(
          `Referenced workspace not found: ${ref.workspaceId} (as "${ref.name}")`,
        );
      }
      let effectiveSandbox: WorkspaceSandboxConfig | undefined;
      if (ref.sandbox === null) {
        effectiveSandbox = undefined;
      } else if (typeof ref.sandbox === "string" && ref.sandbox.length > 0) {
        effectiveSandbox = (await loadSandbox(ref.sandbox)).sandbox;
      } else {
        effectiveSandbox = sandbox;
      }
      const ownBucket = Boolean(record.config.storage?.bucket);
      assertSandboxReachesWorkspace(ref.name, effectiveSandbox, ownBucket);
      const readMount: SandboxConfig | undefined =
        !effectiveSandbox && ref.sandbox !== null && !ownBucket
          ? { provider: "lambda", network: { mode: "deny-all" } }
          : undefined;
      workspaces.push({
        name: ref.name,
        workspaceId: ref.workspaceId,
        namespace: isolatedWorkspaceNamespace(
          workspaceNamespace(accountId, ref.workspaceId),
          record.config.isolation,
          { ...isolationScope, agentId: identity.agentId },
        ),
        ...(record.description ? { description: record.description } : {}),
        config: record.config,
        ...(effectiveSandbox
          ? {
              sandbox: {
                ...effectiveSandbox,
                ...(record.config.storage
                  ? { storage: record.config.storage }
                  : {}),
              },
            }
          : {}),
        ...(readMount ? { readMount: readMount } : {}),
      });
    }

    return workspaces;
  }

  const sandboxIds = agentConfig.sandboxes ?? [];
  const [sandboxes, workspaces] = await Promise.all([
    Promise.all(sandboxIds.map(loadAgentSandbox)),
    loadWorkspaces(sandboxIds[0]),
  ]);
  assertDistinctSandboxNames(sandboxes);

  return {
    sandboxes: sandboxes,
    workspaces: workspaces,
  };
}

// Unmetered and outside the plan budget. Mirrors each executor's credential pick: its own
// key wins over the platform env, and a blank one falls back to the platform's.
export function runsOnOwnCredentials(config: SandboxConfig): boolean {
  const options = config.options ?? {};
  const has = (key: string): boolean => {
    const value = options[key];

    return typeof value === "string" && value.trim() !== "";
  };
  switch (config.provider) {
    case "daytona":
    case "e2b":
      return has("apiKey");
    case "vercel":
      return has("token");
    case "sandbox":
      return has("workdirUrl");
    case "machine":
    case "custom":
      return true;
    case "cloudflare":
    case "worker":
    case "lambda":
      return false;
  }
}

export function workspaceNamespace(
  accountId: string | undefined,
  workspaceId: string,
): string {
  const scope = accountId ? `${accountId}:${workspaceId}` : workspaceId;

  return normalizeFilesystemNamespace(scope);
}

// The CLI sync's rule, held here so an API-made config cannot skip it. A fallback gets none
// of the primary's options; a lambda off allow-all reaches only the managed bucket.
function assertSandboxReachesWorkspace(
  workspaceName: string,
  sandbox: WorkspaceSandboxConfig | undefined,
  ownBucket: boolean,
): void {
  const unmountable = !sandbox
    ? undefined
    : !supportsS3WorkspaceMount(sandbox.provider, sandbox.options)
      ? sandbox.provider
      : sandbox.fallbackProvider &&
          !supportsS3WorkspaceMount(sandbox.fallbackProvider, undefined)
        ? sandbox.fallbackProvider
        : undefined;
  if (unmountable) {
    throw new Error(
      `Workspace "${workspaceName}" cannot run on a ${unmountable} sandbox; give it its own sandbox or set sandbox: null`,
    );
  }
  if (
    sandbox?.provider === "lambda" &&
    sandbox.network?.mode !== "allow-all" &&
    ownBucket
  ) {
    throw new Error(
      `Workspace "${workspaceName}" uses its own bucket, which a lambda sandbox reaches only with network allow-all; set that or sandbox: null`,
    );
  }
}

function assertDistinctSandboxNames(sandboxes: ResolvedAgentSandbox[]): void {
  const seen = new Set<string>();
  for (const entry of sandboxes) {
    if (seen.has(entry.name)) {
      throw new Error(
        `Sandbox "${entry.name}" is attached twice; bash picks a sandbox by name`,
      );
    }
    seen.add(entry.name);
  }
}

function reservedAgentSandbox(
  sandbox: WorkspaceSandboxConfig,
  accountId: string | undefined,
  agentId: string | undefined,
  sandboxId: string,
): WorkspaceSandboxConfig {
  const reservationKey = agentSandboxReservation(
    sandbox,
    accountId,
    agentId,
    sandboxId,
  );
  if (!reservationKey || reservationKey === sandbox.options?.reservationKey) {
    return sandbox;
  }

  return {
    ...sandbox,
    options: {
      ...sandbox.options,
      reservationKey: reservationKey,
    },
  };
}

export function sandboxControlPlane(
  accountId: string,
  record: SandboxConfigRecord,
): SandboxControlPlane {
  return {
    accountId: accountId,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.stageId ? { stageId: record.stageId } : {}),
    sandboxConfigId: record.sandboxId,
    name: record.name,
    specs: resolveSandboxSpecs({
      provider: record.config.provider,
      size: record.config.size,
      options: record.config.options,
    }),
    ...(record.config.snapshot ? { snapshotId: record.config.snapshot } : {}),
    ...(record.config.network ? { egress: record.config.network.mode } : {}),
    ...(record.config.permissionMode
      ? { permissionMode: record.config.permissionMode }
      : {}),
    ...(runsOnOwnCredentials(record.config) ? { ownCredentials: true } : {}),
    idleTimeoutSeconds: resolveSandboxLifecycle(record.config.lifecycle)
      .idleTimeoutSeconds,
  };
}

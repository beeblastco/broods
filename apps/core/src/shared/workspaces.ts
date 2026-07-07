/**
 * Workspace + sandbox runtime resolution shared by harness sessions and cleanup.
 *
 * Agents reference standalone, account-scoped sandbox / workspace records by id.
 * This module resolves those references into concrete runtime configs and derives
 * the filesystem namespace for each workspace. The namespace is scoped by
 * `accountId:workspaceId` (NOT agent/conversation), so agents that share a
 * workspaceId read and write the SAME files.
 */

import { normalizeFilesystemNamespace } from "./runtime-keys.ts";
import { getStorage } from "./storage/index.ts";
import type {
  AgentChannelWorkspaceScope,
  AgentConfig,
  AgentWorkspaceRef,
  SandboxConfig,
  SandboxConfigRecord,
  WorkspaceConfig,
} from "./storage/index.ts";
import type { WorkspaceStorageConfig } from "./storage/workspace-config.ts";
import { resolveSandboxSpecs, type SandboxControlPlane } from "./sandbox-sizes.ts";

// The effective sandbox for a workspace, with the workspace's storage identity and
// control-plane identity attached. Storage drives the S3 mount target/creds and
// belongs to the workspace; controlPlane lets a reserved instance mirror itself into
// Convex. Both are merged onto the sandbox compute record here, not stored on it.
export type WorkspaceSandboxConfig = SandboxConfig & {
  storage?: WorkspaceStorageConfig;
  controlPlane?: SandboxControlPlane;
};

// A workspace resolved for a turn: the storage record plus its effective sandbox.
// This is the single shape the session, tools, and prompts all consume. Conventions:
//   - `name` is the agent-facing mount label (the `workspace` arg the model selects).
//   - the FIRST workspace in the list is the default (used when the model omits `workspace`).
//   - `sandbox` undefined => the workspace is read-only (write/edit/grep/bash are not
//     exposed). read/glob then run through `readMount` (a service-managed read-only
//     Lambda mount) by default, or straight from S3 when the ref opts out with `sandbox: null`.
export interface ResolvedWorkspace {
  name: string;
  workspaceId: string;
  namespace: string;
  description?: string;
  config: WorkspaceConfig;
  sandbox?: WorkspaceSandboxConfig;
  // Read-only read runner. Set when the workspace has no effective sandbox AND the
  // ref did not explicitly opt out with `sandbox: null`. read/glob use it to read
  // through the mount so they see committed writes immediately; undefined => read S3
  // directly (the `sandbox: null` opt-out — no Lambda/VPC, but lags mount writes).
  readMount?: SandboxConfig;
}

export interface ResolvedAgentRuntime {
  // Agent-level default sandbox. Powers stateless bash (no workspace) and is the
  // fallback sandbox for workspaces that don't declare their own.
  sandbox?: WorkspaceSandboxConfig;
  workspaces: ResolvedWorkspace[];
}

export interface WorkspaceIsolationScope {
  channelName?: string;
  channelScopeKey?: string;
  conversationKey?: string;
  workspaceScope?: AgentChannelWorkspaceScope;
}

/** Derive the shared filesystem namespace for a workspace record. */
export function workspaceNamespace(accountId: string | undefined, workspaceId: string): string {
  const scope = accountId ? `${accountId}:${workspaceId}` : workspaceId;
  return normalizeFilesystemNamespace(scope);
}

export function workspaceNamespaceOwnsReservationKey(namespace: string, reservationKey: string): boolean {
  return reservationKey === namespace || reservationKey.startsWith(`${namespace}/`);
}

export function isolatedWorkspaceNamespace(
  baseNamespace: string,
  isolation: boolean | undefined,
  scope: WorkspaceIsolationScope = {},
): string {
  if (isolation !== true) {
    return baseNamespace;
  }

  const workspaceScope = scope.workspaceScope;
  if (!workspaceScope) {
    if (!scope.channelName) {
      return baseNamespace;
    }
    throw new Error("Workspace isolation requires the active channel to define workspaceScope");
  }

  if (workspaceScope.level === "channel") {
    return baseNamespace;
  }

  const conversationKey = scope.conversationKey ?? scope.channelScopeKey;
  if (!conversationKey) {
    throw new Error("Conversation workspace isolation requires an active conversation key");
  }
  return `${baseNamespace}/${workspaceScope.alias}/${normalizeFilesystemNamespace(conversationKey)}`;
}

/**
 * Resolve an agent's `sandbox` + `workspaces` references into concrete records.
 * Throws a clear error when a referenced record is missing (misconfigured agent).
 */
export async function resolveAgentRuntime(
  agentConfig: AgentConfig,
  accountId: string | undefined,
  isolationScope: WorkspaceIsolationScope = {},
): Promise<ResolvedAgentRuntime> {
  const storage = getStorage();
  const sandboxCache = new Map<string, WorkspaceSandboxConfig>();

  // Load (and memoize) a sandbox record so a sandbox shared across workspaces is
  // only fetched once. The control-plane identity (account + size specs) is attached
  // here so a reserved instance mirrors itself into Convex from the executor.
  async function loadSandbox(sandboxId: string): Promise<WorkspaceSandboxConfig> {
    if (!accountId) {
      throw new Error("Cannot resolve sandbox reference without an account");
    }
    const cached = sandboxCache.get(sandboxId);
    if (cached) {
      return cached;
    }
    const record = await storage.sandboxConfigs.getById(accountId, sandboxId);
    if (!record) {
      throw new Error(`Referenced sandbox not found: ${sandboxId}`);
    }
    const resolved: WorkspaceSandboxConfig = {
      ...record.config,
      controlPlane: sandboxControlPlane(accountId, record),
    };
    sandboxCache.set(sandboxId, resolved);
    return resolved;
  }

  const sandbox = typeof agentConfig.sandbox === "string" && agentConfig.sandbox.length > 0
    ? await loadSandbox(agentConfig.sandbox)
    : undefined;

  const workspaces: ResolvedWorkspace[] = [];
  for (const ref of agentConfig.workspaces ?? []) {
    if (!accountId) {
      throw new Error("Cannot resolve workspace reference without an account");
    }
    const record = await storage.workspaceConfigs.getById(accountId, ref.workspaceId);
    if (!record) {
      throw new Error(`Referenced workspace not found: ${ref.workspaceId} (as "${ref.name}")`);
    }
    // Effective sandbox cascade:
    //   null            => read-only opt-out (even when an agent default exists)
    //   "sb_…" (string) => per-workspace override
    //   undefined       => inherit the agent-level default (read-only if none)
    let effectiveSandbox: WorkspaceSandboxConfig | undefined;
    if (ref.sandbox === null) {
      effectiveSandbox = undefined;
    } else if (typeof ref.sandbox === "string" && ref.sandbox.length > 0) {
      effectiveSandbox = await loadSandbox(ref.sandbox);
    } else {
      effectiveSandbox = sandbox;
    }
    // Read-only workspace (no effective sandbox): default to reading through a
    // service-managed read-only Lambda mount (network denied, cheapest mount slot) so
    // reads reflect committed writes immediately. The existing `sandbox: null` opt-out
    // ("no sandbox, no compute") also skips the mount: read straight from S3 instead.
    const readMount: SandboxConfig | undefined =
      !effectiveSandbox && ref.sandbox !== null
        ? { provider: "lambda", network: { mode: "deny-all" } }
        : undefined;
    workspaces.push({
      name: ref.name,
      workspaceId: ref.workspaceId,
      namespace: isolatedWorkspaceNamespace(
        workspaceNamespace(accountId, ref.workspaceId),
        record.config.isolation,
        isolationScope,
      ),
      ...(record.description ? { description: record.description } : {}),
      config: record.config,
      // Attach the workspace's storage identity to its effective sandbox so the
      // executor resolves the mount against the right bucket/creds.
      ...(effectiveSandbox
        ? { sandbox: { ...effectiveSandbox, ...(record.config.storage ? { storage: record.config.storage } : {}) } }
        : {}),
      ...(readMount ? { readMount } : {}),
    });
  }

  return { ...(sandbox ? { sandbox } : {}), workspaces };
}

/**
 * Build the control-plane identity for a sandbox config so a reserved instance can
 * mirror itself into the Convex `sandboxInstances` registry (account, config row,
 * display name, size specs).
 */
function sandboxControlPlane(accountId: string, record: SandboxConfigRecord): SandboxControlPlane {
  return {
    accountId,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.environmentId ? { environmentId: record.environmentId } : {}),
    sandboxConfigId: record.sandboxId,
    name: record.name,
    specs: resolveSandboxSpecs({
      size: record.config.size,
      options: record.config.options,
      memoryLimit: record.config.memoryLimit,
    }),
    ...(record.config.snapshot ? { snapshotId: record.config.snapshot } : {}),
    ...(record.config.network ? { egress: record.config.network.mode } : {}),
    ...(record.config.permissionMode ? { permissionMode: record.config.permissionMode } : {}),
  };
}

/**
 * Namespaces for an account's workspace records, used by cleanup to purge the
 * S3 data for shared workspaces. Pass the account's workspace ids.
 */
export function workspaceNamespacesForAccount(accountId: string, workspaceIds: string[]): string[] {
  return workspaceIds.map((workspaceId) => workspaceNamespace(accountId, workspaceId));
}

export function resolveWorkspaceRefs(agentConfig: AgentConfig): AgentWorkspaceRef[] {
  return agentConfig.workspaces ?? [];
}

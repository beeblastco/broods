/**
 * Workspace + sandbox runtime resolution shared by harness sessions and cleanup.
 *
 * Agents reference standalone, account-scoped sandbox / workspace records by id.
 * This module resolves those references into concrete runtime configs and derives
 * each workspace's filesystem namespace. The namespace is scoped by
 * `accountId:workspaceId`, NOT agent or conversation, so agents that share a
 * workspaceId read and write the SAME files.
 */

import type {
  ChannelPartition,
  AgentConfig,
  AgentWorkspaceRef,
} from "./domain/agent-config.ts";
import type {
  SandboxConfig,
  SandboxConfigRecord,
} from "./domain/sandbox-config.ts";
import type {
  WorkspaceConfig,
  WorkspaceStorageConfig,
} from "./domain/workspace-config.ts";
import { normalizeFilesystemNamespace } from "./runtime-keys.ts";
import {
  resolveSandboxSpecs,
  type SandboxControlPlane,
} from "./sandbox-sizes.ts";
import { getStorage } from "./storage.ts";

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
  // directly (the `sandbox: null` opt-out, which skips Lambda/VPC but lags mount writes).
  readMount?: SandboxConfig;
}

// An extra sandbox from `config.sandboxes`. `name` is the sandbox record name the
// model picks with bash `sandbox`; `description` tells it what the sandbox is for.
export interface ResolvedAgentSandbox {
  name: string;
  description?: string;
  sandbox: WorkspaceSandboxConfig;
}

export interface ResolvedAgentRuntime {
  // Agent-level default sandbox. Powers stateless bash (no workspace) and is the
  // fallback sandbox for workspaces that don't declare their own.
  sandbox?: WorkspaceSandboxConfig;
  // Extra sandboxes bash reaches by name with no workspace mounted. Never the default.
  sandboxes: ResolvedAgentSandbox[];
  workspaces: ResolvedWorkspace[];
}

export interface WorkspaceIsolationScope {
  channelName?: string;
  channelScopeKey?: string;
  conversationKey?: string;
  partition?: ChannelPartition;
}

// Who the runtime is being resolved for. The agent's own sandbox is reserved per
// agent, so resolution needs the agent identity as well as the account.
export interface AgentRuntimeIdentity {
  accountId?: string;
  agentId?: string;
}

// A sandbox record as resolution loads it: the record for its name and description,
// the runtime config with the control-plane identity attached.
interface LoadedSandbox {
  record: SandboxConfigRecord;
  sandbox: WorkspaceSandboxConfig;
}

/**
 * The key an agent-level sandbox (the default or an extra) reserves on, or
 * undefined when it reserves nothing. A pinned `options.reservationKey` wins over
 * the derived key, and both `resolveAgentRuntime` and account-deletion cleanup ask
 * this one function so the machine released is the machine reserved.
 */
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

/**
 * Derive the reservation key for a workspace-less sandbox an agent reserves, scoped
 * `accountId:agentId:sandboxId` like workspaceNamespace's account-plus-record
 * scope: agents never share a machine by accident, and re-pointing an agent at
 * another sandbox record hands it that record's machine.
 */
export function agentSandboxReservationKey(
  accountId: string,
  agentId: string,
  sandboxId: string,
): string {
  return normalizeFilesystemNamespace(`${accountId}:${agentId}:${sandboxId}`);
}

export function isolatedWorkspaceNamespace(
  baseNamespace: string,
  isolation: boolean | undefined,
  scope: WorkspaceIsolationScope = {},
): string {
  if (isolation !== true) {
    return baseNamespace;
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

/**
 * Scope an author-pinned reservation key to its account. The registry lookup is
 * keyed by reservation key alone, so raw pinned text must never reach it: an
 * unscoped key could name, and reconnect to, another account's reserved machine.
 * The same string within one account still maps to one machine.
 */
export function pinnedSandboxReservationKey(
  accountId: string,
  reservationKey: string,
): string {
  return normalizeFilesystemNamespace(`${accountId}:pinned:${reservationKey}`);
}

/**
 * Resolve an agent's `sandbox`, `sandboxes` and `workspaces` references into
 * concrete records. Throws a clear error when a referenced record is missing
 * (misconfigured agent).
 */
export async function resolveAgentRuntime(
  agentConfig: AgentConfig,
  identity: AgentRuntimeIdentity,
  isolationScope: WorkspaceIsolationScope = {},
): Promise<ResolvedAgentRuntime> {
  const accountId = identity.accountId;
  const storage = getStorage();
  // Keyed on the in-flight fetch, so a record the extras and a workspace share is
  // fetched once even while both resolve concurrently.
  const sandboxCache = new Map<string, Promise<LoadedSandbox>>();

  // An extra never backs a workspace, so it keeps its record config and, when
  // persistent, reserves per agent and sandbox exactly like the default one.
  async function loadExtraSandbox(
    extraId: string,
  ): Promise<ResolvedAgentSandbox> {
    const extra = await loadSandbox(extraId);

    return {
      name: extra.record.name,
      ...(extra.record.description
        ? { description: extra.record.description }
        : {}),
      sandbox: reservedAgentSandbox(
        extra.sandbox,
        accountId,
        identity.agentId,
        extraId,
      ),
    };
  }

  // Load (and memoize) a sandbox record so a sandbox shared across workspaces is
  // only fetched once. The control-plane identity (account + size specs) is attached
  // here so a reserved instance mirrors itself into Convex from the executor.
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
    sandbox: WorkspaceSandboxConfig | undefined,
  ): Promise<ResolvedWorkspace[]> {
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
      // Effective sandbox cascade:
      //   null            => read-only opt-out (even when an agent default exists)
      //   "sb_…" (string) => per-workspace override
      //   undefined       => inherit the agent-level default (read-only if none)
      let effectiveSandbox: WorkspaceSandboxConfig | undefined;
      if (ref.sandbox === null) {
        effectiveSandbox = undefined;
      } else if (typeof ref.sandbox === "string" && ref.sandbox.length > 0) {
        effectiveSandbox = (await loadSandbox(ref.sandbox)).sandbox;
      } else {
        effectiveSandbox = sandbox;
      }
      // Read-only workspace (no effective sandbox): default to reading through a
      // service-managed read-only Lambda mount (network denied, cheapest mount slot)
      // so reads reflect committed writes immediately. The existing `sandbox: null`
      // opt-out ("no sandbox, no compute") also skips the mount: read straight from
      // S3 instead.
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
        // executor resolves the mount target against the right bucket/creds.
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

  const sandboxId =
    typeof agentConfig.sandbox === "string" && agentConfig.sandbox.length > 0
      ? agentConfig.sandbox
      : undefined;
  const sandbox = sandboxId
    ? (await loadSandbox(sandboxId)).sandbox
    : undefined;
  // The extras depend on nothing in the workspace loop, so they load alongside it.
  const [sandboxes, workspaces] = await Promise.all([
    Promise.all((agentConfig.sandboxes ?? []).map(loadExtraSandbox)),
    loadWorkspaces(sandbox),
  ]);
  assertDistinctSandboxNames(sandbox, sandboxes);

  // Only the agent-level copy carries the derived reservation key; the copies the
  // workspaces inherit key their reservation on the workspace namespace instead.
  return {
    ...(sandbox
      ? {
          sandbox: reservedAgentSandbox(
            sandbox,
            accountId,
            identity.agentId,
            sandboxId,
          ),
        }
      : {}),
    sandboxes: sandboxes,
    workspaces: workspaces,
  };
}

export function resolveWorkspaceRefs(
  agentConfig: AgentConfig,
): AgentWorkspaceRef[] {
  return agentConfig.workspaces ?? [];
}

export function workspaceNamespace(
  accountId: string | undefined,
  workspaceId: string,
): string {
  const scope = accountId ? `${accountId}:${workspaceId}` : workspaceId;

  return normalizeFilesystemNamespace(scope);
}

/**
 * Namespaces for an account's workspace records, used by cleanup to purge the
 * S3 data for shared workspaces. Pass the account's workspace ids.
 */
export function workspaceNamespacesForAccount(
  accountId: string,
  workspaceIds: string[],
): string[] {
  return workspaceIds.map((workspaceId) =>
    workspaceNamespace(accountId, workspaceId),
  );
}

// bash picks a sandbox by record name, so two records under one name would leave
// the model no way to reach the second.
function assertDistinctSandboxNames(
  sandbox: WorkspaceSandboxConfig | undefined,
  sandboxes: ResolvedAgentSandbox[],
): void {
  const seen = new Set(
    sandbox?.controlPlane?.name ? [sandbox.controlPlane.name] : [],
  );
  for (const extra of sandboxes) {
    if (seen.has(extra.name)) {
      throw new Error(
        `Sandbox "${extra.name}" is attached twice; bash picks a sandbox by name`,
      );
    }
    seen.add(extra.name);
  }
}

/**
 * Give a persistent agent-level sandbox (the default or an extra) the reservation
 * key its workspace-less runs key persistence on, so `persistent: true` works
 * without the author also supplying `options.reservationKey`. A sandbox that
 * reserves nothing passes through untouched.
 */
function reservedAgentSandbox(
  sandbox: WorkspaceSandboxConfig,
  accountId: string | undefined,
  agentId: string | undefined,
  sandboxId: string | undefined,
): WorkspaceSandboxConfig {
  if (!sandboxId) {
    return sandbox;
  }
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

/**
 * Build the control-plane identity for a sandbox config so a reserved instance can
 * mirror itself into the Convex `sandboxInstances` registry (account, config row,
 * display name, size specs).
 */
function sandboxControlPlane(
  accountId: string,
  record: SandboxConfigRecord,
): SandboxControlPlane {
  return {
    accountId: accountId,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.stageId ? { stageId: record.stageId } : {}),
    sandboxConfigId: record.sandboxId,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    specs: resolveSandboxSpecs({
      size: record.config.size,
      options: record.config.options,
      memoryLimit: record.config.memoryLimit,
    }),
    ...(record.config.snapshot ? { snapshotId: record.config.snapshot } : {}),
    ...(record.config.network ? { egress: record.config.network.mode } : {}),
    ...(record.config.permissionMode
      ? { permissionMode: record.config.permissionMode }
      : {}),
  };
}

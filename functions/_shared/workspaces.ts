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
  AgentConfig,
  AgentWorkspaceRef,
  SandboxConfig,
  WorkspaceConfig,
} from "./storage/index.ts";

// A workspace resolved for a turn: the storage record plus its effective sandbox.
// This is the single shape the session, tools, and prompts all consume. Conventions:
//   - `name` is the agent-facing mount label (the `workspace` arg the model selects).
//   - the FIRST workspace in the list is the default (used when the model omits `workspace`).
//   - `sandbox` undefined => the workspace is read-only (served directly from S3, no mount);
//     its tool `permissionMode` is then `sandbox.permissionMode` (default "ask").
export interface ResolvedWorkspace {
  name: string;
  workspaceId: string;
  namespace: string;
  description?: string;
  config: WorkspaceConfig;
  sandbox?: SandboxConfig;
}

export interface ResolvedAgentRuntime {
  // Agent-level default sandbox. Powers stateless bash (no workspace) and is the
  // fallback sandbox for workspaces that don't declare their own.
  sandbox?: SandboxConfig;
  workspaces: ResolvedWorkspace[];
}

/** Derive the shared filesystem namespace for a workspace record. */
export function workspaceNamespace(accountId: string | undefined, workspaceId: string): string {
  const scope = accountId ? `${accountId}:${workspaceId}` : workspaceId;
  return normalizeFilesystemNamespace(scope);
}

/**
 * Resolve an agent's `sandbox` + `workspaces` references into concrete records.
 * Throws a clear error when a referenced record is missing (misconfigured agent).
 */
export async function resolveAgentRuntime(
  agentConfig: AgentConfig,
  accountId: string | undefined,
): Promise<ResolvedAgentRuntime> {
  const storage = getStorage();
  const sandboxCache = new Map<string, SandboxConfig>();

  // Load (and memoize) a sandbox record so a sandbox shared across workspaces is
  // only fetched once.
  async function loadSandbox(sandboxId: string): Promise<SandboxConfig> {
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
    sandboxCache.set(sandboxId, record.config);
    return record.config;
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
    let effectiveSandbox: SandboxConfig | undefined;
    if (ref.sandbox === null) {
      effectiveSandbox = undefined;
    } else if (typeof ref.sandbox === "string" && ref.sandbox.length > 0) {
      effectiveSandbox = await loadSandbox(ref.sandbox);
    } else {
      effectiveSandbox = sandbox;
    }
    workspaces.push({
      name: ref.name,
      workspaceId: ref.workspaceId,
      namespace: workspaceNamespace(accountId, ref.workspaceId),
      ...(record.description ? { description: record.description } : {}),
      config: record.config,
      ...(effectiveSandbox ? { sandbox: effectiveSandbox } : {}),
    });
  }

  return { ...(sandbox ? { sandbox } : {}), workspaces };
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

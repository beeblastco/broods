/**
 * Workspace config: account-scoped, reusable workspace definitions referenced by
 * agents via `config.workspaces[].workspaceId`. A workspace is the persistent
 * S3-backed filesystem mounted into a sandbox; agents referencing the same
 * workspaceId share the same files unless `isolation` splits them. Holds no
 * secrets, so it is stored in
 * plaintext (unlike sandbox config). Validation and the public projection live
 * in packages/convex/model/workspaceRules.ts.
 */

import type {
  WorkspaceConfig as StoredWorkspaceConfig,
  WorkspaceStorageConfig as StoredWorkspaceStorageConfig,
} from "@broods/convex/model/workspaceRules";

export type { WorkspaceIsolation } from "@broods/convex/model/workspaceIsolation";
export type {
  WorkspaceStorageAuth,
  WorkspaceStorageProvider,
} from "@broods/convex/model/workspaceRules";

/**
 * Workspace storage as core carries it. An R2 bucket also carries its row's
 * identity, which a mount sends to Convex to mint scoped credentials; it is
 * stamped on load (shared/convex/storage.ts), never stored or accepted.
 */
export type WorkspaceStorageConfig = StoredWorkspaceStorageConfig & {
  owner?: { accountId: string; workspaceId: string };
};

export type WorkspaceConfig = Omit<StoredWorkspaceConfig, "storage"> & {
  storage: WorkspaceStorageConfig;
};

// The workspace harness is a set of named features, each with its own options
// and each defaulting to on. There is deliberately no top-level enabled flag:
// new capabilities get their own key here for independent control.
//   - workspace: the injected <workspace> prompt (file-tool + TASKS guidance).
//   - memory: structured memory, the memory_save tool, memory/MEMORY.md index
//     loading, and the <memory> prompt.
export interface WorkspaceHarnessConfig {
  workspace?: { enabled?: boolean };
  memory?: { enabled?: boolean };
}

export interface WorkspaceConfigRecord {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  config: WorkspaceConfig;
  createdAt: string;
  updatedAt: string;
}

/** Whether the <workspace> guidance prompt is injected for a workspace (default: on). */
export function workspaceGuidanceEnabled(
  config: WorkspaceConfig | undefined,
): boolean {
  return config?.harness?.workspace?.enabled !== false;
}

/** Whether the structured memory harness is on for a workspace (default: on). */
export function workspaceMemoryHarnessEnabled(
  config: WorkspaceConfig | undefined,
): boolean {
  return config?.harness?.memory?.enabled !== false;
}

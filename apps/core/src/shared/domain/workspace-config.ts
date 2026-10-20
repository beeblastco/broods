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
  WorkspaceConfig,
  WorkspaceStorageConfig as StoredWorkspaceStorageConfig,
} from "@broods/convex/model/workspaceRules";

export type { WorkspaceIsolation } from "@broods/convex/model/workspaceIsolation";
export type { WorkspaceConfig } from "@broods/convex/model/workspaceRules";

/**
 * Workspace storage as core carries it. An R2 or assumeRole bucket also
 * carries its row's identity, which a mount sends to Convex to mint scoped R2
 * credentials or fetch the account's external id; it is stamped on load
 * (shared/convex/storage.ts), never stored or accepted.
 */
export type WorkspaceStorageConfig = StoredWorkspaceStorageConfig & {
  owner?: { accountId: string; workspaceId: string };
};

/** A loaded workspace config, whose storage may carry its owner. */
export type WorkspaceRuntimeConfig = Omit<WorkspaceConfig, "storage"> & {
  storage: WorkspaceStorageConfig;
};

export interface WorkspaceConfigRecord {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  config: WorkspaceRuntimeConfig;
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

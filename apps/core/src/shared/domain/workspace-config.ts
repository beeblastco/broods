import type {
  WorkspaceConfig,
  WorkspaceStorageConfig as StoredWorkspaceStorageConfig,
} from "@broods/convex/model/workspaceRules";

export type { WorkspaceIsolation } from "@broods/convex/model/workspaceIsolation";
export type { WorkspaceConfig } from "@broods/convex/model/workspaceRules";

// `owner` is stamped on load (shared/convex/storage.ts), never stored or accepted: a mount sends
// it to Convex to mint scoped R2 credentials or fetch the account's external id.
export type WorkspaceStorageConfig = StoredWorkspaceStorageConfig & {
  owner?: { accountId: string; workspaceId: string };
};

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

export function workspaceGuidanceEnabled(
  config: WorkspaceConfig | undefined,
): boolean {
  return config?.harness?.workspace?.enabled !== false;
}

// Memory loads into each prompt from S3; a disk workspace has none to load it from.
export function workspaceMemoryHarnessEnabled(
  config: WorkspaceConfig | undefined,
): boolean {
  return (
    config?.storage?.provider !== "disk" &&
    config?.harness?.memory?.enabled !== false
  );
}

/**
 * Workspace config: account-scoped, reusable workspace definitions referenced by
 * agents via `config.workspaces[].workspaceId`. A workspace is the persistent
 * S3-backed filesystem mounted into a sandbox; agents referencing the same
 * workspaceId share the same files. Holds no secrets, so it is stored in
 * plaintext (unlike sandbox config). Validation and the public projection live
 * in the config plane (packages/convex/model/workspaceRules.ts); this file
 * keeps the runtime record contract and the harness feature toggles.
 */

import type { WorkspaceConfig } from "@broods/convex/model/workspaceRules";

export type {
  WorkspaceConfig,
  WorkspaceStorageAuth,
  WorkspaceStorageConfig,
  WorkspaceStorageProvider,
} from "@broods/convex/model/workspaceRules";

// The workspace harness is a set of named features, each with its own options
// and each defaulting to on. There is deliberately no top-level enabled flag:
// new capabilities get their own key here for independent control.
//   - workspace: the injected <workspace> prompt (file-tool + TASKS guidance).
//   - memory: structured memory — the memory_save tool, memory/MEMORY.md index
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

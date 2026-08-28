/**
 * Sandbox config: account-scoped, reusable sandbox definitions referenced by
 * agents via `config.sandbox`. A sandbox is a collection of Claude-Code-style
 * tools (bash/read/write/edit/glob/grep) backed by a provider. Validation and
 * the public projection live in the config plane
 * (packages/convex/model/sandboxRules.ts); this file keeps the runtime record
 * contract and re-exports the shared types under core's names.
 * Stored encrypted at rest because `envVars`/`options` may hold secrets.
 */

import type { SandboxConfig } from "@broods/convex/model/sandboxRules";

export type {
  NetworkMode as SandboxNetworkMode,
  PermissionMode as SandboxPermissionMode,
  RuntimeName as SandboxRuntimeName,
  SandboxConfig,
  SandboxLifecycleConfig,
  SandboxNetworkConfig,
  SandboxProvider,
} from "@broods/convex/model/sandboxRules";

export interface SandboxConfigRecord {
  accountId: string;
  sandboxId: string;
  projectId?: string;
  stageId?: string;
  name: string;
  description?: string;
  config: SandboxConfig;
  createdAt: string;
  updatedAt: string;
}

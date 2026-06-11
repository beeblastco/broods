/**
 * Storage factory. Reads STORAGE_PROVIDER from env (default "dynamodb")
 * and lazily loads the matching provider so the unused provider's deps
 * are not pulled into the Lambda bundle / runtime.
 */

import { optionalEnv } from "../env.ts";
import type { StorageProvider } from "./types.ts";

let cached: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (cached) return cached;
  const provider = (optionalEnv("STORAGE_PROVIDER") ?? "dynamodb").toLowerCase();

  if (provider === "convex") {
    // The Convex adapter lives in a private submodule mounted at ./convex.
    // SaaS builds init the submodule so Bun bundles the real adapter.
    // Community / OSS builds get a stub written by scripts/build.ts that
    // exports a null provider — the check below throws a clear error if
    // STORAGE_PROVIDER=convex is set on such a build.
    const { convexStorageProvider } = require("./convex/index.ts");
    if (!convexStorageProvider) {
      throw new Error(
        "STORAGE_PROVIDER=convex requires the filthy-panty-convex-adapter submodule. " +
          "Run `git submodule update --init --recursive` (SaaS deployments only).",
      );
    }
    cached = convexStorageProvider as StorageProvider;
  } else if (provider === "dynamodb" || provider === "dynamo") {
    const { dynamoStorageProvider } = require("./dynamo/index.ts");
    cached = dynamoStorageProvider as StorageProvider;
  } else {
    throw new Error(`Unknown STORAGE_PROVIDER: ${provider}`);
  }

  return cached!;
}

/** Reset the cached provider. Tests only. */
export function resetStorageForTests(): void {
  cached = null;
}

/** Inject a provider for tests. Pass null to restore env-based loading. */
export function setStorageForTests(provider: StorageProvider | null): void {
  cached = provider;
}

export type { StorageProvider } from "./types.ts";
export { getDedupeStore } from "./dedupe.ts";
export {
  applyCronJobPatch,
  isCronJobsConfigured,
  type CronJobRecord,
  type CronJobStatus,
  type CronJobLastStatus,
  type CreateCronJobInput,
  type UpdateCronJobInput,
} from "./cron-jobs.ts";
export {
  AgentSkillAuthorizationError,
  AgentSkillNotFoundError,
  AgentSubagentNotFoundError,
  toPublicAgent,
  validateAgentSkillPaths,
  validateAgentSubagentIds,
  type AgentRecord,
  type AgentStatus,
  type CreateAgentInput,
  type UpdateAgentInput,
  type PublicAgentRecord,
} from "./agents.ts";
export {
  createAccountId,
  createAccountSecret,
  hashAccountSecret,
  normalizeCreateAccountInput,
  normalizeUpdateAccountInput,
  toPublicAccount,
  type AccountRecord,
  type AccountStatus,
  type CreateAccountInput,
  type UpdateAccountInput,
  type PublicAccountRecord,
} from "./accounts.ts";
export {
  decodeStoredAgentConfig,
  decodeStoredConfigObject,
  encryptAgentConfig,
  encryptConfigObject,
  mergeAgentConfig,
  mergeConfigObjects,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  redactAgentConfig,
  redactConfigSecrets,
  toChannelRuntimeAgentConfig,
  toRuntimeAgentConfig,
  type AgentConfig,
  type AgentBehaviorConfig,
  type AgentChannelsConfig,
  type AgentDiscordChannelConfig,
  type AgentGitHubChannelConfig,
  type AgentHooksConfig,
  type AgentLifecycleEventName,
  type AgentModelConfig,
  type AgentModelOutputConfig,
  type AgentPancakeChannelConfig,
  type AgentProviderConfig,
  type AgentProviderSettings,
  type AgentSessionConfig,
  type AgentSessionCompactionConfig,
  type AgentSessionPruningConfig,
  type AgentSkillsConfig,
  type AgentSlackChannelConfig,
  type AgentSubagentConfig,
  type AgentTelegramChannelConfig,
  type AgentToolConfig,
  type AgentToolsConfig,
  type AgentWebhookHookConfig,
  type AgentWorkspaceRef,
  type AccountModelProviderName,
} from "./agent-config.ts";
export {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  toPublicSandboxConfig,
  type SandboxConfig,
  type SandboxConfigRecord,
  type SandboxPermissionMode,
  type SandboxProvider,
  type SandboxRuntimeName,
  type CreateSandboxConfigInput,
  type UpdateSandboxConfigInput,
} from "./sandbox-config.ts";
export {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  toPublicWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceConfigRecord,
  type CreateWorkspaceConfigInput,
  type UpdateWorkspaceConfigInput,
} from "./workspace-config.ts";
export {
  accountToolBundleStorageKey,
  normalizeAccountToolUpload,
  normalizeCreateAccountToolInput,
  normalizeUpdateAccountToolInput,
  toPublicAccountTool,
  type AccountToolRecord,
  type AccountToolStatus,
  type AccountToolUploadInput,
  type CreateAccountToolInput,
  type NormalizedAccountToolUpload,
  type PublicAccountToolRecord,
  type UpdateAccountToolInput,
} from "./account-tools.ts";

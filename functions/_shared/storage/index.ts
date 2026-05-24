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
    // Community / open-source builds don't init the submodule, so the path
    // is computed at runtime to defeat Bun's static bundler analysis.
    // SaaS builds init the submodule before bundling, at which point the
    // resolved path is present on disk.
    const convexPath = "./convex/index.ts";
    try {
      const mod = require(convexPath);
      cached = mod.convexStorageProvider as StorageProvider;
    } catch (err) {
      throw new Error(
        "STORAGE_PROVIDER=convex requires the filthy-panty-convex-adapter submodule. " +
          "Run `git submodule update --init --recursive` (SaaS deployments only).",
      );
    }
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
  encryptAgentConfig,
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  redactAgentConfig,
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
  type AgentWorkspaceConfig,
  type AgentWorkspaceMemoryConfig,
  type AgentWorkspaceSandboxConfig,
  type AgentWorkspaceToolConfig,
  type AccountModelProviderName,
} from "./agent-config.ts";

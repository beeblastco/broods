/**
 * Storage factory. Runtime and config persistence share the Convex backend.
 */

import type { StorageProvider } from "./types.ts";

let cached: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (cached) return cached;
  const { storageProvider } = require("./provider.ts");
  cached = storageProvider as StorageProvider;

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

export type { StorageProvider, UsageTaskInput, UsageStore } from "./types.ts";
export { getDedupeStore } from "./dedupe.ts";
export {
  applyCronPatch,
  isCronsConfigured,
  type CronRecord,
  type CronRunRecord,
  type CronStatus,
  type CronLastStatus,
  type CreateCronInput,
  type UpdateCronInput,
} from "./cron.ts";
export {
  AgentSkillAuthorizationError,
  AgentSkillNotFoundError,
  AgentPolicyNotFoundError,
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
  applyRunOverrides,
  RUN_OVERRIDE_RESERVED_MODEL_KEYS,
  MODEL_CONFIG_SETTING_KEYS,
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
  type AgentChannelWorkspaceScope,
  type AgentChannelsConfig,
  type AgentDiscordChannelConfig,
  type AgentGitHubChannelConfig,
  type AgentHooksConfig,
  type AgentLifecycleEventName,
  type AgentModelConfig,
  type AgentModelOutputConfig,
  type AgentModelProviderOptions,
  type AgentPancakeChannelConfig,
  type AgentProviderConfig,
  type AgentProviderSettings,
  type RunOverrides,
  type AgentSessionConfig,
  type AgentSessionCompactionConfig,
  type AgentSessionPruningConfig,
  type AgentSkillsConfig,
  type AgentSlackChannelConfig,
  type AgentSubagentConfig,
  type AgentTelegramChannelConfig,
  type AgentZaloChannelConfig,
  type AgentToolConfig,
  type AgentToolsConfig,
  type AgentWebhookHookConfig,
  type AgentWorkspaceRef,
  type AccountModelProviderName,
} from "./agent-config.ts";
export {
  AGENT_POLICY_ACTIONS,
  normalizeAgentPolicyDocument,
  normalizeCreateAgentPolicyInput,
  normalizeUpdateAgentPolicyInput,
  type AgentPolicyAction,
  type AgentPolicyConfig,
  type AgentPolicyCondition,
  type AgentPolicyDocument,
  type AgentPolicyEffect,
  type AgentPolicyMode,
  type AgentPolicyRecord,
  type AgentPolicyResourceSelector,
  type AgentPolicyRule,
  type CreateAgentPolicyInput,
  type PolicyDecision,
  type PolicyDecisionInput,
  type UpdateAgentPolicyInput,
} from "./agent-policy.ts";
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
  inferAccountToolRuntime,
  type AccountToolRecord,
  type AccountToolRuntime,
  type AccountToolStatus,
  type AccountToolUploadInput,
  type CreateAccountToolInput,
  type NormalizedAccountToolUpload,
  type PublicAccountToolRecord,
  type UpdateAccountToolInput,
} from "./account-tools.ts";
export {
  accountHookBundleStorageKey,
  normalizeAccountHookUpload,
  normalizeCreateAccountHookInput,
  normalizeUpdateAccountHookInput,
  toPublicAccountHook,
  type AccountHookRecord,
  type AccountHookStatus,
  type AccountHookUploadInput,
  type CreateAccountHookInput,
  type NormalizedAccountHookUpload,
  type PublicAccountHookRecord,
  type UpdateAccountHookInput,
} from "./account-hooks.ts";

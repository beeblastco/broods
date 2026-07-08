/**
 * Type contracts inherited from Convex and core storage/runtime modules.
 * Keep this file type-only so the public SDK does not bundle backend code.
 */

import type {
  AgentConfig,
  AgentCodeHookConfig,
  AgentHookEventName,
  AgentHooksConfig,
  AgentChannelWorkspaceScope,
  AgentChannelsConfig,
  AgentWebhookHookConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTelegramChannelConfig,
  AgentZaloChannelConfig,
  AgentWorkspaceRef,
} from "../../../apps/core/src/shared/storage/agent-config.ts";
import type {
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  UpdateCronInput,
} from "../../../apps/core/src/shared/storage/cron.ts";
import type {
  SandboxConfig,
} from "../../../apps/core/src/shared/storage/sandbox-config.ts";
import type {
  WorkspaceConfig,
} from "../../../apps/core/src/shared/storage/workspace-config.ts";
import type {
  AgentPolicyConfig,
  AgentPolicyDocument,
} from "../../../apps/core/src/shared/storage/agent-policy.ts";

// Per-channel inbound `source` shapes, inherited from the channel adapters so
// the SDK hook typings cannot drift from what core actually emits.
export type { TelegramSource } from "../../../apps/core/src/shared/telegram-channel.ts";
export type { GitHubSource } from "../../../apps/core/src/shared/github-channel.ts";
export type { SlackSource } from "../../../apps/core/src/shared/slack-channel.ts";
export type { DiscordSource } from "../../../apps/core/src/shared/discord-channel.ts";
export type { PancakeSource } from "../../../apps/core/src/shared/pancake-channel.ts";
export type { ZaloSource } from "../../../apps/core/src/shared/zalo-channel.ts";

export type Id<TableName extends string = string> = string & { readonly __tableName?: TableName };
export type Doc<TableName extends string = string> = Record<string, unknown> & { readonly _id: Id<TableName> };

export type {
  AgentConfig,
  AgentCodeHookConfig,
  AgentHookEventName,
  AgentHooksConfig,
  AgentChannelWorkspaceScope,
  AgentChannelsConfig,
  AgentWebhookHookConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTelegramChannelConfig,
  AgentZaloChannelConfig,
  AgentWorkspaceRef,
  AgentPolicyConfig,
  AgentPolicyDocument,
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  SandboxConfig,
  UpdateCronInput,
  WorkspaceConfig,
};

export type ProjectDoc = Doc<"projects">;
export type EnvironmentDoc = Doc<"environments">;
export type AgentConfigDoc = Doc<"agentConfigs">;
export type WorkspaceConfigDoc = Doc<"workspaceConfigs">;
export type SandboxConfigDoc = Doc<"sandboxConfigs">;
export type CronDoc = Doc<"crons">;

export type CliResourceKind = "agent" | "workspace" | "sandbox" | "cron" | "skill" | "tool" | "policy";

// Manifest wire types come from the backend's canonical leaf module so the
// CLI/SDK can't silently drift from the server contract.
export type { CliManifest, CliManifestResource, GeneratedIds } from "../../convex/cliTypes.ts";

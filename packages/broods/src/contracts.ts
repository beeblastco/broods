/**
 * Type contracts inherited from Convex and core domain/runtime modules.
 * Keep this file type-only so the public SDK does not bundle backend code.
 */

import type {
  AgentConfig,
  HookAgentConfig,
  AgentCodeHookConfig,
  AgentHookEventName,
  AgentHooksConfig,
  ChannelPartition,
  AgentChannelsConfig,
  AgentWebhookHookConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentGoogleChatChannelConfig,
  AgentInstagramChannelConfig,
  AgentLinearChannelConfig,
  AgentMatrixChannelConfig,
  AgentMessengerChannelConfig,
  AgentNotionChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTeamsChannelConfig,
  AgentTelegramChannelConfig,
  AgentTwilioChannelConfig,
  AgentWhatsAppChannelConfig,
  AgentZaloChannelConfig,
  AgentProviderSettings,
  AgentWorkspaceRef,
} from "../../../apps/core/src/shared/domain/agent-config.ts";
import type {
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  UpdateCronInput,
} from "../../../apps/core/src/shared/domain/cron.ts";
import type {
  SandboxConfig,
  SandboxExecRequest,
  SandboxExecResponse,
  SandboxProvider,
} from "../../../apps/core/src/shared/domain/sandbox-config.ts";
import type {
  WorkspaceConfig,
  WorkspaceIsolation,
} from "../../../apps/core/src/shared/domain/workspace-config.ts";
import type { PolicyDocument } from "../../../apps/core/src/shared/domain/policy.ts";
import type { ChannelReplyIn } from "../../../apps/core/src/shared/domain/channel-record.ts";

// Per-channel inbound `source` shapes, inherited from the channel adapters so
// the SDK hook typings cannot drift from what core actually emits.
export type { TelegramSource } from "../../../apps/core/src/shared/telegram-channel.ts";
export type { GoogleChatSource } from "../../../apps/core/src/shared/gchat-channel.ts";
export type { GitHubSource } from "../../../apps/core/src/shared/github-channel.ts";
export type { LinearSource } from "../../../apps/core/src/shared/linear-channel.ts";
export type { NotionSource } from "../../../apps/core/src/shared/notion-channel.ts";
export type { SlackSource } from "../../../apps/core/src/shared/slack-channel.ts";
export type { DiscordSource } from "../../../apps/core/src/shared/discord-channel.ts";
export type { MatrixSource } from "../../../apps/core/src/shared/matrix-channel.ts";
export type { PancakeSource } from "../../../apps/core/src/shared/pancake-channel.ts";
export type { TeamsSource } from "../../../apps/core/src/shared/teams-channel.ts";
export type { TwilioSource } from "../../../apps/core/src/shared/twilio-channel.ts";
export type { WhatsAppSource } from "../../../apps/core/src/shared/whatsapp-channel.ts";
export type { ZaloSource } from "../../../apps/core/src/shared/zalo-channel.ts";
export type { InstagramSource } from "../../../apps/core/src/shared/instagram-channel.ts";
export type { MessengerSource } from "../../../apps/core/src/shared/messenger-channel.ts";

export type Id<TableName extends string = string> = string & {
  readonly __tableName?: TableName;
};
export type Doc<TableName extends string = string> = Record<string, unknown> & {
  readonly _id: Id<TableName>;
};

export type {
  AgentConfig,
  HookAgentConfig,
  AgentCodeHookConfig,
  AgentHookEventName,
  AgentHooksConfig,
  ChannelPartition,
  AgentChannelsConfig,
  AgentWebhookHookConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentGoogleChatChannelConfig,
  AgentInstagramChannelConfig,
  AgentLinearChannelConfig,
  AgentMatrixChannelConfig,
  AgentMessengerChannelConfig,
  AgentNotionChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTeamsChannelConfig,
  AgentTelegramChannelConfig,
  AgentTwilioChannelConfig,
  AgentWhatsAppChannelConfig,
  AgentZaloChannelConfig,
  AgentProviderSettings,
  AgentWorkspaceRef,
  ChannelReplyIn,
  PolicyDocument,
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  SandboxConfig,
  UpdateCronInput,
  WorkspaceConfig,
  WorkspaceIsolation,
};

// The sandbox exec contract. `SandboxProvider` is every `config.provider` a
// sandbox accepts; the exec pair is what a `custom` provider's server speaks:
// `POST <endpoint>/exec` takes a `SandboxExecRequest` and answers a
// `SandboxExecResponse`.
export type { SandboxExecRequest, SandboxExecResponse, SandboxProvider };

export type ProjectDoc = Doc<"projects">;
export type StageDoc = Doc<"stages">;
export type AgentConfigDoc = Doc<"agentConfigs">;
export type WorkspaceConfigDoc = Doc<"workspaceConfigs">;
export type SandboxConfigDoc = Doc<"sandboxConfigs">;
export type CronDoc = Doc<"crons">;

// Manifest wire types come from the backend's canonical leaf module so the
// CLI/SDK can't silently drift from the server contract.
export type {
  CliManifest,
  CliManifestResource,
  GeneratedIds,
} from "../../convex/cli/types.ts";

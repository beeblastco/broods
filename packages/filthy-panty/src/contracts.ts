/**
 * Type contracts inherited from Convex and core storage/runtime modules.
 * Keep this file type-only so the public SDK does not bundle backend code.
 */

import type { Doc, Id } from "../../convex/_generated/dataModel";
import type {
  AgentConfig,
  AgentChannelsConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTelegramChannelConfig,
  AgentZaloChannelConfig,
  AgentWorkspaceRef,
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  SandboxConfig,
  UpdateCronInput,
  WorkspaceConfig,
} from "../../../apps/core/functions/_shared/storage/index.ts";

export type {
  AgentConfig,
  AgentChannelsConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentPancakeChannelConfig,
  AgentSlackChannelConfig,
  AgentTelegramChannelConfig,
  AgentZaloChannelConfig,
  AgentWorkspaceRef,
  CreateCronInput,
  CronLastStatus,
  CronStatus,
  Doc,
  Id,
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

export type CliResourceKind = "agent" | "workspace" | "sandbox" | "cron";

// Manifest wire types come from the backend's canonical leaf module so the
// CLI/SDK can't silently drift from the server contract.
export type { CliManifest, CliManifestResource, GeneratedIds } from "../../convex/cliTypes.ts";

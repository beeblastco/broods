import type { DiscordAdapterConfig } from "@chat-adapter/discord";
import type { GoogleChatAdapterBaseConfig } from "@chat-adapter/gchat";
import type { GitHubAdapterConfig } from "@chat-adapter/github";
import type { InstagramAdapterConfig } from "@chat-adapter/instagram";
import type { LinearAdapterAPIKeyConfig } from "@chat-adapter/linear";
import type { MessengerAdapterConfig } from "@chat-adapter/messenger";
import type { SlackAdapterConfig } from "@chat-adapter/slack";
import type { TeamsAdapterConfig } from "@chat-adapter/teams";
import type { TelegramAdapterConfig } from "@chat-adapter/telegram";
import type { TwilioAdapterConfig } from "@chat-adapter/twilio";
import type { WhatsAppAdapterConfig } from "@chat-adapter/whatsapp";
import type {
  JSONSchema7,
  LanguageModelCallOptions,
  RequestOptions,
  SystemModelMessage,
  streamText,
} from "ai";
import type { AgentHookEventName } from "@broods/convex/model/accountHooks";
import {
  normalizeAgentConfig,
  type AGENT_HARNESS_DEBUG_LEVELS,
  type AGENT_HARNESS_PERMISSION_MODES,
  type AGENT_HARNESS_TYPES,
  type AGENT_LIFECYCLE_EVENT_NAMES,
} from "@broods/convex/model/agentRules";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import type { McpOauth } from "./mcp.ts";
export type { AccountModelProviderName } from "@broods/convex/model/modelProviders";

export const AGENT_MAX_TURN_UNLIMITED = 0;
export const RUN_OVERRIDE_RESERVED_MODEL_KEYS = [
  "provider",
  "modelId",
  "output",
  "apiKey",
] as const;
// `sandbox` and `policy` are retired keys, kept so the normalizer refuses them by name.
const RUNTIME_CONFIG_KEYS = [
  "agent",
  "harness",
  "model",
  "policy",
  "provider",
  "sandbox",
  "sandboxes",
  "workspaces",
  "session",
  "hooks",
  "tools",
  "mcp",
  "denyTools",
  "skills",
  "subagent",
  "scheduler",
  "browser",
  "policies",
  "publicAccess",
  "allowRunOverrides",
] as const;

export interface AgentConfig {
  agent?: AgentBehaviorConfig;
  harness?: AgentHarnessConfig;
  model?: AgentModelConfig;
  provider?: AgentProviderConfig;
  /** Sandbox record ids. The first is the default for bash, workspaces and a harness. */
  sandboxes?: string[];
  workspaces?: AgentWorkspaceRef[];
  session?: AgentSessionConfig;
  hooks?: AgentHooksConfig;
  channels?: AgentChannelsConfig;
  tools?: AgentToolsConfig;
  mcp?: AgentMcpConfig;
  /** Withheld after the tool set is built; a channel can take a tool away, never add one. */
  denyTools?: string[];
  skills?: AgentSkillsConfig;
  subagent?: AgentSubagentConfig;
  scheduler?: AgentSchedulerConfig;
  /** `browse` runs on the first sandbox: a machine, or lambda "obscura" with allow-all. */
  browser?: { enabled?: boolean };
  policies?: string[];
  /** Opens the runtime-key path; account keys, cron and channel webhooks never need it. */
  publicAccess?: boolean;
  allowRunOverrides?: boolean;
  [key: string]: unknown;
}

// An allow-list, so no credential field can reach hook code.
export interface HookAgentConfig {
  readonly model: {
    readonly provider?: AccountModelProviderName;
    readonly modelId?: string;
  };
  readonly harness?: AgentHarnessConfig["type"];
  readonly maxTurn?: number;
  readonly tools: readonly string[];
  readonly mcp: readonly string[];
  readonly channels: readonly string[];
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
  readonly denyTools: readonly string[];
}

export interface AgentBehaviorConfig {
  /** Steps per turn. 0 lifts the cap; unset is the harness default. */
  maxTurn?: number;
  system?: string | SystemModelMessage | SystemModelMessage[];
  [key: string]: unknown;
}

export interface AgentHarnessConfig {
  activeTools?: string[];
  debug?: AgentHarnessDebugConfig;
  inactiveTools?: string[];
  type: (typeof AGENT_HARNESS_TYPES)[number];
  permissionMode?: (typeof AGENT_HARNESS_PERMISSION_MODES)[number];
  startupTimeoutMs?: number;
  webSearch?: boolean;
}

export interface AgentHarnessDebugConfig {
  enabled?: boolean;
  level?: (typeof AGENT_HARNESS_DEBUG_LEVELS)[number];
  subsystems?: string[];
}

export interface RunOverrides {
  system?: SystemModelMessage[];
  model?: Partial<AgentModelConfig>;
}

type StreamTextOptions = Parameters<typeof streamText>[0];
export type AgentModelProviderOptions = StreamTextOptions["providerOptions"];

export interface AgentSkillsConfig {
  enabled?: boolean;
  allowed?: string[];
  [key: string]: unknown;
}

export interface AgentSchedulerConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AgentSubagentConfig {
  enabled?: boolean;
  allowed?: string[];
  context?: "new" | "inherited";
  mode?: "ephemeral" | "persistent";
  stream?: boolean;
  /** What the parent sees of a finished child; default `result`. A code hook can override it. */
  visibility?: "full" | "result" | "none";
  /** Virtual subagents only, merged over the parent's `model`; registered agents use their own. */
  model?: Partial<AgentModelConfig>;
  [key: string]: unknown;
}

export interface AgentModelConfig
  extends
    LanguageModelCallOptions,
    // Partial: when `ai` does not resolve, `Pick<any, K>` would make both keys required.
    Partial<Pick<RequestOptions, "maxRetries" | "timeout">> {
  provider?: AccountModelProviderName;
  modelId?: string;
  transcriptionModelId?: string;
  providerOptions?: AgentModelProviderOptions;
  output?: AgentModelOutputConfig;
}

export type AgentModelOutputConfig =
  | ({ type: "text" } & AgentModelOutputMetadata)
  | ({ type: "object"; schema: JSONSchema7 } & AgentModelOutputMetadata)
  | ({ type: "array"; element: JSONSchema7 } & AgentModelOutputMetadata)
  | ({ type: "choice"; options: string[] } & AgentModelOutputMetadata)
  | ({ type: "json" } & AgentModelOutputMetadata);

type AgentModelOutputMetadata = {
  name?: string;
  description?: string;
  [key: string]: unknown;
};

export type AgentProviderConfig = Partial<
  Record<AccountModelProviderName, AgentProviderSettings>
>;

export interface AgentProviderSettings {
  apiKey?: string;
  // `custom` endpoint, in the documented snake form and the AI SDK form; the dashboard writes both.
  base_url?: string;
  baseURL?: string;
  gatewayId?: string;
  headers?: Record<string, string>;
  name?: string;
  organization?: string;
  project?: string;
  [key: string]: unknown;
}

export interface AgentWorkspaceRef {
  name: string;
  workspaceId: string;
  /** Unset inherits the default; `null` is read-only, read from S3 without a mount. */
  sandbox?: string | null;
}

export interface AgentSessionConfig {
  pruning?: AgentSessionPruningConfig;
  autoCompaction?: AgentSessionAutoCompactionConfig;
  [key: string]: unknown;
}

export interface AgentSessionPruningConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

/** On by default: runs once a turn's last call read `maxContextLength` (500000) tokens. */
export interface AgentSessionAutoCompactionConfig {
  enabled?: boolean;
  maxContextLength?: number;
  [key: string]: unknown;
}

export interface AgentHooksConfig {
  webhooks?: AgentWebhookHookConfig[];
  code?: AgentCodeHookConfig[];
  [key: string]: unknown;
}

export interface AgentCodeHookConfig {
  hookId: string;
  events?: AgentHookEventName[];
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AgentWebhookHookConfig {
  enabled?: boolean;
  url?: string;
  secret?: string;
  events?: AgentLifecycleEventName[];
  [key: string]: unknown;
}

export type AgentLifecycleEventName =
  (typeof AGENT_LIFECYCLE_EVENT_NAMES)[number];

export type { AgentHookEventName };

export type AgentToolsConfig = Record<string, AgentToolConfig>;

export interface AgentToolConfig {
  enabled?: boolean;
  needsApproval?: boolean;
  async?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export type AgentMcpConfig = Record<string, AgentMcpEntry>;

export interface AgentMcpEntry {
  enabled?: boolean;
  needsApproval?: boolean;
  headers?: Record<string, string>;
  // `tokenUrl` stays on the row, where registration checked it.
  oauth?: Partial<Omit<McpOauth, "tokenUrl">>;
  [key: string]: unknown;
}

export interface AgentChannelsConfig {
  telegram?: AgentTelegramChannelConfig;
  gchat?: AgentGoogleChatChannelConfig;
  github?: AgentGitHubChannelConfig;
  linear?: AgentLinearChannelConfig;
  slack?: AgentSlackChannelConfig;
  discord?: AgentDiscordChannelConfig;
  pancake?: AgentPancakeChannelConfig;
  teams?: AgentTeamsChannelConfig;
  twilio?: AgentTwilioChannelConfig;
  zalo?: AgentZaloChannelConfig;
  matrix?: AgentMatrixChannelConfig;
  instagram?: AgentInstagramChannelConfig;
  messenger?: AgentMessengerChannelConfig;
  whatsapp?: AgentWhatsAppChannelConfig;
  [key: string]: unknown;
}

export type ChannelPartition =
  | { by: "shared"; alias?: never }
  | { by: "conversation"; alias: string };

// Credential fields are spelled out so the published SDK types resolve without the adapter
// packages; ChannelCredentialDrift fails the build when an upstream shape moves.
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type SerializedCredential<T> = Extract<T, string | undefined>;

type AssertAllExact<T extends readonly true[]> = T;

// oxlint-disable-next-line no-unused-vars -- declaring the alias is the check.
type ChannelCredentialDrift = AssertAllExact<
  [
    Exactly<TelegramAdapterConfig["apiUrl"], string | undefined>,
    Exactly<
      SerializedCredential<TelegramAdapterConfig["botToken"]>,
      string | undefined
    >,
    Exactly<TelegramAdapterConfig["secretToken"], string | undefined>,
    Exactly<
      Extract<GitHubAdapterConfig, { appId: string }>["apiUrl"],
      string | undefined
    >,
    Exactly<
      Extract<GitHubAdapterConfig, { appId: string }>["webhookSecret"],
      string | undefined
    >,
    Exactly<Extract<GitHubAdapterConfig, { appId: string }>["appId"], string>,
    Exactly<
      Extract<GitHubAdapterConfig, { appId: string }>["privateKey"],
      string
    >,
    Exactly<LinearAdapterAPIKeyConfig["apiKey"], string>,
    Exactly<LinearAdapterAPIKeyConfig["apiUrl"], string | undefined>,
    Exactly<LinearAdapterAPIKeyConfig["userName"], string | undefined>,
    Exactly<LinearAdapterAPIKeyConfig["webhookSecret"], string | undefined>,
    Exactly<SlackAdapterConfig["apiUrl"], string | undefined>,
    Exactly<SlackAdapterConfig["signingSecret"], string | undefined>,
    Exactly<DiscordAdapterConfig["apiUrl"], string | undefined>,
    Exactly<
      SerializedCredential<DiscordAdapterConfig["botToken"]>,
      string | undefined
    >,
    Exactly<DiscordAdapterConfig["publicKey"], string | undefined>,
    Exactly<GoogleChatAdapterBaseConfig["endpointUrl"], string | undefined>,
    Exactly<
      GoogleChatAdapterBaseConfig["googleChatProjectNumber"],
      string | undefined
    >,
    Exactly<GoogleChatAdapterBaseConfig["userName"], string | undefined>,
    Exactly<
      GoogleChatAdapterBaseConfig["workspaceAddOnServiceAccountEmail"],
      string | undefined
    >,
    Exactly<TeamsAdapterConfig["apiUrl"], string | undefined>,
    Exactly<
      SerializedCredential<TeamsAdapterConfig["appId"]>,
      string | undefined
    >,
    Exactly<TeamsAdapterConfig["appPassword"], string | undefined>,
    Exactly<TeamsAdapterConfig["appTenantId"], string | undefined>,
    Exactly<
      TeamsAdapterConfig["appType"],
      "MultiTenant" | "SingleTenant" | undefined
    >,
    Exactly<TeamsAdapterConfig["userName"], string | undefined>,
    Exactly<
      SerializedCredential<TwilioAdapterConfig["accountSid"]>,
      string | undefined
    >,
    Exactly<TwilioAdapterConfig["apiUrl"], string | undefined>,
    Exactly<
      SerializedCredential<TwilioAdapterConfig["authToken"]>,
      string | undefined
    >,
    Exactly<TwilioAdapterConfig["messagingServiceSid"], string | undefined>,
    Exactly<TwilioAdapterConfig["phoneNumber"], string | undefined>,
    Exactly<TwilioAdapterConfig["statusCallbackUrl"], string | undefined>,
    Exactly<TwilioAdapterConfig["userName"], string | undefined>,
    Exactly<
      SerializedCredential<TwilioAdapterConfig["webhookUrl"]>,
      string | undefined
    >,
    Exactly<WhatsAppAdapterConfig["accessToken"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["apiUrl"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["apiVersion"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["appSecret"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["phoneNumberId"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["userName"], string | undefined>,
    Exactly<WhatsAppAdapterConfig["verifyToken"], string | undefined>,
    Exactly<InstagramAdapterConfig["accessToken"], string | undefined>,
    Exactly<InstagramAdapterConfig["accountId"], string | undefined>,
    Exactly<InstagramAdapterConfig["apiVersion"], string | undefined>,
    Exactly<InstagramAdapterConfig["appSecret"], string | undefined>,
    Exactly<InstagramAdapterConfig["userName"], string | undefined>,
    Exactly<InstagramAdapterConfig["verifyToken"], string | undefined>,
    Exactly<MessengerAdapterConfig["apiVersion"], string | undefined>,
    Exactly<MessengerAdapterConfig["appSecret"], string | undefined>,
    Exactly<MessengerAdapterConfig["pageAccessToken"], string | undefined>,
    Exactly<MessengerAdapterConfig["userName"], string | undefined>,
    Exactly<MessengerAdapterConfig["verifyToken"], string | undefined>,
  ]
>;

export interface AgentTelegramChannelConfig {
  id?: string;
  apiUrl?: string;
  botToken?: string;
  webhookSecret?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  botUsername?: string;
  reactionEmoji?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentGitHubChannelConfig {
  id?: string;
  apiUrl?: string;
  webhookSecret?: string;
  appId?: string;
  privateKey?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  botUserName?: string;
  botUserId?: number;
  // Both default to true; the bot still answers when assigned.
  triggerOnIssueOpen?: boolean;
  triggerOnPROpen?: boolean;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentLinearChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  apiKey?: string;
  apiUrl?: string;
  userName?: string;
  webhookSecret?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentSlackChannelConfig {
  id?: string;
  apiUrl?: string;
  botToken?: string;
  signingSecret?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  reactionEmoji?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentDiscordChannelConfig {
  id?: string;
  apiUrl?: string;
  botToken?: string;
  publicKey?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  botUserId?: string;
  mentionRoleIds?: string[];
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

/**
 * Matrix has no bots, so this is often a person's own account: `botName` labels replies and
 * `mentionText` addresses the agent, as a mention of the account also names its owner.
 */
export interface AgentMatrixChannelConfig {
  id?: string;
  apiUrl?: string;
  botToken?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  botName?: string;
  mentionText?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentPancakeChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  pageId?: string;
  pageAccessToken?: string;
  webhookSecret?: string;
  senderId?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentZaloChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  botToken?: string;
  webhookSecret?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentInstagramChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  accessToken?: string;
  accountId?: string;
  apiVersion?: string;
  appSecret?: string;
  userName?: string;
  verifyToken?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentMessengerChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  apiVersion?: string;
  appSecret?: string;
  pageAccessToken?: string;
  userName?: string;
  verifyToken?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

// A webhook's Google-signed token must name `endpointUrl` or the project number as audience.
export interface AgentGoogleChatChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  credentials?: string;
  endpointUrl?: string;
  googleChatProjectNumber?: string;
  workspaceAddOnServiceAccountEmail?: string;
  userName?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentTeamsChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  apiUrl?: string;
  appId?: string;
  appPassword?: string;
  appTenantId?: string;
  appType?: "MultiTenant" | "SingleTenant";
  userName?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentTwilioChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  accountSid?: string;
  apiUrl?: string;
  authToken?: string;
  messagingServiceSid?: string;
  phoneNumber?: string;
  statusCallbackUrl?: string;
  userName?: string;
  /** The URL Twilio calls, when not the broods webhook: its signature covers the exact URL. */
  webhookUrl?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export interface AgentWhatsAppChannelConfig {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  id?: string;
  accessToken?: string;
  apiUrl?: string;
  apiVersion?: string;
  appSecret?: string;
  phoneNumberId?: string;
  userName?: string;
  verifyToken?: string;
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  [key: string]: unknown;
}

export function applyRunOverrides(
  config: AgentConfig,
  overrides?: RunOverrides,
): AgentConfig {
  if (
    !overrides ||
    !(overrides.model && Object.keys(overrides.model).length > 0)
  ) {
    return config;
  }

  return { ...config, model: { ...config.model, ...overrides.model } };
}

export function configuredMaxTurn(config: AgentConfig): number | undefined {
  const maxTurn = config.agent?.maxTurn;

  return maxTurn === AGENT_MAX_TURN_UNLIMITED
    ? Number.MAX_SAFE_INTEGER
    : maxTurn;
}

export function isChannelTraceEnabled(
  config: AgentConfig,
  channelName: string | undefined,
): boolean {
  if (!channelName) return false;
  const channelConfig = config.channels?.[channelName] as
    | { trace?: "enabled" | "disabled" }
    | undefined;

  return channelConfig?.trace === "enabled";
}

export function resolveSubagentMode(
  config: AgentConfig,
): "ephemeral" | "persistent" {
  return config.subagent?.mode === "ephemeral" ? "ephemeral" : "persistent";
}

export function toChannelRuntimeAgentConfig(
  config: AgentConfig,
  channelName: string,
): AgentConfig {
  const runtimeConfig = toRuntimeAgentConfig(config);
  const channelConfig = config.channels?.[channelName];

  if (!channelConfig) {
    return runtimeConfig;
  }

  return {
    ...runtimeConfig,
    channels: config.channels,
  };
}

// Re-checked so a row written before a rule tightened fails by name.
export function toRuntimeAgentConfig(config: AgentConfig): AgentConfig {
  const runtimeBranches = Object.fromEntries(
    RUNTIME_CONFIG_KEYS.filter((key): boolean => config[key] !== undefined).map(
      (key): [string, unknown] => [key, config[key]],
    ),
  );

  return normalizeAgentConfig(runtimeBranches) as AgentConfig;
}

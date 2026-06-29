/**
 * Agent configuration: types for the per-agent settings object, input
 * normalization, encryption helpers, patch-merge, and redaction.
 * Account types and auth live in `./accounts.ts` and `../auth.ts`.
 */

import type { CallSettings, JSONSchema7, SystemModelMessage, streamText } from "ai";
import { systemModelMessageSchema } from "ai";
import type { DiscordAdapterConfig } from "@chat-adapter/discord";
import type { GitHubAdapterConfig } from "@chat-adapter/github";
import type { SlackAdapterConfig } from "@chat-adapter/slack";
import type { TelegramAdapterConfig } from "@chat-adapter/telegram";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requireEnv } from "../env.ts";
import { assertPublicHttpsUrl } from "../http.ts";
import { isPlainObject, isStringRecord } from "../object.ts";
import { isAccountToolId } from "./account-tools.ts";
import {
  accountModelProviderNames,
  isAccountModelProviderName,
  type AccountModelProviderName,
} from "../providers.ts";
export type { AccountModelProviderName } from "../providers.ts";

const CONFIG_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const REDACTED_SECRET_VALUE = "********";
const AGENT_MAX_TURN_LIMIT = 100;
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 500_000;

const AGENT_LIFECYCLE_EVENT_NAMES = [
  "agent.started",
  "agent.step.finished",
  "agent.finished",
  "agent.failed",
  "agent.approval.required",
  "tool.call.started",
  "tool.call.finished",
  "tool.result",
  "subagent.task.started",
  "subagent.task.finished",
] as const satisfies readonly AgentLifecycleEventName[];

export interface AgentConfig {
  agent?: AgentBehaviorConfig;
  model?: AgentModelConfig;
  provider?: AgentProviderConfig;
  // References to standalone, account-scoped sandbox / workspace records. The
  // concrete configs live in their own tables (see sandbox-config.ts /
  // workspace-config.ts) and are resolved by the handler before the agent loop.
  sandbox?: string;
  workspaces?: AgentWorkspaceRef[];
  session?: AgentSessionConfig;
  hooks?: AgentHooksConfig;
  channels?: AgentChannelsConfig;
  tools?: AgentToolsConfig;
  skills?: AgentSkillsConfig;
  subagent?: AgentSubagentConfig;
  // Opt-in flag for the public runtime endpoint (SSE/WebSocket via the
  // environment runtime key). Off by default: when not `true` the deployment
  // (public-key) request path is refused. Internal callers (account/admin
  // secret, cron, async worker) and channel webhooks are never gated by this.
  publicAccess?: boolean;
  [key: string]: unknown;
}

export interface AgentBehaviorConfig {
  maxTurn?: number;
  system?: string | SystemModelMessage | SystemModelMessage[];
  [key: string]: unknown;
}

/**
 * Per-invocation overrides supplied on a single request. They never persist:
 * applyRunOverrides folds them into a copy of the agent config for one run only.
 */
export interface RunOverrides {
  system?: SystemModelMessage[];
  model?: Partial<AgentModelConfig>;
}

// A per-run `model` override may tune sampling (the Vercel AI SDK `CallSettings`:
// temperature, topP, topK, maxOutputTokens, …) and provider-specific
// `providerOptions`. Identity/credential keys are rejected.
export const RUN_OVERRIDE_RESERVED_MODEL_KEYS = [
  "provider",
  "modelId",
  "output",
  "apiKey",
] as const;

type StreamTextOptions = Parameters<typeof streamText>[0];
export type AgentModelProviderOptions = StreamTextOptions["providerOptions"];
export const MODEL_CONFIG_SETTING_KEYS = [
  "provider",
  "modelId",
  "providerOptions",
  "output",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "maxRetries",
  "timeout",
] as const;

export interface AgentSkillsConfig {
  enabled?: boolean;
  allowed?: string[];
  [key: string]: unknown;
}

export interface AgentSubagentConfig {
  enabled?: boolean;
  allowed?: string[];
  context?: "new" | "inherited";
  mode?: "ephemeral" | "persistent";
  [key: string]: unknown;
}

export interface AgentModelConfig extends Omit<CallSettings, "abortSignal" | "headers"> {
  provider?: AccountModelProviderName;
  modelId?: string;
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

export type AgentProviderConfig = Partial<Record<AccountModelProviderName, AgentProviderSettings>>;

export interface AgentProviderSettings {
  [key: string]: unknown;
}

export interface AgentWorkspaceRef {
  // Agent-facing mount label — the `workspace` argument the model selects. Unique per agent.
  name: string;
  // Account-scoped workspaceConfig record id. Agents that reference the same
  // workspaceId read and write the SAME files (shared workspace).
  workspaceId: string;
  // Optional per-workspace sandbox. A sandbox id overrides the agent-level
  // `sandbox` for this workspace (and inherits its permissionMode). Omitted =>
  // inherit the agent-level `sandbox`; if there is none, the workspace is read-only
  // and read/glob run through a service-managed read-only mount (so they see
  // committed writes immediately). `null` forces this workspace read-only AND opts
  // out of that mount: read/glob then read straight from S3 (no compute, but reads
  // lag mount writes by the S3 export delay). See docs/workspace/sandbox/lambda.md.
  sandbox?: string | null;
}

export interface AgentSessionConfig {
  pruning?: AgentSessionPruningConfig;
  compaction?: AgentSessionCompactionConfig;
  [key: string]: unknown;
}

export interface AgentSessionPruningConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AgentSessionCompactionConfig {
  enabled?: boolean;
  maxContextLength?: number;
  [key: string]: unknown;
}

export interface AgentHooksConfig {
  /** Outbound event webhooks. An agent may register several independent endpoints. */
  webhooks?: AgentWebhookHookConfig[];
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
  | "agent.started"
  | "agent.step.finished"
  | "agent.finished"
  | "agent.failed"
  | "agent.approval.required"
  | "tool.call.started"
  | "tool.call.finished"
  | "tool.result"
  | "subagent.task.started"
  | "subagent.task.finished";

export type AgentToolsConfig = Record<string, AgentToolConfig>;

export interface AgentToolConfig {
  enabled?: boolean;
  needsApproval?: boolean;
  async?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentChannelsConfig {
  telegram?: AgentTelegramChannelConfig;
  github?: AgentGitHubChannelConfig;
  slack?: AgentSlackChannelConfig;
  discord?: AgentDiscordChannelConfig;
  pancake?: AgentPancakeChannelConfig;
  zalo?: AgentZaloChannelConfig;
  [key: string]: unknown;
}

export interface AgentTelegramChannelConfig {
  apiUrl?: TelegramAdapterConfig["apiUrl"];
  botToken?: TelegramAdapterConfig["botToken"];
  webhookSecret?: TelegramAdapterConfig["secretToken"];
  allowedChatIds?: number[];
  reactionEmoji?: string;
  [key: string]: unknown;
}

export interface AgentGitHubChannelConfig {
  apiUrl?: Extract<GitHubAdapterConfig, { appId: string }>["apiUrl"];
  webhookSecret?: Extract<GitHubAdapterConfig, { appId: string }>["webhookSecret"];
  appId?: Extract<GitHubAdapterConfig, { appId: string }>["appId"];
  privateKey?: Extract<GitHubAdapterConfig, { appId: string }>["privateKey"];
  allowedRepos?: string[];
  [key: string]: unknown;
}

export interface AgentSlackChannelConfig {
  apiUrl?: SlackAdapterConfig["apiUrl"];
  botToken?: string;
  signingSecret?: SlackAdapterConfig["signingSecret"];
  allowedChannelIds?: string[];
  reactionEmoji?: string;
  [key: string]: unknown;
}

export interface AgentDiscordChannelConfig {
  apiUrl?: DiscordAdapterConfig["apiUrl"];
  botToken?: DiscordAdapterConfig["botToken"];
  publicKey?: DiscordAdapterConfig["publicKey"];
  allowedGuildIds?: string[];
  [key: string]: unknown;
}

export interface AgentPancakeChannelConfig {
  pageId?: string;
  pageAccessToken?: string;
  webhookSecret?: string;
  senderId?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentZaloChannelConfig {
  botToken?: string;
  webhookSecret?: string;
  allowedUserIds?: string[];
  [key: string]: unknown;
}

interface EncryptedAgentConfig {
    encrypted: true;
    algorithm: typeof CONFIG_ENCRYPTION_ALGORITHM;
    iv: string;
    tag: string;
    ciphertext: string;
}

type AgentConfigPatch = Record<string, unknown>;

export function toRuntimeAgentConfig(config: AgentConfig): AgentConfig {
  const {
    agent,
    model,
    provider,
    sandbox,
    workspaces,
    session,
    hooks,
    tools,
    skills,
    subagent,
    publicAccess,
  } = config;

  return normalizeAgentConfig({
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(workspaces !== undefined ? { workspaces } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(subagent !== undefined ? { subagent } : {}),
    ...(publicAccess !== undefined ? { publicAccess } : {}),
  });
}

export function toChannelRuntimeAgentConfig(config: AgentConfig, channelName: string): AgentConfig {
  const runtimeConfig = toRuntimeAgentConfig(config);
  const channelConfig = config.channels?.[channelName];

  if (!channelConfig) {
    return runtimeConfig;
  }

  return {
    ...runtimeConfig,
    channels: {
      [channelName]: channelConfig,
    },
  };
}

export function normalizeAgentConfig(value: unknown): AgentConfig {
  if (value == null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  const config = value as Record<string, unknown>;
  normalizeAgentBehaviorConfig(config.agent);
  normalizeModelConfig(config.model);
  normalizeProviderConfig(config.provider);
  normalizeSandboxRef(config.sandbox);
  normalizeWorkspaceRefs(config.workspaces);
  normalizeSessionConfig(config.session);
  normalizeHooksConfig(config.hooks);
  normalizeChannelsConfig(config.channels);
  normalizeToolsConfig(config.tools);
  normalizeSkillsConfig(config.skills);
  normalizeSubagentConfig(config.subagent);
  assertOptionalBoolean(config.publicAccess, "config.publicAccess");

  return config as AgentConfig;
}

export function normalizeAgentConfigPatch(value: unknown): AgentConfigPatch {
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  validateConfigPatch(value, "config");
  return value;
}

function normalizeChannelsConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.channels must be an object");
  }

  const channels = value as Record<string, unknown>;
  normalizeTelegramConfig(channels.telegram);
  normalizeGitHubConfig(channels.github);
  normalizeSlackConfig(channels.slack);
  normalizeDiscordConfig(channels.discord);
  normalizePancakeConfig(channels.pancake);
  normalizeZaloConfig(channels.zalo);
}

function normalizeAgentBehaviorConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.agent must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalPositiveInteger(config.maxTurn, "config.agent.maxTurn", AGENT_MAX_TURN_LIMIT);
  validateAgentSystemConfig(config.system);
}

function validateAgentSystemConfig(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    const parsed = systemModelMessageSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`config.agent.system must be a string, SystemModelMessage, or SystemModelMessage[]: ${
        parsed.error.issues[0]?.message ?? "invalid system message"
      }`);
    }
  }
}

function normalizeModelConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.model must be an object");
  }

  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!MODEL_CONFIG_SETTING_KEYS.includes(key as (typeof MODEL_CONFIG_SETTING_KEYS)[number])) {
      throw new Error(`config.model.${key} is not supported; use config.model.providerOptions for provider-specific settings`);
    }
  }
  assertOptionalProviderName(config.provider, "config.model.provider");
  assertOptionalString(config.modelId, "config.model.modelId");
  if (config.providerOptions !== undefined && !isPlainObject(config.providerOptions)) {
    throw new Error("config.model.providerOptions must be an object");
  }
  normalizeModelOutputConfig(config.output);
}

function normalizeModelOutputConfig(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.model.output must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalEnum(config.type, "config.model.output.type", ["text", "object", "array", "choice", "json"]);
  if (config.type === undefined) {
    throw new Error("config.model.output.type must be one of: text, object, array, choice, json");
  }
  assertOptionalString(config.name, "config.model.output.name");
  assertOptionalString(config.description, "config.model.output.description");

  switch (config.type) {
    case "text":
    case "json":
      return;
    case "object":
      if (!isPlainObject(config.schema)) {
        throw new Error("config.model.output.schema must be an object");
      }
      return;
    case "array":
      if (!isPlainObject(config.element)) {
        throw new Error("config.model.output.element must be an object");
      }
      return;
    case "choice":
      if (
        !Array.isArray(config.options) ||
        config.options.length === 0 ||
        !config.options.every((entry) => typeof entry === "string")
      ) {
        throw new Error("config.model.output.options must be a non-empty array of strings");
      }
      return;
  }
}

function normalizeProviderConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.provider must be an object");
  }

  for (const [providerName, providerConfig] of Object.entries(value)) {
    if (!isAccountModelProviderName(providerName)) {
      throw new Error(`config.provider.${providerName} is not a supported provider`);
    }
    normalizeProviderSettings(providerName, providerConfig);
  }
}

function normalizeProviderSettings(providerName: AccountModelProviderName, value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error(`config.provider.${providerName} must be an object`);
  }

  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiKey, `config.provider.${providerName}.apiKey`);
  assertOptionalString(config.baseURL, `config.provider.${providerName}.baseURL`);
  if (typeof config.baseURL === "string") {
    assertPublicHttpsUrl(config.baseURL, `config.provider.${providerName}.baseURL`);
  }
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    throw new Error(`config.provider.${providerName}.headers must be an object with string values`);
  }

  if (providerName === "openai") {
    assertOptionalString(config.organization, "config.provider.openai.organization");
    assertOptionalString(config.project, "config.provider.openai.project");
    assertOptionalString(config.name, "config.provider.openai.name");
  }

  if (providerName === "bedrock") {
    assertOptionalString(config.region, "config.provider.bedrock.region");
    assertOptionalString(config.accessKeyId, "config.provider.bedrock.accessKeyId");
    assertOptionalString(config.secretAccessKey, "config.provider.bedrock.secretAccessKey");
    assertOptionalString(config.sessionToken, "config.provider.bedrock.sessionToken");
  }
}

// The concrete sandbox/workspace configs live in their own account-scoped tables;
// the agent config only carries references. Validation of the referenced records
// themselves lives in sandbox-config.ts / workspace-config.ts.
function normalizeSandboxRef(value: unknown): void {
  assertOptionalNonEmptyString(value, "config.sandbox");
}

function normalizeWorkspaceRefs(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("config.workspaces must be an array");
  }

  const seenNames = new Set<string>();
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.workspaces[${index}] must be an object`);
    }
    const ref = entry as Record<string, unknown>;
    const name = ref.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`config.workspaces[${index}].name must be a non-empty string`);
    }
    assertWorkspaceId(name, `config.workspaces[${index}].name`);
    assertOptionalNonEmptyString(ref.workspaceId, `config.workspaces[${index}].workspaceId`);
    if (typeof ref.workspaceId !== "string" || ref.workspaceId.trim().length === 0) {
      throw new Error(`config.workspaces[${index}].workspaceId must be a non-empty string`);
    }
    // `null` is allowed: it forces this workspace read-only even when config.sandbox is set.
    if (ref.sandbox !== null && ref.sandbox !== undefined) {
      if (typeof ref.sandbox !== "string" || ref.sandbox.trim().length === 0) {
        throw new Error(`config.workspaces[${index}].sandbox must be a non-empty string or null`);
      }
    }
    if (seenNames.has(name)) {
      throw new Error(`config.workspaces[${index}].name "${name}" is used more than once`);
    }
    seenNames.add(name);
  });
}

function normalizeSessionConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session must be an object");
  }

  const config = value as Record<string, unknown>;
  normalizeSessionPruningConfig(config.pruning);
  normalizeSessionCompactionConfig(config.compaction);
}

function normalizeSessionPruningConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session.pruning must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.session.pruning.enabled");
}

function normalizeSessionCompactionConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session.compaction must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.session.compaction.enabled");
  assertOptionalPositiveInteger(
    config.maxContextLength,
    "config.session.compaction.maxContextLength",
    SESSION_MAX_CONTEXT_LENGTH_LIMIT,
  );
}

function normalizeHooksConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.hooks must be an object");
  }

  const config = value as Record<string, unknown>;
  if (config.webhooks !== undefined) {
    if (!Array.isArray(config.webhooks)) {
      throw new Error("config.hooks.webhooks must be an array");
    }
    config.webhooks.forEach((webhook, index) =>
      normalizeWebhookHookConfig(webhook, `config.hooks.webhooks[${index}]`),
    );
  }
}

function normalizeWebhookHookConfig(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object`);
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, `${path}.enabled`);
  assertOptionalNonEmptyString(config.url, `${path}.url`);
  assertOptionalNonEmptyString(config.secret, `${path}.secret`);
  if (config.events !== undefined) {
    if (!Array.isArray(config.events) || !config.events.every((event) =>
      typeof event === "string" && AGENT_LIFECYCLE_EVENT_NAMES.includes(event as AgentLifecycleEventName)
    )) {
      throw new Error(`${path}.events must be an array of: ${AGENT_LIFECYCLE_EVENT_NAMES.join(", ")}`);
    }
  }

  if (config.enabled === true) {
    if (typeof config.url !== "string" || config.url.trim().length === 0) {
      throw new Error(`${path}.url is required when ${path}.enabled is true`);
    }
    if (typeof config.secret !== "string" || config.secret.trim().length === 0) {
      throw new Error(`${path}.secret is required when ${path}.enabled is true`);
    }
  }

  if (typeof config.url === "string" && config.url.trim().length > 0) {
    assertPublicHttpsUrl(config.url, `${path}.url`);
  }
}

function normalizeToolsConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.tools must be an object");
  }

  for (const [toolName, toolConfig] of Object.entries(value)) {
    normalizeToolConfig(toolName, toolConfig);
  }
}

function normalizeSkillsConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.skills must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.skills.enabled");
  assertOptionalStringArray(config.allowed, "config.skills.allowed");
}

function normalizeSubagentConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.subagent must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.subagent.enabled");
  assertOptionalStringArray(config.allowed, "config.subagent.allowed");
  assertOptionalEnum(config.context, "config.subagent.context", ["new", "inherited"]);
  assertOptionalEnum(config.mode, "config.subagent.mode", ["ephemeral", "persistent"]);
}

function normalizeToolConfig(toolName: string, value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error(`config.tools.${toolName} must be an object`);
  }

  if (!isSupportedConfigToolName(toolName) && !isAccountToolId(toolName)) {
    throw new Error(`config.tools.${toolName} is not a supported tool`);
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, `config.tools.${toolName}.enabled`);
  assertOptionalBoolean(config.needsApproval, `config.tools.${toolName}.needsApproval`);
  assertOptionalBoolean(config.async, `config.tools.${toolName}.async`);
  if (config.config !== undefined && !isPlainObject(config.config)) {
    throw new Error(`config.tools.${toolName}.config must be an object`);
  }

  if (isAccountToolId(toolName)) {
    return;
  }

  switch (toolName) {
    case "tavilySearch":
      normalizeTavilySearchToolConfig(config);
      return;
    case "tavilyExtract":
      normalizeTavilyExtractToolConfig(config);
      return;
    case "googleSearch":
      normalizeGoogleSearchToolConfig(config);
      return;
    case "handoffs":
      normalizeHandoffsToolConfig(config);
      return;
  }
}

function normalizeHandoffsToolConfig(config: Record<string, unknown>): void {
  if (config.enabled === false) {
    return;
  }

  if (!isPlainObject(config.pancake)) {
    throw new Error("config.tools.handoffs.pancake is required");
  }
  const pancake = config.pancake;
  if (!isPlainObject(pancake.scenarioTagIds)) {
    throw new Error("config.tools.handoffs.pancake.scenarioTagIds is required");
  }
  assertOptionalNonEmptyString(
    pancake.scenarioTagIds.order,
    "config.tools.handoffs.pancake.scenarioTagIds.order",
  );
  assertOptionalNonEmptyString(
    pancake.scenarioTagIds.pending,
    "config.tools.handoffs.pancake.scenarioTagIds.pending",
  );
  if (!pancake.scenarioTagIds.order) {
    throw new Error("config.tools.handoffs.pancake.scenarioTagIds.order is required");
  }
  if (!pancake.scenarioTagIds.pending) {
    throw new Error("config.tools.handoffs.pancake.scenarioTagIds.pending is required");
  }

  if (!isPlainObject(config.zalo)) {
    throw new Error("config.tools.handoffs.zalo is required");
  }
  const zalo = config.zalo;
  assertOptionalNonEmptyString(zalo.botToken, "config.tools.handoffs.zalo.botToken");
  if (!zalo.botToken) {
    throw new Error("config.tools.handoffs.zalo.botToken is required");
  }
  assertRequiredNonEmptyStringArray(zalo.notifyUserIds, "config.tools.handoffs.zalo.notifyUserIds");
}

function isSupportedConfigToolName(
  toolName: string,
): toolName is "tavilySearch" | "tavilyExtract" | "googleSearch" | "handoffs" {
  return toolName === "tavilySearch" ||
    toolName === "tavilyExtract" ||
    toolName === "googleSearch" ||
    toolName === "handoffs";
}

function normalizeTavilySearchToolConfig(config: Record<string, unknown>): void {
  assertOptionalEnum(config.searchDepth, "config.tools.tavilySearch.searchDepth", ["basic", "advanced"]);
  assertOptionalBoolean(config.includeAnswer, "config.tools.tavilySearch.includeAnswer");
  assertOptionalPositiveInteger(config.maxResults, "config.tools.tavilySearch.maxResults", 20);
  assertOptionalEnum(config.topic, "config.tools.tavilySearch.topic", ["general", "news", "finance"]);
}

function normalizeTavilyExtractToolConfig(config: Record<string, unknown>): void {
  assertOptionalEnum(config.extractDepth, "config.tools.tavilyExtract.extractDepth", ["basic", "advanced"]);
  assertOptionalEnum(config.format, "config.tools.tavilyExtract.format", ["markdown", "text"]);
}

function normalizeGoogleSearchToolConfig(config: Record<string, unknown>): void {
  if (config.searchTypes !== undefined) {
    if (!isPlainObject(config.searchTypes)) {
      throw new Error("config.tools.googleSearch.searchTypes must be an object");
    }
    const searchTypes = config.searchTypes as Record<string, unknown>;
    if (searchTypes.webSearch !== undefined && !isPlainObject(searchTypes.webSearch)) {
      throw new Error("config.tools.googleSearch.searchTypes.webSearch must be an object");
    }
    if (searchTypes.imageSearch !== undefined && !isPlainObject(searchTypes.imageSearch)) {
      throw new Error("config.tools.googleSearch.searchTypes.imageSearch must be an object");
    }
  }

  if (config.timeRangeFilter !== undefined) {
    if (!isPlainObject(config.timeRangeFilter)) {
      throw new Error("config.tools.googleSearch.timeRangeFilter must be an object");
    }
    const timeRangeFilter = config.timeRangeFilter as Record<string, unknown>;
    assertOptionalString(timeRangeFilter.startTime, "config.tools.googleSearch.timeRangeFilter.startTime");
    assertOptionalString(timeRangeFilter.endTime, "config.tools.googleSearch.timeRangeFilter.endTime");
  }
}

function validateConfigPatch(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const withoutNulls = removeNullConfigValues(candidate);

  if (path === "config") {
    normalizeAgentConfig(withoutNulls);
    return;
  }

  for (const [key, entry] of Object.entries(candidate)) {
    if (entry == null || Array.isArray(entry) || !isPlainObject(entry)) {
      continue;
    }

    validateConfigPatch(entry, `${path}.${key}`);
  }
}

function removeNullConfigValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (entry === null) {
        return [];
      }
      if (isPlainObject(entry)) {
        return [[key, removeNullConfigValues(entry)]];
      }
      return [[key, entry]];
    }),
  );
}

function normalizeTelegramConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.telegram must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiUrl, "config.channels.telegram.apiUrl");
  assertOptionalString(config.botToken, "config.channels.telegram.botToken");
  assertOptionalString(config.webhookSecret, "config.channels.telegram.webhookSecret");
  assertOptionalNumberArray(config.allowedChatIds, "config.channels.telegram.allowedChatIds");
  assertOptionalString(config.reactionEmoji, "config.channels.telegram.reactionEmoji");
}

function normalizeGitHubConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.github must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiUrl, "config.channels.github.apiUrl");
  assertOptionalString(config.webhookSecret, "config.channels.github.webhookSecret");
  assertOptionalString(config.appId, "config.channels.github.appId");
  assertOptionalString(config.privateKey, "config.channels.github.privateKey");
  assertOptionalStringArray(config.allowedRepos, "config.channels.github.allowedRepos");
}

function normalizeSlackConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.slack must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiUrl, "config.channels.slack.apiUrl");
  assertOptionalString(config.botToken, "config.channels.slack.botToken");
  assertOptionalString(config.signingSecret, "config.channels.slack.signingSecret");
  assertOptionalStringArray(config.allowedChannelIds, "config.channels.slack.allowedChannelIds");
  assertOptionalString(config.reactionEmoji, "config.channels.slack.reactionEmoji");
}

function normalizeDiscordConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.discord must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiUrl, "config.channels.discord.apiUrl");
  assertOptionalString(config.botToken, "config.channels.discord.botToken");
  assertOptionalString(config.publicKey, "config.channels.discord.publicKey");
  assertOptionalStringArray(config.allowedGuildIds, "config.channels.discord.allowedGuildIds");
}

function normalizePancakeConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.pancake must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.pageId, "config.channels.pancake.pageId");
  assertOptionalString(config.pageAccessToken, "config.channels.pancake.pageAccessToken");
  assertOptionalString(config.webhookSecret, "config.channels.pancake.webhookSecret");
  assertOptionalString(config.senderId, "config.channels.pancake.senderId");
  if (config.options !== undefined && !isPlainObject(config.options)) {
    throw new Error("config.channels.pancake.options must be an object");
  }
  const options = isPlainObject(config.options) ? config.options : {};
  assertOptionalStringArray(options.ignoreTagIds, "config.channels.pancake.options.ignoreTagIds");
}

function normalizeZaloConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.zalo must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.botToken, "config.channels.zalo.botToken");
  assertOptionalString(config.webhookSecret, "config.channels.zalo.webhookSecret");
  assertOptionalStringArray(config.allowedUserIds, "config.channels.zalo.allowedUserIds");
  if (typeof config.webhookSecret === "string") {
    const length = config.webhookSecret.length;
    if (length < 8 || length > 256) {
      throw new Error("config.channels.zalo.webhookSecret must be 8 to 256 characters");
    }
  }
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}

function assertOptionalProviderName(value: unknown, name: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !isAccountModelProviderName(value)) {
    throw new Error(`${name} must be one of: ${accountModelProviderNames().join(", ")}`);
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
  assertOptionalString(value, name);
  if (typeof value === "string" && value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertWorkspaceId(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${name} must use only letters, numbers, dots, underscores, or hyphens`);
  }
}

function assertOptionalPositiveInteger(value: unknown, name: string, max: number): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function assertOptionalStringArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
}

function assertRequiredNonEmptyStringArray(value: unknown, name: string): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }

  if (value.length === 0 || value.some((entry) => entry.trim().length === 0)) {
    throw new Error(`${name} must contain at least one non-empty string`);
  }
}

function assertOptionalNumberArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => Number.isFinite(entry) && typeof entry === "number")) {
    throw new Error(`${name} must be an array of numbers`);
  }
}

export function decodeStoredAgentConfig(value: unknown): AgentConfig {
    return decodeStoredConfigObject(value) as AgentConfig;
}

export function encryptAgentConfig(config: AgentConfig): EncryptedAgentConfig {
    return encryptConfigObject(config);
}

// Generic config encryption (aes-256-gcm) reused by the sandbox-config store so
// account-scoped sandbox configs (which carry envVars secrets) are also encrypted
// at rest. Workspace configs hold no secrets and are stored in plaintext.
export function encryptConfigObject(config: object): EncryptedAgentConfig {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CONFIG_ENCRYPTION_ALGORITHM, agentConfigEncryptionKey(), iv);
    const plaintext = JSON.stringify(config);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf-8"),
        cipher.final(),
    ]);

    return {
        encrypted: true,
        algorithm: CONFIG_ENCRYPTION_ALGORITHM,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
    };
}

export function decodeStoredConfigObject(value: unknown): Record<string, unknown> {
    if (isEncryptedAgentConfig(value)) {
        return decryptConfigObject(value);
    }

    throw new Error("Stored config must be encrypted");
}

function decryptConfigObject(config: EncryptedAgentConfig): Record<string, unknown> {
    const decipher = createDecipheriv(
        CONFIG_ENCRYPTION_ALGORITHM,
        agentConfigEncryptionKey(),
        Buffer.from(config.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(config.tag, "base64url"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(config.ciphertext, "base64url")),
        decipher.final(),
    ]).toString("utf-8");

    const parsed = JSON.parse(plaintext) as unknown;
    if (!isPlainObject(parsed)) {
        throw new Error("Stored config must be an object");
    }

    return parsed;
}

function agentConfigEncryptionKey(): Buffer {
    return createHash("sha256")
        .update(requireEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET"))
        .digest();
}

function isEncryptedAgentConfig(value: unknown): value is EncryptedAgentConfig {
    if (!isPlainObject(value)) {
        return false;
    }

    return value.encrypted === true &&
        value.algorithm === CONFIG_ENCRYPTION_ALGORITHM &&
        typeof value.iv === "string" &&
        typeof value.tag === "string" &&
        typeof value.ciphertext === "string";
}

export function mergeAgentConfig(existing: AgentConfig, patch: AgentConfigPatch): AgentConfig {
    return normalizeAgentConfig(mergeConfigValue(existing, patch));
}

/**
 * Folds per-run overrides into a shallow copy of the agent config for one
 * invocation. Model overrides ride on `model` and are read where the config
 * already flows. `system` is handled separately as ephemeral system messages.
 * Returns the original config untouched when there are no model overrides.
 */
export function applyRunOverrides(config: AgentConfig, overrides?: RunOverrides): AgentConfig {
    if (!overrides || !(overrides.model && Object.keys(overrides.model).length > 0)) {
        return config;
    }
    const next: AgentConfig = { ...config };
    if (overrides.model && Object.keys(overrides.model).length > 0) {
        next.model = { ...config.model, ...overrides.model };
    }
    return next;
}

function mergeConfigValue(existing: unknown, patch: unknown): unknown {
    if (patch === undefined) {
        return existing;
    }

    if (patch === REDACTED_SECRET_VALUE) {
        return existing;
    }

    if (patch === null) {
        return undefined;
    }

    if (Array.isArray(patch) || !isPlainObject(patch)) {
        return patch;
    }

    const existingObject = isPlainObject(existing) ? existing : {};
    const merged = { ...existingObject };
    for (const [key, value] of Object.entries(patch)) {
        const mergedValue = mergeConfigValue(existingObject[key], value);
        if (mergedValue === undefined) {
            delete merged[key];
        } else {
            merged[key] = mergedValue;
        }
    }

    return merged;
}

export function redactAgentConfig(config: AgentConfig): AgentConfig {
  return redactSecrets(config) as AgentConfig;
}

// Generic deep-merge + secret redaction reused by the sandbox/workspace config
// stores so they share the agent config's patch semantics (null deletes a key,
// the REDACTED sentinel preserves the existing secret).
export function mergeConfigObjects(existing: object, patch: object): Record<string, unknown> {
  const merged = mergeConfigValue(existing, patch);
  return isPlainObject(merged) ? merged : {};
}

export function redactConfigSecrets<T>(value: T): T {
  return redactSecrets(value) as T;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretConfigKey(key) && typeof entry === "string" ? REDACTED_SECRET_VALUE : redactSecrets(entry),
    ]),
  );
}

function isSecretConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("credential") ||
    normalized.includes("kubeconfig") ||
    normalized.includes("certificate") ||
    normalized.includes("accesskey") ||
    normalized.includes("access_key") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized === "apikey" ||
    normalized === "api_key";
}

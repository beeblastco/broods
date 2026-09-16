/**
 * Agent configuration: types for the per-agent settings object, the runtime
 * projection of a stored config, and encryption helpers. The validation rules
 * are the config plane's (`@broods/convex/model/agentRules`), so a config is
 * judged the same on write and on every run.
 * Account types and auth live in `./accounts.ts` and `../auth.ts`.
 */

import type { DiscordAdapterConfig } from "@chat-adapter/discord";
import type { GitHubAdapterConfig } from "@chat-adapter/github";
import type { SlackAdapterConfig } from "@chat-adapter/slack";
import type { TelegramAdapterConfig } from "@chat-adapter/telegram";
import type {
  JSONSchema7,
  LanguageModelCallOptions,
  RequestOptions,
  SystemModelMessage,
  streamText,
} from "ai";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { requireEnv } from "../env.ts";
import { isPlainObject } from "../object.ts";
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

const CONFIG_ENCRYPTION_ALGORITHM = "aes-256-gcm";
// `agent.maxTurn: 0` lifts the step cap: the loop runs until the model stops.
export const AGENT_MAX_TURN_UNLIMITED = 0;
// A per-run `model` override may tune sampling (the Vercel AI SDK
// `LanguageModelCallOptions`: temperature, topP, topK, maxOutputTokens,
// reasoning, …) and provider-specific `providerOptions`. Identity/credential
// keys are rejected.
export const RUN_OVERRIDE_RESERVED_MODEL_KEYS = [
  "provider",
  "modelId",
  "output",
  "apiKey",
] as const;

export interface AgentConfig {
  agent?: AgentBehaviorConfig;
  harness?: AgentHarnessConfig;
  model?: AgentModelConfig;
  provider?: AgentProviderConfig;
  // References to standalone, account-scoped sandbox / workspace records. The
  // concrete configs live in their own tables (see sandbox-config.ts /
  // workspace-config.ts) and are resolved by the handler before the agent loop.
  // The first is the default: `bash` with no workspace runs there, a workspace
  // without its own sandbox inherits it, and a harness runs on it. The others are
  // reached by name.
  sandboxes?: string[];
  workspaces?: AgentWorkspaceRef[];
  session?: AgentSessionConfig;
  hooks?: AgentHooksConfig;
  channels?: AgentChannelsConfig;
  tools?: AgentToolsConfig;
  /** Connected MCP servers, keyed by their config-plane row id (#331). */
  mcp?: AgentMcpConfig;
  /**
   * Tool names withheld for this run, applied after the tool set is built.
   * Set by a channel record; a channel can take a tool away, never add one.
   * Names that are not present are ignored.
   */
  denyTools?: string[];
  skills?: AgentSkillsConfig;
  subagent?: AgentSubagentConfig;
  scheduler?: AgentSchedulerConfig;
  /** Policies that gate this agent. Each one carries its own enforcement mode. */
  policies?: string[];
  // Opt-in flag for the public runtime endpoint (SSE/WebSocket via the stage
  // runtime key). Off by default: when not `true` the deployment (public-key)
  // request path is refused. Internal callers (account/admin secret, cron,
  // async worker) and channel webhooks are never gated by this.
  publicAccess?: boolean;
  [key: string]: unknown;
}

export interface AgentBehaviorConfig {
  // Model/tool loop steps per turn. 0 lifts the cap; unset is the harness default.
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

/**
 * Per-invocation overrides supplied on a single request. They never persist:
 * applyRunOverrides folds them into a copy of the agent config for one run only.
 */
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

/**
 * Opt-in for the `schedule` tool. Off by default: a scheduled task starts
 * billable agent runs long after the turn that asked for it.
 */
export interface AgentSchedulerConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AgentSubagentConfig {
  enabled?: boolean;
  allowed?: string[];
  context?: "new" | "inherited";
  mode?: "ephemeral" | "persistent";
  /**
   * Publishes child reasoning, text, and tool stream parts to the existing
   * WebSocket/JetStream response path. Off by default.
   */
  stream?: boolean;
  /**
   * Controls what the parent agent sees from a finished subagent (AI SDK
   * "controlling what the model sees"): `full` = the child's whole transcript,
   * `result` = only its final result (default), `none` = nothing. A
   * `subagent.task.finished` code hook overrides this for custom shaping.
   */
  visibility?: "full" | "result" | "none";
  [key: string]: unknown;
}

export interface AgentModelConfig
  extends
    LanguageModelCallOptions,
    // Partial keeps these optional when a consumer lacks the optional `ai`
    // peer: `Pick<any, K>` would otherwise make both keys required.
    Partial<Pick<RequestOptions, "maxRetries" | "timeout">> {
  provider?: AccountModelProviderName;
  modelId?: string;
  /**
   * Speech-to-text model for inbound audio, on the same provider and key as
   * `modelId`. Defaults to the widest-container model the provider ships.
   */
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

// Open on purpose: what a provider's AI SDK factory accepts is passed through
// verbatim. Named keys are only the ones broods reads itself, never a limit.
export interface AgentProviderSettings {
  apiKey?: string;
  /** OpenAI-compatible endpoint (`custom`). Snake form, as documented. */
  base_url?: string;
  /** OpenAI-compatible endpoint (`custom`). AI-SDK form; the dashboard writes both. */
  baseURL?: string;
  headers?: Record<string, string>;
  /** Endpoint label; becomes the provider id and the pi harness env prefix. */
  name?: string;
  organization?: string;
  project?: string;
  [key: string]: unknown;
}

export interface AgentWorkspaceRef {
  // Agent-facing mount label, the `workspace` argument the model selects. Unique per agent.
  name: string;
  // Account-scoped workspaceConfig record id. Agents that reference the same
  // workspaceId read and write the SAME files (shared workspace).
  workspaceId: string;
  // Optional per-workspace sandbox. A sandbox id overrides the agent's default
  // sandbox for this workspace (and inherits its permissionMode). Omitted =>
  // inherit the default (first of `sandboxes`); if there is none, the workspace is
  // read-only and read/glob run through a service-managed read-only mount (so they see
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
  /**
   * Uploaded code hooks. Each entry references an accountHooks bundle by id; the
   * bundle runs in the V8 isolate at the matching fire-points and its validated
   * return is folded into mutable harness state.
   */
  code?: AgentCodeHookConfig[];
  [key: string]: unknown;
}

export interface AgentCodeHookConfig {
  hookId: string;
  /**
   * Optional narrowing of the events this reference reacts to. Omitted => the
   * bundle's own declared `events` set. Any listed event outside the bundle's
   * declared set is ignored at runtime.
   */
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

// The full set of events a user code hook can subscribe to (agent lifecycle plus
// the channel points: inbound message, before-send). Re-exported from its single
// home in convex so an event added there reaches this union without a second
// edit here.
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
  /** Applies to every tool the server exposes. */
  needsApproval?: boolean;
  /** Extra request headers; values resolved from account env vars at sync. */
  headers?: Record<string, string>;
  /**
   * Overrides for the row's oauth credentials; values resolved from account
   * env vars at sync, so the row's ${NAME} refs never reach the token
   * endpoint. tokenUrl stays on the row, where registration checked it.
   */
  oauth?: Partial<Omit<McpOauth, "tokenUrl">>;
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

export type ChannelPartitionBy = "shared" | "conversation";

/**
 * How an attached partitioned workspace splits its folders for runs arriving
 * through this door. `shared` mounts the workspace root; `conversation` mounts
 * a private child folder per thread, issue or chat under `alias`.
 */
export type ChannelPartition =
  | { by: "shared"; alias?: never }
  | { by: "conversation"; alias: string };

// The adapter credential fields are spelled out rather than indexed off the
// adapter configs so the published SDK types resolve without those packages;
// ChannelCredentialDrift below fails the build if an upstream shape moves.
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
    Exactly<SlackAdapterConfig["apiUrl"], string | undefined>,
    Exactly<SlackAdapterConfig["signingSecret"], string | undefined>,
    Exactly<DiscordAdapterConfig["apiUrl"], string | undefined>,
    Exactly<
      SerializedCredential<DiscordAdapterConfig["botToken"]>,
      string | undefined
    >,
    Exactly<DiscordAdapterConfig["publicKey"], string | undefined>,
  ]
>;

export interface AgentTelegramChannelConfig {
  id?: string;
  apiUrl?: string;
  botToken?: string;
  webhookSecret?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  /** Bot's @username, e.g. `tracy_bot`. Set it to answer only when the agent is mentioned. */
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
  /** Bot username for @-mention detection (e.g. "my-bot" or "my-bot[bot]"). */
  botUserName?: string;
  /** Bot's numeric GitHub user ID for self-message detection. */
  botUserId?: number;
  /** When false, the bot does not auto-trigger on new issues (opened/edited/reopened). Defaults to true. The bot still triggers when assigned to an issue. */
  triggerOnIssueOpen?: boolean;
  /** When false, the bot does not auto-trigger on new PRs (opened/edited/reopened). Defaults to true. The bot still triggers when assigned to a PR. */
  triggerOnPROpen?: boolean;
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
  /** Bot's Discord user id. Set it to answer only when the agent is mentioned. */
  botUserId?: string;
  /** Role ids that count as mentioning the agent, e.g. an on-call role. */
  mentionRoleIds?: string[];
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

interface EncryptedAgentConfig {
  encrypted: true;
  algorithm: typeof CONFIG_ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Folds per-run overrides into a shallow copy of the agent config for one
 * invocation. Model overrides ride on `model` and are read where the config
 * already flows. `system` is handled separately as ephemeral system messages.
 * Returns the original config untouched when there are no model overrides.
 */
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
  const next: AgentConfig = { ...config };
  if (overrides.model && Object.keys(overrides.model).length > 0) {
    next.model = { ...config.model, ...overrides.model };
  }

  return next;
}

// The step cap an external harness (claude-code, deepagents) is handed. Unset
// falls back to that harness's own default; 0 lifts it there too.
export function configuredMaxTurn(config: AgentConfig): number | undefined {
  const maxTurn = config.agent?.maxTurn;

  return maxTurn === AGENT_MAX_TURN_UNLIMITED
    ? Number.MAX_SAFE_INTEGER
    : maxTurn;
}

export function decodeStoredAgentConfig(value: unknown): AgentConfig {
  return decodeStoredConfigObject(value) as AgentConfig;
}

export function decodeStoredConfigObject(
  value: unknown,
): Record<string, unknown> {
  if (isEncryptedAgentConfig(value)) {
    return decryptConfigObject(value);
  }

  throw new Error("Stored config must be encrypted");
}

// The same aes-256-gcm blob the config plane writes with Web Crypto
// (encryptAgentConfigBlob), so decodeStoredConfigObject reads either.
export function encryptConfigObject(config: object): EncryptedAgentConfig {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    CONFIG_ENCRYPTION_ALGORITHM,
    agentConfigEncryptionKey(),
    iv,
  );
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

// Off by default: only an explicit `trace: "enabled"` on the channel appends
// the dashboard trace link to replies. Trace collection is unaffected.
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

// Persistent is the default so a child owns a durable conversation that can be
// resumed and controlled; only an explicit "ephemeral" opts out.
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

/**
 * The stored config cut down to the branches a run reads, re-checked with the
 * config plane's rules so a row written before a rule tightened fails by name.
 */
export function toRuntimeAgentConfig(config: AgentConfig): AgentConfig {
  const {
    agent,
    harness,
    model,
    provider,
    sandboxes,
    workspaces,
    session,
    hooks,
    tools,
    mcp,
    denyTools,
    skills,
    subagent,
    scheduler,
    policies,
    publicAccess,
  } = config;

  return normalizeAgentConfig({
    // A stored config from before `sandboxes` absorbed `sandbox` would otherwise
    // lose the key here and quietly promote its first extra to the default, so it
    // is carried through for the normalizer to refuse.
    ...("sandbox" in config && config.sandbox !== undefined
      ? { sandbox: config.sandbox }
      : {}),
    ...(agent !== undefined ? { agent: agent } : {}),
    ...(harness !== undefined ? { harness: harness } : {}),
    ...(model !== undefined ? { model: model } : {}),
    ...(provider !== undefined ? { provider: provider } : {}),
    ...(sandboxes !== undefined ? { sandboxes: sandboxes } : {}),
    ...(workspaces !== undefined ? { workspaces: workspaces } : {}),
    ...(session !== undefined ? { session: session } : {}),
    ...(hooks !== undefined ? { hooks: hooks } : {}),
    ...(tools !== undefined ? { tools: tools } : {}),
    ...(mcp !== undefined ? { mcp: mcp } : {}),
    ...(denyTools !== undefined ? { denyTools: denyTools } : {}),
    ...(skills !== undefined ? { skills: skills } : {}),
    ...(subagent !== undefined ? { subagent: subagent } : {}),
    ...(scheduler !== undefined ? { scheduler: scheduler } : {}),
    ...(policies !== undefined ? { policies: policies } : {}),
    ...(publicAccess !== undefined ? { publicAccess: publicAccess } : {}),
  }) as AgentConfig;
}

function agentConfigEncryptionKey(): Buffer {
  return createHash("sha256")
    .update(requireEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET"))
    .digest();
}

function decryptConfigObject(
  config: EncryptedAgentConfig,
): Record<string, unknown> {
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

function isEncryptedAgentConfig(value: unknown): value is EncryptedAgentConfig {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    value.encrypted === true &&
    value.algorithm === CONFIG_ENCRYPTION_ALGORITHM &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  );
}

/**
 * Agent config validation for Convex config HTTP. Pure module: safe for the
 * default Convex runtime. The public projection lives in ./responses.ts.
 */

import { mergeConfigObjects } from "./configValues";
import { isPlainObject, isStringRecord } from "./objects";
import {
  AGENT_HOOK_EVENT_NAMES,
  type AgentHookEventName,
} from "./accountHooks";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  isAccountModelProviderName,
  type AccountModelProviderName,
} from "./modelProviders";

export type AgentStatus = "active" | "disabled";
export type { AccountModelProviderName } from "./modelProviders";

export type AgentConfig = Record<string, unknown> & {
  agent?: Record<string, unknown>;
  harness?: {
    activeTools?: string[];
    debug?: {
      enabled?: boolean;
      level?: (typeof AGENT_HARNESS_DEBUG_LEVELS)[number];
      subsystems?: string[];
    };
    inactiveTools?: string[];
    type: (typeof AGENT_HARNESS_TYPES)[number];
    permissionMode?: (typeof AGENT_HARNESS_PERMISSION_MODES)[number];
    startupTimeoutMs?: number;
    webSearch?: boolean;
  };
  model?: Record<string, unknown>;
  provider?: Partial<Record<AccountModelProviderName, Record<string, unknown>>>;
  sandbox?: string;
  workspaces?: AgentWorkspaceRef[];
  session?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  denyTools?: string[];
  skills?: { enabled?: boolean; allowed?: string[]; [key: string]: unknown };
  subagent?: {
    enabled?: boolean;
    allowed?: string[];
    context?: "new" | "inherited";
    mode?: "ephemeral" | "persistent";
    stream?: boolean;
    visibility?: "full" | "result" | "none";
    [key: string]: unknown;
  };
  scheduler?: { enabled?: boolean; [key: string]: unknown };
  policies?: string[];
  publicAccess?: boolean;
};

export interface AgentWorkspaceRef {
  name: string;
  workspaceId: string;
  sandbox?: string | null;
}

const AGENT_MAX_TURN_LIMIT = 100;
const AGENT_HARNESS_STARTUP_TIMEOUT_LIMIT = 10 * 60 * 1_000;
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 500_000;
// Harness vocabulary mirrors core's apps/core/src/shared/domain/agent-config.ts
// (the runtime source of truth for these rules); change both together.
const AGENT_HARNESS_TYPES = [
  "claude-code",
  "codex",
  "deepagents",
  "opencode",
  "pi",
] as const;
const AGENT_HARNESS_DEBUG_LEVELS = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;
const AGENT_HARNESS_PERMISSION_MODES = [
  "allow-reads",
  "allow-edits",
  "allow-all",
] as const;
const AGENT_HARNESS_KEYS = new Set([
  "activeTools",
  "debug",
  "inactiveTools",
  "permissionMode",
  "startupTimeoutMs",
  "type",
  "webSearch",
]);
const AGENT_HARNESS_DEBUG_KEYS = new Set(["enabled", "level", "subsystems"]);
const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Deprecated public account-tool id prefix. It is neither a native Convex id
// nor a provider tool name, so it must not fall through as one.
const DEPRECATED_TOOL_ID_PREFIX = "tool_";

// Tool names the harness registers itself (sandbox, skills, subagents, async
// status). config.tools cannot claim them for a provider-defined tool.
const RESERVED_HARNESS_TOOL_NAMES = new Set([
  "async_status",
  "bash",
  "cancel_schedule",
  "edit",
  "glob",
  "grep",
  "list_schedules",
  "load_skill",
  "memory_save",
  "read",
  "run_subagent",
  "schedule",
  "update_schedule",
  "write",
]);
const CHANNEL_PARTITION_MODES = ["shared", "conversation"] as const;

// Both spellings this field used to carry, kept so a stale key throws instead
// of sitting in config doing nothing.
const RETIRED_PARTITION_KEYS = [
  "workspaceIsolationScope",
  "workspaceScope",
] as const;

// Every provider used to name its own reach list. They are one pair now, so a
// stale key has to fail loudly here rather than sit in config doing nothing.
const RETIRED_REACH_KEYS = [
  ["allowedChatIds", "allowedChannelIds"],
  ["allowedGroupIds", "allowedChannelIds"],
  ["allowedGuildIds", "allowedChannelIds"],
  ["allowedRepos", "allowedChannelIds"],
] as const;
const MODEL_CONFIG_SETTING_KEYS = [
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
  "reasoning",
  "maxRetries",
  "timeout",
] as const;
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
] as const;

/**
 * Validate and normalize a full stored agent config.
 * @param value unknown config value
 * @returns normalized agent config
 */
export function normalizeAgentConfig(value: unknown): AgentConfig {
  if (value == null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  const config = value as AgentConfig;
  normalizeAgentBehaviorConfig(config.agent);
  normalizeHarnessConfig(config.harness);
  normalizeModelConfig(config.model);
  normalizeProviderConfig(config.provider);
  normalizeSandboxRef(config.sandbox);
  if (isPlainObject(config.harness) && typeof config.sandbox !== "string") {
    throw new Error(
      `config.sandbox is required for the ${String(config.harness.type)} harness`,
    );
  }
  normalizeWorkspaceRefs(config.workspaces);
  normalizeSessionConfig(config.session);
  normalizeHooksConfig(config.hooks);
  normalizeChannelsConfig(config.channels);
  normalizeToolsConfig(config.tools);
  assertOptionalStringArray(config.denyTools, "config.denyTools");
  normalizeSkillsConfig(config.skills);
  normalizeSubagentConfig(config.subagent);
  normalizeSchedulerConfig(config.scheduler);
  if (config.policy !== undefined) {
    throw new Error(
      "config.policy is no longer supported; use config.policies, and set mode on the policy itself",
    );
  }
  const policies = normalizePolicyIds(config.policies);
  if (policies) {
    config.policies = policies;
  } else {
    delete config.policies;
  }
  if (isPlainObject(config.harness) && config.policies !== undefined) {
    throw new Error("config.policies is not supported with config.harness");
  }
  if (
    isPlainObject(config.harness) &&
    isPlainObject(config.model) &&
    isPlainObject(config.model.output) &&
    config.model.output.type !== "text"
  ) {
    throw new Error(
      "config.model.output structured output is not supported with config.harness",
    );
  }
  assertOptionalBoolean(config.publicAccess, "config.publicAccess");

  return config;
}

/**
 * Validate a partial config patch, preserving null deletes for merge time.
 * @param value patch value
 * @returns the original patch object
 */
export function normalizeAgentConfigPatch(
  value: unknown,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }
  validateConfigPatch(value, "config");

  return value;
}

/**
 * Merge a validated patch into an existing config and revalidate the result.
 * @param existing existing stored config
 * @param patch patch object
 * @returns merged normalized config
 */
export function mergeAgentConfig(
  existing: AgentConfig,
  patch: Record<string, unknown>,
): AgentConfig {
  return normalizeAgentConfig(mergeConfigObjects(existing, patch));
}

/**
 * Normalize input for POST /v1/agents.
 * @param value request body
 * @returns normalized create input
 */
export function normalizeCreateAgentInput(value: unknown): {
  name: string;
  description?: string;
  config: AgentConfig;
} {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = normalizeRequiredString(value.name, "name");
  const description = optionalString(value.description, "description");
  const config = normalizeAgentConfig(value.config);

  return {
    name: name,
    ...(description ? { description: description } : {}),
    config: config,
  };
}

/**
 * Normalize input for PATCH /v1/agents/{agentId}.
 * @param existingConfig stored config before the patch
 * @param value request body
 * @returns normalized patch values and merged config
 */
export function normalizeUpdateAgentInput(
  existingConfig: AgentConfig,
  value: unknown,
): {
  name?: string;
  description?: string | null;
  status?: AgentStatus;
  config: AgentConfig;
} {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");

  const config =
    "config" in value
      ? mergeAgentConfig(
          existingConfig,
          normalizeAgentConfigPatch(value.config),
        )
      : existingConfig;

  return {
    ...(value.name !== undefined
      ? { name: normalizeRequiredString(value.name, "name") }
      : {}),
    ...(value.description !== undefined
      ? {
          description:
            value.description === null
              ? null
              : optionalString(value.description, "description"),
        }
      : {}),
    ...(value.status !== undefined
      ? { status: requireAgentStatus(value.status) }
      : {}),
    config: config,
  };
}

function normalizeAgentBehaviorConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.agent must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalPositiveInteger(
    config.maxTurn,
    "config.agent.maxTurn",
    AGENT_MAX_TURN_LIMIT,
  );
  validateAgentSystemConfig(config.system);
}

function validateAgentSystemConfig(value: unknown): void {
  if (value === undefined || typeof value === "string") return;
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (
      !isPlainObject(entry) ||
      entry.role !== "system" ||
      typeof entry.content !== "string"
    ) {
      throw new Error(
        "config.agent.system must be a string, SystemModelMessage, or SystemModelMessage[]: invalid system message",
      );
    }
  }
}

// Mirrors core's normalizeHarnessConfig in
// apps/core/src/shared/domain/agent-config.ts; same messages on purpose.
function normalizeHarnessConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.harness must be an object");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!AGENT_HARNESS_KEYS.has(key))
      throw new Error(`config.harness has unknown option "${key}"`);
  }
  if (
    typeof config.type !== "string" ||
    !AGENT_HARNESS_TYPES.includes(
      config.type as (typeof AGENT_HARNESS_TYPES)[number],
    )
  ) {
    throw new Error(
      `config.harness.type must be one of: ${AGENT_HARNESS_TYPES.join(", ")}`,
    );
  }
  assertOptionalEnum(
    config.permissionMode,
    "config.harness.permissionMode",
    AGENT_HARNESS_PERMISSION_MODES,
  );
  assertOptionalPositiveInteger(
    config.startupTimeoutMs,
    "config.harness.startupTimeoutMs",
    AGENT_HARNESS_STARTUP_TIMEOUT_LIMIT,
  );
  assertOptionalBoolean(config.webSearch, "config.harness.webSearch");
  assertOptionalStringArray(config.activeTools, "config.harness.activeTools");
  assertOptionalStringArray(
    config.inactiveTools,
    "config.harness.inactiveTools",
  );
  if (config.activeTools !== undefined && config.inactiveTools !== undefined) {
    throw new Error(
      "config.harness must use either activeTools or inactiveTools, not both",
    );
  }
  normalizeHarnessDebugConfig(config.debug);
  if (
    config.type === "codex" &&
    config.permissionMode !== undefined &&
    config.permissionMode !== "allow-all"
  ) {
    throw new Error(
      "config.harness.permissionMode must be allow-all for the codex harness",
    );
  }
  if (config.type !== "codex" && config.webSearch !== undefined) {
    throw new Error(
      "config.harness.webSearch is only supported by the codex harness",
    );
  }
  if (config.type === "pi" && config.startupTimeoutMs !== undefined) {
    throw new Error(
      "config.harness.startupTimeoutMs is not supported by the pi harness",
    );
  }
}

function normalizeHarnessDebugConfig(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value))
    throw new Error("config.harness.debug must be an object");
  for (const key of Object.keys(value)) {
    if (!AGENT_HARNESS_DEBUG_KEYS.has(key))
      throw new Error(`config.harness.debug has unknown option "${key}"`);
  }
  assertOptionalBoolean(value.enabled, "config.harness.debug.enabled");
  assertOptionalEnum(
    value.level,
    "config.harness.debug.level",
    AGENT_HARNESS_DEBUG_LEVELS,
  );
  assertOptionalStringArray(
    value.subsystems,
    "config.harness.debug.subsystems",
  );
}

function normalizeModelConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.model must be an object");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (
      !MODEL_CONFIG_SETTING_KEYS.includes(
        key as (typeof MODEL_CONFIG_SETTING_KEYS)[number],
      )
    ) {
      throw new Error(
        `config.model.${key} is not supported; use config.model.providerOptions for provider-specific settings`,
      );
    }
  }
  assertOptionalProviderName(config.provider, "config.model.provider");
  assertOptionalString(config.modelId, "config.model.modelId");
  assertOptionalEnum(config.reasoning, "config.model.reasoning", [
    "provider-default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  if (
    config.providerOptions !== undefined &&
    !isPlainObject(config.providerOptions)
  ) {
    throw new Error("config.model.providerOptions must be an object");
  }
  normalizeModelOutputConfig(config.output);
}

function normalizeModelOutputConfig(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value))
    throw new Error("config.model.output must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalEnum(config.type, "config.model.output.type", [
    "text",
    "object",
    "array",
    "choice",
    "json",
  ]);
  if (config.type === undefined)
    throw new Error(
      "config.model.output.type must be one of: text, object, array, choice, json",
    );
  assertOptionalString(config.name, "config.model.output.name");
  assertOptionalString(config.description, "config.model.output.description");
  if (config.type === "object" && !isPlainObject(config.schema))
    throw new Error("config.model.output.schema must be an object");
  if (config.type === "array" && !isPlainObject(config.element))
    throw new Error("config.model.output.element must be an object");
  if (
    config.type === "choice" &&
    (!Array.isArray(config.options) ||
      config.options.length === 0 ||
      !config.options.every((entry) => typeof entry === "string"))
  ) {
    throw new Error(
      "config.model.output.options must be a non-empty array of strings",
    );
  }
}

function normalizeProviderConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.provider must be an object");
  for (const [providerName, providerConfig] of Object.entries(value)) {
    if (!isAccountModelProviderName(providerName))
      throw new Error(
        `config.provider.${providerName} is not a supported provider`,
      );
    normalizeProviderSettings(providerName, providerConfig);
  }
}

function normalizeProviderSettings(
  providerName: AccountModelProviderName,
  value: unknown,
): void {
  if (!isPlainObject(value))
    throw new Error(`config.provider.${providerName} must be an object`);
  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiKey, `config.provider.${providerName}.apiKey`);
  assertOptionalString(
    config.base_url,
    `config.provider.${providerName}.base_url`,
  );
  assertOptionalString(
    config.baseURL,
    `config.provider.${providerName}.baseURL`,
  );
  const baseURL = providerBaseURL(config);
  if (providerName === "custom" && !baseURL) {
    const hint =
      config.baseUrl !== undefined
        ? ` (found "baseUrl" — use "base_url" or "baseURL")`
        : "";
    throw new Error(`config.provider.custom.base_url is required${hint}`);
  }
  if (baseURL) {
    const label = typeof config.base_url === "string" ? "base_url" : "baseURL";
    assertPublicHttpsUrl(baseURL, `config.provider.${providerName}.${label}`);
    // Canonicalize on `baseURL`: accepting both spellings but storing one
    // prevents a stale `base_url` (which core prefers at runtime) from
    // shadowing later `baseURL` updates.
    config.baseURL = baseURL;
    delete config.base_url;
  }
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    throw new Error(
      `config.provider.${providerName}.headers must be an object with string values`,
    );
  }
}

function providerBaseURL(config: Record<string, unknown>): string | undefined {
  const raw =
    typeof config.base_url === "string" ? config.base_url : config.baseURL;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();

  return trimmed || undefined;
}

function normalizeSandboxRef(value: unknown): void {
  assertOptionalNonEmptyString(value, "config.sandbox");
}

function normalizeWorkspaceRefs(value: unknown): void {
  if (value == null) return;
  if (!Array.isArray(value))
    throw new Error("config.workspaces must be an array");
  const seenNames = new Set<string>();
  value.forEach((entry, index) => {
    if (!isPlainObject(entry))
      throw new Error(`config.workspaces[${index}] must be an object`);
    const ref = entry as Record<string, unknown>;
    const name = ref.name;
    if (typeof name !== "string" || name.trim().length === 0)
      throw new Error(
        `config.workspaces[${index}].name must be a non-empty string`,
      );
    assertWorkspaceId(name, `config.workspaces[${index}].name`);
    assertOptionalString(
      ref.workspaceId,
      `config.workspaces[${index}].workspaceId`,
    );
    if (
      typeof ref.workspaceId !== "string" ||
      ref.workspaceId.trim().length === 0
    ) {
      throw new Error(
        `config.workspaces[${index}].workspaceId must be a non-empty string`,
      );
    }
    if (
      ref.sandbox !== null &&
      ref.sandbox !== undefined &&
      (typeof ref.sandbox !== "string" || ref.sandbox.trim().length === 0)
    ) {
      throw new Error(
        `config.workspaces[${index}].sandbox must be a non-empty string or null`,
      );
    }
    if (seenNames.has(name))
      throw new Error(
        `config.workspaces[${index}].name "${name}" is used more than once`,
      );
    seenNames.add(name);
  });
}

function normalizeSessionConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.session must be an object");
  const config = value as Record<string, unknown>;
  normalizeSessionPruningConfig(config.pruning);
  normalizeSessionCompactionConfig(config.compaction);
}

function normalizeSessionPruningConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.session.pruning must be an object");
  assertOptionalBoolean(value.enabled, "config.session.pruning.enabled");
}

function normalizeSessionCompactionConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.session.compaction must be an object");
  assertOptionalBoolean(value.enabled, "config.session.compaction.enabled");
  assertOptionalPositiveInteger(
    value.maxContextLength,
    "config.session.compaction.maxContextLength",
    SESSION_MAX_CONTEXT_LENGTH_LIMIT,
  );
}

function normalizeHooksConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.hooks must be an object");
  const config = value as Record<string, unknown>;
  if (config.webhooks !== undefined) {
    if (!Array.isArray(config.webhooks))
      throw new Error("config.hooks.webhooks must be an array");
    config.webhooks.forEach((webhook, index) =>
      normalizeWebhookHookConfig(webhook, `config.hooks.webhooks[${index}]`),
    );
  }
  if (config.code !== undefined) {
    if (!Array.isArray(config.code))
      throw new Error("config.hooks.code must be an array");
    config.code.forEach((hook, index) =>
      normalizeCodeHookConfig(hook, `config.hooks.code[${index}]`),
    );
  }
}

function normalizeCodeHookConfig(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const config = value as Record<string, unknown>;
  if (
    typeof config.hookId !== "string" ||
    !isNativeConvexDocumentId(config.hookId)
  ) {
    throw new Error(`${path}.hookId must be a native Convex document id`);
  }
  assertOptionalBoolean(config.enabled, `${path}.enabled`);
  if (
    config.events !== undefined &&
    (!Array.isArray(config.events) ||
      !config.events.every(
        (event) =>
          typeof event === "string" &&
          AGENT_HOOK_EVENT_NAMES.includes(event as AgentHookEventName),
      ))
  ) {
    throw new Error(
      `${path}.events must be an array of: ${AGENT_HOOK_EVENT_NAMES.join(", ")}`,
    );
  }
}

function normalizeWebhookHookConfig(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, `${path}.enabled`);
  assertOptionalNonEmptyString(config.url, `${path}.url`);
  assertOptionalNonEmptyString(config.secret, `${path}.secret`);
  if (
    config.events !== undefined &&
    (!Array.isArray(config.events) ||
      !config.events.every(
        (event) =>
          typeof event === "string" &&
          AGENT_LIFECYCLE_EVENT_NAMES.includes(
            event as (typeof AGENT_LIFECYCLE_EVENT_NAMES)[number],
          ),
      ))
  ) {
    throw new Error(
      `${path}.events must be an array of: ${AGENT_LIFECYCLE_EVENT_NAMES.join(", ")}`,
    );
  }
  if (config.enabled === true) {
    if (typeof config.url !== "string" || config.url.trim().length === 0)
      throw new Error(`${path}.url is required when ${path}.enabled is true`);
    if (typeof config.secret !== "string" || config.secret.trim().length === 0)
      throw new Error(
        `${path}.secret is required when ${path}.enabled is true`,
      );
  }
  if (typeof config.url === "string" && config.url.trim().length > 0)
    assertPublicHttpsUrl(config.url, `${path}.url`);
}

function normalizeToolsConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.tools must be an object");
  for (const [toolName, toolConfig] of Object.entries(value))
    normalizeToolConfig(toolName, toolConfig);
}

function normalizeToolConfig(toolName: string, value: unknown): void {
  if (!isPlainObject(value))
    throw new Error(`config.tools.${toolName} must be an object`);
  if (!isNativeConvexDocumentId(toolName) && !isProviderToolName(toolName)) {
    throw new Error(`config.tools.${toolName} is not a supported tool`);
  }
  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, `config.tools.${toolName}.enabled`);
  assertOptionalBoolean(
    config.needsApproval,
    `config.tools.${toolName}.needsApproval`,
  );
  assertOptionalBoolean(config.async, `config.tools.${toolName}.async`);
  if (config.config !== undefined && !isPlainObject(config.config))
    throw new Error(`config.tools.${toolName}.config must be an object`);
}

function normalizeSkillsConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.skills must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.skills.enabled");
  assertOptionalStringArray(config.allowed, "config.skills.allowed");
}

function normalizeSubagentConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.subagent must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.subagent.enabled");
  assertOptionalBoolean(config.stream, "config.subagent.stream");
  assertOptionalStringArray(config.allowed, "config.subagent.allowed");
  assertOptionalEnum(config.context, "config.subagent.context", [
    "new",
    "inherited",
  ]);
  assertOptionalEnum(config.mode, "config.subagent.mode", [
    "ephemeral",
    "persistent",
  ]);
  assertOptionalEnum(config.visibility, "config.subagent.visibility", [
    "full",
    "result",
    "none",
  ]);
}

function normalizeSchedulerConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.scheduler must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.scheduler.enabled");
}

/**
 * Validates the policy ids attached to an agent. Attachment is just the list:
 * how hard each one bites is carried by the policy document itself.
 */
function normalizePolicyIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  assertOptionalStringArray(value, "config.policies");
  const ids = [...new Set(value as string[])];

  return ids.length > 0 ? ids : undefined;
}

function normalizeChannelsConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels must be an object");
  const channels = value as Record<string, unknown>;
  normalizeTelegramConfig(channels.telegram);
  normalizeGitHubConfig(channels.github);
  normalizeSlackConfig(channels.slack);
  normalizeDiscordConfig(channels.discord);
  normalizePancakeConfig(channels.pancake);
  normalizeZaloConfig(channels.zalo);
}

function normalizeTelegramConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.telegram must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.telegram");
  assertOptionalString(config.apiUrl, "config.channels.telegram.apiUrl");
  assertOptionalString(config.botToken, "config.channels.telegram.botToken");
  assertOptionalString(
    config.webhookSecret,
    "config.channels.telegram.webhookSecret",
  );
  assertOptionalString(
    config.botUsername,
    "config.channels.telegram.botUsername",
  );
  assertOptionalString(
    config.reactionEmoji,
    "config.channels.telegram.reactionEmoji",
  );
}

function normalizeGitHubConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.github must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.github");
  assertOptionalString(config.apiUrl, "config.channels.github.apiUrl");
  assertOptionalString(
    config.webhookSecret,
    "config.channels.github.webhookSecret",
  );
  assertOptionalString(config.appId, "config.channels.github.appId");
  assertOptionalString(config.privateKey, "config.channels.github.privateKey");
  assertOptionalString(
    config.botUserName,
    "config.channels.github.botUserName",
  );
  assertOptionalPositiveInteger(
    config.botUserId,
    "config.channels.github.botUserId",
    Number.MAX_SAFE_INTEGER,
  );
}

function normalizeSlackConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.slack must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.slack");
  assertOptionalString(config.apiUrl, "config.channels.slack.apiUrl");
  assertOptionalString(config.botToken, "config.channels.slack.botToken");
  assertOptionalString(
    config.signingSecret,
    "config.channels.slack.signingSecret",
  );
  assertOptionalString(
    config.reactionEmoji,
    "config.channels.slack.reactionEmoji",
  );
}

function normalizeDiscordConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.discord must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.discord");
  assertOptionalString(config.apiUrl, "config.channels.discord.apiUrl");
  assertOptionalString(config.botToken, "config.channels.discord.botToken");
  assertOptionalString(config.publicKey, "config.channels.discord.publicKey");
}

function normalizePancakeConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.pancake must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.pancake");
  assertOptionalString(config.pageId, "config.channels.pancake.pageId");
  assertOptionalString(
    config.pageAccessToken,
    "config.channels.pancake.pageAccessToken",
  );
  assertOptionalString(
    config.webhookSecret,
    "config.channels.pancake.webhookSecret",
  );
  assertOptionalString(config.senderId, "config.channels.pancake.senderId");
}

function normalizeZaloConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value))
    throw new Error("config.channels.zalo must be an object");
  const config = value as Record<string, unknown>;
  normalizeChannelIdentityConfig(config, "config.channels.zalo");
  assertOptionalString(config.botToken, "config.channels.zalo.botToken");
  assertOptionalString(
    config.webhookSecret,
    "config.channels.zalo.webhookSecret",
  );
  if (typeof config.webhookSecret === "string") {
    const length = config.webhookSecret.length;
    if (length < 8 || length > 256)
      throw new Error(
        "config.channels.zalo.webhookSecret must be 8 to 256 characters",
      );
  }
}

function normalizeChannelIdentityConfig(
  config: Record<string, unknown>,
  name: string,
): void {
  normalizeRequiredString(config.id, `${name}.id`);
  assertOptionalEnum(config.trace, `${name}.trace`, [
    "enabled",
    "disabled",
  ] as const);
  for (const [retired, replacement] of RETIRED_REACH_KEYS) {
    if (config[retired] !== undefined)
      throw new Error(
        `${name}.${retired} is no longer supported; use ${name}.${replacement}`,
      );
  }
  assertOptionalStringArray(
    config.allowedChannelIds,
    `${name}.allowedChannelIds`,
  );
  assertOptionalStringArray(config.allowedUserIds, `${name}.allowedUserIds`);
  for (const retired of RETIRED_PARTITION_KEYS) {
    if (config[retired] !== undefined)
      throw new Error(
        `${name}.${retired} is no longer supported; use ${name}.partition`,
      );
  }
  if (config.partition === undefined) return;
  if (!isPlainObject(config.partition))
    throw new Error(`${name}.partition must be an object`);
  const partition = config.partition as Record<string, unknown>;
  assertOptionalEnum(
    partition.by,
    `${name}.partition.by`,
    CHANNEL_PARTITION_MODES,
  );
  if (partition.by === undefined)
    throw new Error(
      `${name}.partition.by must be one of: ${CHANNEL_PARTITION_MODES.join(", ")}`,
    );
  if (partition.by === "shared") {
    if ("alias" in partition && partition.alias !== undefined) {
      throw new Error(
        `${name}.partition.alias is only supported when ${name}.partition.by is conversation`,
      );
    }

    return;
  }
  normalizeRequiredString(partition.alias, `${name}.partition.alias`);
  assertPartitionAlias(partition.alias, `${name}.partition.alias`);
}

function validateConfigPatch(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const candidate = value as Record<string, unknown>;
  const withoutNulls = removeNullConfigValues(candidate);
  if (path === "config") {
    normalizeAgentConfig(withoutNulls);

    return;
  }
}

function removeNullConfigValues(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (entry === null) return [];
      if (isPlainObject(entry)) return [[key, removeNullConfigValues(entry)]];

      return [[key, entry]];
    }),
  );
}

function assertPublicHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  if (isPrivateHostname(url.hostname))
    throw new Error(`${label} must not point to a private or internal address`);

  return url;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  }
  if (host.includes(":")) return isPrivateIpv6(host);

  return false;
}

/** Loopback/private/link-local/CGNAT IPv4, judged from the first two octets. */
function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Unspecified/loopback/v4-mapped/ULA/link-local IPv6 (host already lowercased, unbracketed). */
function isPrivateIpv6(host: string): boolean {
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    /^f[cd]/.test(host) ||
    /^fe[89ab]/.test(host)
  );
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string")
    throw new Error(`${name} must be a string`);
}

function assertOptionalProviderName(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !isAccountModelProviderName(value)) {
    throw new Error(
      `${name} must be one of: ${ACCOUNT_MODEL_PROVIDER_NAMES.join(", ")}`,
    );
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} must be a boolean`);
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !allowed.includes(value as T))
  ) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);

  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
  assertOptionalString(value, name);
  if (typeof value === "string" && value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
}

function assertWorkspaceId(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value))
    throw new Error(
      `${name} must use only letters, numbers, dots, underscores, or hyphens`,
    );
}

function assertPartitionAlias(value: unknown, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `${name} must use only letters, numbers, dots, underscores, or hyphens`,
    );
  }
}

function assertOptionalPositiveInteger(
  value: unknown,
  name: string,
  max: number,
): void {
  if (value === undefined) return;
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
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
}

// Provider-defined tool names are validated for shape only; whether the
// configured provider actually ships the tool is resolved by core at run time.
function isProviderToolName(toolName: string): boolean {
  return (
    PROVIDER_TOOL_NAME_PATTERN.test(toolName) &&
    !toolName.startsWith(DEPRECATED_TOOL_ID_PREFIX) &&
    !RESERVED_HARNESS_TOOL_NAMES.has(toolName)
  );
}

function isNativeConvexDocumentId(value: string): boolean {
  return /^[a-z0-9]{20,}$/.test(value);
}

function requireAgentStatus(value: unknown): AgentStatus {
  if (value !== "active" && value !== "disabled")
    throw new Error("status must be one of: active, disabled");

  return value;
}

/**
 * Agent config validation and public projections for Convex config HTTP.
 * Pure module: safe for the default Convex runtime.
 */

import { mergeConfigObjects, redactConfigSecrets } from "./configValues";
import { isPlainObject, isStringRecord } from "./objects";
import { AGENT_HOOK_EVENT_NAMES, type AgentHookEventName } from "./accountHooks";

export type AgentStatus = "active" | "disabled";
export type AccountModelProviderName = "google" | "openai" | "anthropic" | "bedrock" | "gateway" | "minimax" | "custom";

export type AgentConfig = Record<string, unknown> & {
    agent?: Record<string, unknown>;
    model?: Record<string, unknown>;
    provider?: Partial<Record<AccountModelProviderName, Record<string, unknown>>>;
    sandbox?: string;
    workspaces?: AgentWorkspaceRef[];
    session?: Record<string, unknown>;
    hooks?: Record<string, unknown>;
    channels?: Record<string, unknown>;
    tools?: Record<string, unknown>;
    skills?: { enabled?: boolean; allowed?: string[]; [key: string]: unknown };
    subagent?: { enabled?: boolean; allowed?: string[]; context?: "new" | "inherited"; mode?: "ephemeral" | "persistent"; [key: string]: unknown };
    policy?: AgentPolicyConfig;
    publicAccess?: boolean;
};

export interface AgentWorkspaceRef {
    name: string;
    workspaceId: string;
    sandbox?: string | null;
}

export interface AgentPolicyConfig {
    policyIds?: string[];
    mode?: "enforce" | "audit";
}

interface AgentDocLike {
    _id: string;
    accountId: string;
    name: string;
    description?: string;
    createdAt: number;
    updatedAt: number;
}

const AGENT_MAX_TURN_LIMIT = 100;
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 500_000;
const CHANNEL_WORKSPACE_SCOPE_LEVELS = ["channel", "conversation"] as const;
const ACCOUNT_MODEL_PROVIDER_NAMES = ["google", "openai", "anthropic", "bedrock", "gateway", "minimax", "custom"] as const;
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
    const policy = normalizeAgentPolicyConfig(config.policy);
    if (policy) {
        config.policy = policy;
    } else {
        delete config.policy;
    }
    assertOptionalBoolean(config.publicAccess, "config.publicAccess");

    return config;
}

/**
 * Validate a partial config patch, preserving null deletes for merge time.
 * @param value patch value
 * @returns the original patch object
 */
export function normalizeAgentConfigPatch(value: unknown): Record<string, unknown> {
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
export function mergeAgentConfig(existing: AgentConfig, patch: Record<string, unknown>): AgentConfig {
    return normalizeAgentConfig(mergeConfigObjects(existing, patch));
}

/**
 * Redact secret-shaped config values for public responses.
 * @param config normalized config
 * @returns redacted config
 */
export function redactAgentConfig(config: AgentConfig): AgentConfig {
    return redactConfigSecrets(config);
}

/**
 * Normalize input for POST /v1/agents.
 * @param value request body
 * @returns normalized create input
 */
export function normalizeCreateAgentInput(value: unknown): { name: string; description?: string; config: AgentConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    const name = requireString(value.name, "name");
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
): { name?: string; description?: string | null; status?: AgentStatus; config: AgentConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");

    const config = "config" in value
        ? mergeAgentConfig(existingConfig, normalizeAgentConfigPatch(value.config))
        : existingConfig;

    return {
        ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
        ...(value.description !== undefined
            ? { description: value.description === null ? null : optionalString(value.description, "description") }
            : {}),
        ...(value.status !== undefined ? { status: requireAgentStatus(value.status) } : {}),
        config: config,
    };
}

/**
 * Project an agent document and decrypted config to the public API shape.
 * @param doc agent row
 * @param config decrypted config
 * @returns public agent response
 */
export function toPublicAgentResponse(doc: AgentDocLike, config: AgentConfig): Record<string, unknown> {
    return {
        accountId: doc.accountId,
        agentId: doc._id,
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        status: "active",
        config: redactAgentConfig(config),
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}

function normalizeAgentBehaviorConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.agent must be an object");
    const config = value as Record<string, unknown>;
    assertOptionalPositiveInteger(config.maxTurn, "config.agent.maxTurn", AGENT_MAX_TURN_LIMIT);
    validateAgentSystemConfig(config.system);
}

function validateAgentSystemConfig(value: unknown): void {
    if (value === undefined || typeof value === "string") return;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
        if (!isPlainObject(entry) || entry.role !== "system" || typeof entry.content !== "string") {
            throw new Error("config.agent.system must be a string, SystemModelMessage, or SystemModelMessage[]: invalid system message");
        }
    }
}

function normalizeModelConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.model must be an object");
    const config = value as Record<string, unknown>;
    for (const key of Object.keys(config)) {
        if (!MODEL_CONFIG_SETTING_KEYS.includes(key as (typeof MODEL_CONFIG_SETTING_KEYS)[number])) {
            throw new Error(`config.model.${key} is not supported; use config.model.providerOptions for provider-specific settings`);
        }
    }
    assertOptionalProviderName(config.provider, "config.model.provider");
    assertOptionalString(config.modelId, "config.model.modelId");
    assertOptionalEnum(config.reasoning, "config.model.reasoning", ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]);
    if (config.providerOptions !== undefined && !isPlainObject(config.providerOptions)) {
        throw new Error("config.model.providerOptions must be an object");
    }
    normalizeModelOutputConfig(config.output);
}

function normalizeModelOutputConfig(value: unknown): void {
    if (value === undefined) return;
    if (!isPlainObject(value)) throw new Error("config.model.output must be an object");
    const config = value as Record<string, unknown>;
    assertOptionalEnum(config.type, "config.model.output.type", ["text", "object", "array", "choice", "json"]);
    if (config.type === undefined) throw new Error("config.model.output.type must be one of: text, object, array, choice, json");
    assertOptionalString(config.name, "config.model.output.name");
    assertOptionalString(config.description, "config.model.output.description");
    if (config.type === "object" && !isPlainObject(config.schema)) throw new Error("config.model.output.schema must be an object");
    if (config.type === "array" && !isPlainObject(config.element)) throw new Error("config.model.output.element must be an object");
    if (
        config.type === "choice" &&
        (!Array.isArray(config.options) || config.options.length === 0 || !config.options.every((entry) => typeof entry === "string"))
    ) {
        throw new Error("config.model.output.options must be a non-empty array of strings");
    }
}

function normalizeProviderConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.provider must be an object");
    for (const [providerName, providerConfig] of Object.entries(value)) {
        if (!isAccountModelProviderName(providerName)) throw new Error(`config.provider.${providerName} is not a supported provider`);
        normalizeProviderSettings(providerName, providerConfig);
    }
}

function normalizeProviderSettings(providerName: AccountModelProviderName, value: unknown): void {
    if (!isPlainObject(value)) throw new Error(`config.provider.${providerName} must be an object`);
    const config = value as Record<string, unknown>;
    assertOptionalString(config.apiKey, `config.provider.${providerName}.apiKey`);
    assertOptionalString(config.base_url, `config.provider.${providerName}.base_url`);
    assertOptionalString(config.baseURL, `config.provider.${providerName}.baseURL`);
    const baseURL = providerBaseURL(config);
    if (providerName === "custom" && !baseURL) {
        const hint = config.baseUrl !== undefined ? ` (found "baseUrl" — use "base_url" or "baseURL")` : "";
        throw new Error(`config.provider.custom.base_url is required${hint}`);
    }
    if (baseURL) {
        const label = typeof config.base_url === "string" ? "base_url" : "baseURL";
        assertPublicHttpsUrl(baseURL, `config.provider.${providerName}.${label}`);
        config.baseURL = baseURL;
    }
    if (config.headers !== undefined && !isStringRecord(config.headers)) {
        throw new Error(`config.provider.${providerName}.headers must be an object with string values`);
    }
    if (providerName === "openai" || providerName === "custom") {
        assertOptionalString(config.organization, `config.provider.${providerName}.organization`);
        assertOptionalString(config.project, `config.provider.${providerName}.project`);
        assertOptionalString(config.name, `config.provider.${providerName}.name`);
    }
    if (providerName === "bedrock") {
        assertOptionalString(config.region, "config.provider.bedrock.region");
        assertOptionalString(config.accessKeyId, "config.provider.bedrock.accessKeyId");
        assertOptionalString(config.secretAccessKey, "config.provider.bedrock.secretAccessKey");
        assertOptionalString(config.sessionToken, "config.provider.bedrock.sessionToken");
    }
}

function providerBaseURL(config: Record<string, unknown>): string | undefined {
    const raw = typeof config.base_url === "string" ? config.base_url : config.baseURL;
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();

    return trimmed || undefined;
}

function normalizeSandboxRef(value: unknown): void {
    assertOptionalNonEmptyString(value, "config.sandbox");
}

function normalizeWorkspaceRefs(value: unknown): void {
    if (value == null) return;
    if (!Array.isArray(value)) throw new Error("config.workspaces must be an array");
    const seenNames = new Set<string>();
    value.forEach((entry, index) => {
        if (!isPlainObject(entry)) throw new Error(`config.workspaces[${index}] must be an object`);
        const ref = entry as Record<string, unknown>;
        const name = ref.name;
        if (typeof name !== "string" || name.trim().length === 0) throw new Error(`config.workspaces[${index}].name must be a non-empty string`);
        assertWorkspaceId(name, `config.workspaces[${index}].name`);
        assertOptionalString(ref.workspaceId, `config.workspaces[${index}].workspaceId`);
        if (typeof ref.workspaceId !== "string" || ref.workspaceId.trim().length === 0) {
            throw new Error(`config.workspaces[${index}].workspaceId must be a non-empty string`);
        }
        if (ref.sandbox !== null && ref.sandbox !== undefined && (typeof ref.sandbox !== "string" || ref.sandbox.trim().length === 0)) {
            throw new Error(`config.workspaces[${index}].sandbox must be a non-empty string or null`);
        }
        if (seenNames.has(name)) throw new Error(`config.workspaces[${index}].name "${name}" is used more than once`);
        seenNames.add(name);
    });
}

function normalizeSessionConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.session must be an object");
    const config = value as Record<string, unknown>;
    normalizeSessionPruningConfig(config.pruning);
    normalizeSessionCompactionConfig(config.compaction);
}

function normalizeSessionPruningConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.session.pruning must be an object");
    assertOptionalBoolean(value.enabled, "config.session.pruning.enabled");
}

function normalizeSessionCompactionConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.session.compaction must be an object");
    assertOptionalBoolean(value.enabled, "config.session.compaction.enabled");
    assertOptionalPositiveInteger(value.maxContextLength, "config.session.compaction.maxContextLength", SESSION_MAX_CONTEXT_LENGTH_LIMIT);
}

function normalizeHooksConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.hooks must be an object");
    const config = value as Record<string, unknown>;
    if (config.webhooks !== undefined) {
        if (!Array.isArray(config.webhooks)) throw new Error("config.hooks.webhooks must be an array");
        config.webhooks.forEach((webhook, index) => normalizeWebhookHookConfig(webhook, `config.hooks.webhooks[${index}]`));
    }
    if (config.code !== undefined) {
        if (!Array.isArray(config.code)) throw new Error("config.hooks.code must be an array");
        config.code.forEach((hook, index) => normalizeCodeHookConfig(hook, `config.hooks.code[${index}]`));
    }
}

function normalizeCodeHookConfig(value: unknown, path: string): void {
    if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
    const config = value as Record<string, unknown>;
    if (typeof config.hookId !== "string" || config.hookId.trim().length === 0) {
        throw new Error(`${path}.hookId is required`);
    }
    assertOptionalBoolean(config.enabled, `${path}.enabled`);
    if (
        config.events !== undefined &&
        (!Array.isArray(config.events) || !config.events.every((event) =>
            typeof event === "string" && AGENT_HOOK_EVENT_NAMES.includes(event as AgentHookEventName)
        ))
    ) {
        throw new Error(`${path}.events must be an array of: ${AGENT_HOOK_EVENT_NAMES.join(", ")}`);
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
        (!Array.isArray(config.events) || !config.events.every((event) =>
            typeof event === "string" && AGENT_LIFECYCLE_EVENT_NAMES.includes(event as (typeof AGENT_LIFECYCLE_EVENT_NAMES)[number])
        ))
    ) {
        throw new Error(`${path}.events must be an array of: ${AGENT_LIFECYCLE_EVENT_NAMES.join(", ")}`);
    }
    if (config.enabled === true) {
        if (typeof config.url !== "string" || config.url.trim().length === 0) throw new Error(`${path}.url is required when ${path}.enabled is true`);
        if (typeof config.secret !== "string" || config.secret.trim().length === 0) throw new Error(`${path}.secret is required when ${path}.enabled is true`);
    }
    if (typeof config.url === "string" && config.url.trim().length > 0) assertPublicHttpsUrl(config.url, `${path}.url`);
}

function normalizeToolsConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.tools must be an object");
    for (const [toolName, toolConfig] of Object.entries(value)) normalizeToolConfig(toolName, toolConfig);
}

function normalizeToolConfig(toolName: string, value: unknown): void {
    if (!isPlainObject(value)) throw new Error(`config.tools.${toolName} must be an object`);
    if (!isSupportedConfigToolName(toolName) && !isAccountToolId(toolName)) {
        throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
    const config = value as Record<string, unknown>;
    assertOptionalBoolean(config.enabled, `config.tools.${toolName}.enabled`);
    assertOptionalBoolean(config.needsApproval, `config.tools.${toolName}.needsApproval`);
    assertOptionalBoolean(config.async, `config.tools.${toolName}.async`);
    if (config.config !== undefined && !isPlainObject(config.config)) throw new Error(`config.tools.${toolName}.config must be an object`);
    if (isAccountToolId(toolName)) return;
    if (toolName === "tavilySearch") normalizeTavilySearchToolConfig(config);
    if (toolName === "tavilyExtract") normalizeTavilyExtractToolConfig(config);
    if (toolName === "googleSearch") normalizeGoogleSearchToolConfig(config);
    if (toolName === "handoffs") normalizeHandoffsToolConfig(config);
}

function normalizeHandoffsToolConfig(config: Record<string, unknown>): void {
    if (config.enabled === false) return;
    if (!isPlainObject(config.pancake)) throw new Error("config.tools.handoffs.pancake is required");
    const pancake = config.pancake;
    if (!isPlainObject(pancake.scenarioTagIds)) throw new Error("config.tools.handoffs.pancake.scenarioTagIds is required");
    assertOptionalNonEmptyString(pancake.scenarioTagIds.order, "config.tools.handoffs.pancake.scenarioTagIds.order");
    assertOptionalNonEmptyString(pancake.scenarioTagIds.pending, "config.tools.handoffs.pancake.scenarioTagIds.pending");
    if (!pancake.scenarioTagIds.order) throw new Error("config.tools.handoffs.pancake.scenarioTagIds.order is required");
    if (!pancake.scenarioTagIds.pending) throw new Error("config.tools.handoffs.pancake.scenarioTagIds.pending is required");
    if (!isPlainObject(config.zalo)) throw new Error("config.tools.handoffs.zalo is required");
    const zalo = config.zalo;
    assertOptionalNonEmptyString(zalo.botToken, "config.tools.handoffs.zalo.botToken");
    if (!zalo.botToken) throw new Error("config.tools.handoffs.zalo.botToken is required");
    assertRequiredNonEmptyStringArray(zalo.notifyUserIds, "config.tools.handoffs.zalo.notifyUserIds");
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
        if (!isPlainObject(config.searchTypes)) throw new Error("config.tools.googleSearch.searchTypes must be an object");
        const searchTypes = config.searchTypes as Record<string, unknown>;
        if (searchTypes.webSearch !== undefined && !isPlainObject(searchTypes.webSearch)) {
            throw new Error("config.tools.googleSearch.searchTypes.webSearch must be an object");
        }
        if (searchTypes.imageSearch !== undefined && !isPlainObject(searchTypes.imageSearch)) {
            throw new Error("config.tools.googleSearch.searchTypes.imageSearch must be an object");
        }
    }
    if (config.timeRangeFilter !== undefined) {
        if (!isPlainObject(config.timeRangeFilter)) throw new Error("config.tools.googleSearch.timeRangeFilter must be an object");
        const timeRangeFilter = config.timeRangeFilter as Record<string, unknown>;
        assertOptionalString(timeRangeFilter.startTime, "config.tools.googleSearch.timeRangeFilter.startTime");
        assertOptionalString(timeRangeFilter.endTime, "config.tools.googleSearch.timeRangeFilter.endTime");
    }
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
    if (!isPlainObject(value)) throw new Error("config.subagent must be an object");
    const config = value as Record<string, unknown>;
    assertOptionalBoolean(config.enabled, "config.subagent.enabled");
    assertOptionalStringArray(config.allowed, "config.subagent.allowed");
    assertOptionalEnum(config.context, "config.subagent.context", ["new", "inherited"]);
    assertOptionalEnum(config.mode, "config.subagent.mode", ["ephemeral", "persistent"]);
}

function normalizeAgentPolicyConfig(value: unknown): AgentPolicyConfig | undefined {
    if (value == null) return undefined;
    if (!isPlainObject(value)) throw new Error("config.policy must be an object");
    const config = value as Record<string, unknown>;
    for (const key of Object.keys(config)) {
        if (key !== "enabled" && key !== "policyIds" && key !== "mode") throw new Error(`config.policy.${key} is not supported`);
    }
    assertOptionalBoolean(config.enabled, "config.policy.enabled");
    assertOptionalStringArray(config.policyIds, "config.policy.policyIds");
    assertOptionalEnum(config.mode, "config.policy.mode", ["enforce", "audit"]);
    const normalized = {
        ...(Array.isArray(config.policyIds) && config.policyIds.length > 0 ? { policyIds: config.policyIds as string[] } : {}),
        ...(config.mode !== undefined ? { mode: config.mode as "enforce" | "audit" } : {}),
    };

    return normalized.policyIds ? normalized : undefined;
}

function normalizeChannelsConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.channels must be an object");
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
    if (!isPlainObject(value)) throw new Error("config.channels.telegram must be an object");
    const config = value as Record<string, unknown>;
    normalizeChannelIdentityConfig(config, "config.channels.telegram");
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
    normalizeChannelIdentityConfig(config, "config.channels.github");
    assertOptionalString(config.apiUrl, "config.channels.github.apiUrl");
    assertOptionalString(config.webhookSecret, "config.channels.github.webhookSecret");
    assertOptionalString(config.appId, "config.channels.github.appId");
    assertOptionalString(config.privateKey, "config.channels.github.privateKey");
    assertOptionalStringArray(config.allowedRepos, "config.channels.github.allowedRepos");
    assertOptionalString(config.userName, "config.channels.github.userName");
    assertOptionalPositiveInteger(config.botUserId, "config.channels.github.botUserId", Number.MAX_SAFE_INTEGER);
}

function normalizeSlackConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.channels.slack must be an object");
    const config = value as Record<string, unknown>;
    normalizeChannelIdentityConfig(config, "config.channels.slack");
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
    normalizeChannelIdentityConfig(config, "config.channels.discord");
    assertOptionalString(config.apiUrl, "config.channels.discord.apiUrl");
    assertOptionalString(config.botToken, "config.channels.discord.botToken");
    assertOptionalString(config.publicKey, "config.channels.discord.publicKey");
    assertOptionalStringArray(config.allowedGuildIds, "config.channels.discord.allowedGuildIds");
}

function normalizePancakeConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.channels.pancake must be an object");
    const config = value as Record<string, unknown>;
    normalizeChannelIdentityConfig(config, "config.channels.pancake");
    assertOptionalString(config.pageId, "config.channels.pancake.pageId");
    assertOptionalString(config.pageAccessToken, "config.channels.pancake.pageAccessToken");
    assertOptionalString(config.webhookSecret, "config.channels.pancake.webhookSecret");
    assertOptionalString(config.senderId, "config.channels.pancake.senderId");
}

function normalizeZaloConfig(value: unknown): void {
    if (value == null) return;
    if (!isPlainObject(value)) throw new Error("config.channels.zalo must be an object");
    const config = value as Record<string, unknown>;
    normalizeChannelIdentityConfig(config, "config.channels.zalo");
    assertOptionalString(config.botToken, "config.channels.zalo.botToken");
    assertOptionalString(config.webhookSecret, "config.channels.zalo.webhookSecret");
    assertOptionalStringArray(config.allowedUserIds, "config.channels.zalo.allowedUserIds");
    if (typeof config.webhookSecret === "string") {
        const length = config.webhookSecret.length;
        if (length < 8 || length > 256) throw new Error("config.channels.zalo.webhookSecret must be 8 to 256 characters");
    }
}

function normalizeChannelIdentityConfig(config: Record<string, unknown>, name: string): void {
    normalizeRequiredString(config.id, `${name}.id`);
    if (config.workspaceIsolationScope !== undefined) {
        throw new Error(`${name}.workspaceIsolationScope is no longer supported; use ${name}.workspaceScope`);
    }
    if (config.workspaceScope === undefined) return;
    if (!isPlainObject(config.workspaceScope)) throw new Error(`${name}.workspaceScope must be an object`);
    const workspaceScope = config.workspaceScope as Record<string, unknown>;
    assertOptionalEnum(workspaceScope.level, `${name}.workspaceScope.level`, CHANNEL_WORKSPACE_SCOPE_LEVELS);
    if (workspaceScope.level === undefined) throw new Error(`${name}.workspaceScope.level must be one of: ${CHANNEL_WORKSPACE_SCOPE_LEVELS.join(", ")}`);
    if (workspaceScope.level === "channel") {
        if ("alias" in workspaceScope && workspaceScope.alias !== undefined) {
            throw new Error(`${name}.workspaceScope.alias is only supported when ${name}.workspaceScope.level is conversation`);
        }
        return;
    }
    normalizeRequiredString(workspaceScope.alias, `${name}.workspaceScope.alias`);
    assertWorkspaceScopeAlias(workspaceScope.alias, `${name}.workspaceScope.alias`);
}

function validateConfigPatch(value: unknown, path: string): void {
    if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
    const candidate = value as Record<string, unknown>;
    const withoutNulls = removeNullConfigValues(candidate);
    if (path === "config") {
        normalizeAgentConfig(withoutNulls);
        return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
        if (entry == null || Array.isArray(entry) || !isPlainObject(entry)) continue;
        validateConfigPatch(entry, `${path}.${key}`);
    }
}

function removeNullConfigValues(value: Record<string, unknown>): Record<string, unknown> {
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
    if (isPrivateHostname(url.hostname)) throw new Error(`${label} must not point to a private or internal address`);

    return url;
}

function isPrivateHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        return a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168);
    }
    if (host.includes(":")) return host === "::" || host === "::1" || host.startsWith("::ffff:") || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);

    return false;
}

function assertOptionalString(value: unknown, name: string): void {
    if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string`);
}

function assertOptionalProviderName(value: unknown, name: string): void {
    if (value === undefined) return;
    if (typeof value !== "string" || !isAccountModelProviderName(value)) {
        throw new Error(`${name} must be one of: ${ACCOUNT_MODEL_PROVIDER_NAMES.join(", ")}`);
    }
}

function assertOptionalBoolean(value: unknown, name: string): void {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
        throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
    }
}

function normalizeRequiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);

    return value.trim();
}

function requireString(value: unknown, name: string): string {
    return normalizeRequiredString(value, name);
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
    assertOptionalString(value, name);
    if (typeof value === "string" && value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}

function assertWorkspaceId(value: string, name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${name} must use only letters, numbers, dots, underscores, or hyphens`);
}

function assertWorkspaceScopeAlias(value: unknown, name: string): void {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error(`${name} must use only letters, numbers, dots, underscores, or hyphens`);
    }
}

function assertOptionalPositiveInteger(value: unknown, name: string, max: number): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
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
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${name} must be an array of strings`);
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

function isAccountModelProviderName(value: string): value is AccountModelProviderName {
    return ACCOUNT_MODEL_PROVIDER_NAMES.includes(value as AccountModelProviderName);
}

function isSupportedConfigToolName(toolName: string): boolean {
    return toolName === "tavilySearch" || toolName === "tavilyExtract" || toolName === "googleSearch" || toolName === "handoffs";
}

function isAccountToolId(toolName: string): boolean {
    return /^tool_[A-Za-z0-9_-]+$/.test(toolName) || /^[a-z0-9]{32}$/.test(toolName);
}

function requireAgentStatus(value: unknown): AgentStatus {
    if (value !== "active" && value !== "disabled") throw new Error("status must be one of: active, disabled");

    return value;
}

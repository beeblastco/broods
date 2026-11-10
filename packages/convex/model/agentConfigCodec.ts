// The only copy: Convex cannot import the Next.js app, so the dashboard re-exports this one.

import { v, type Infer, type Value } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { ACCOUNT_ENV_PLACEHOLDER_PATTERN } from "./envRefs";
import { ClientError } from "./clientError";
import { configObject, parseOr } from "./storedJson";

const ACCOUNT_ENV_PLACEHOLDER_PATTERN_G = new RegExp(
  ACCOUNT_ENV_PLACEHOLDER_PATTERN.source,
  "g",
);
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ENV_PLACEHOLDER_PATTERN_G = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// `undefined` too: the agent card has always counted an untyped output as structured.
const STRUCTURED_OUTPUT_TYPES = new Set<Value | undefined>([
  undefined,
  "json_schema",
  "object",
  "array",
  "choice",
  "json",
]);

// A branch missing here is dropped from extraConfig: the next push stores the agent without it.
const NESTED_BRANCHES: readonly (keyof StoredExtraConfig)[] = [
  "agent",
  "harness",
  "model",
  "provider",
  "sandboxes",
  "workspaces",
  "session",
  "hooks",
  "channels",
  "tools",
  "mcp",
  "denyTools",
  "skills",
  "subagent",
  "scheduler",
  "browser",
  "policies",
];

// Here, not in agentRules: the dashboard bundles this file and must not pull in the rules.
export const POLICY_REMOVED_MESSAGE =
  "config.policy is no longer supported; use config.policies, and set mode on the policy itself";
export const SANDBOX_REMOVED_MESSAGE =
  "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default";

const REMOVED_BRANCH_HINTS: Record<string, string> = {
  policy: POLICY_REMOVED_MESSAGE,
  sandbox: SANDBOX_REMOVED_MESSAGE,
  workspace:
    'config.workspace is no longer supported; reference workspace records instead with config.workspaces: [{ name, workspaceId }] and set the agent machine with config.sandboxes: ["sb_…"]',
};

type AgentConfigDoc = Doc<"agentConfigs">;
type StoredExtraConfig = NonNullable<AgentConfigDoc["extraConfig"]>;

export interface FlatAgentConfig {
  name?: string;
  description?: string;
  provider?: string;
  modelId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  allowedTools?: string[];
  permissionMode?: string;
  outputFormat?: AgentConfigDoc["outputFormat"];
  providerOptions?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  memoryToolEnabled?: boolean;
  searchToolEnabled?: boolean;
  searchToolConfig?: Record<string, unknown>;
  extraConfig?: AgentConfigDoc["extraConfig"];
}

export interface FlatPatch {
  provider?: string;
  modelId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: Record<string, unknown>;
  outputFormat?: AgentConfigDoc["outputFormat"];
  memoryToolEnabled?: boolean;
  searchToolEnabled?: boolean;
  searchToolConfig?: Record<string, unknown>;
  extraConfig?: StoredExtraConfig;
}

export type NestedAgentConfig = Record<string, unknown>;

/** The bits of one agent config its canvas card and its skill cards draw. */
export const agentCanvasBadgeValidator = v.object({
  // Callers need no runtime key, so the card's globe shows green.
  publicAccess: v.boolean(),
  // Skill refs the agent loads: `skills.allowed` while skills are on, else none.
  skills: v.array(v.string()),
  // The model answers with data instead of text.
  structuredOutput: v.boolean(),
});

export type AgentCanvasBadge = Infer<typeof agentCanvasBadgeValidator>;

// Shared by the badges query and the optimistic update, so the server's answer matches it.
export function agentCanvasBadge(
  config: Pick<AgentConfigDoc, "extraConfig" | "outputFormat">,
): AgentCanvasBadge {
  const { extraConfig, outputFormat } = config;
  const skills = extraConfig?.skills;
  // The column checks shape only: a hand-edited list can still hold a non-string entry.
  const allowed = skills?.enabled === true ? skills.allowed : [];

  return {
    publicAccess: extraConfig?.publicAccess === true,
    skills: Array.isArray(allowed)
      ? allowed.filter((ref): ref is string => typeof ref === "string")
      : [],
    structuredOutput:
      outputFormat !== undefined &&
      STRUCTURED_OUTPUT_TYPES.has(outputFormat.type),
  };
}

export function assertEnvVarName(name: string): void {
  if (!ENV_VAR_NAME_PATTERN.test(name) || name.length > 64) {
    throw new ClientError(
      `env name must match ${ENV_VAR_NAME_PATTERN} and be at most 64 characters`,
    );
  }
}

export function collectEnvPlaceholderNames(
  value: unknown,
  names = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(ACCOUNT_ENV_PLACEHOLDER_PATTERN_G)) {
      if (match[1]) names.add(match[1]);
    }

    return names;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvPlaceholderNames(item, names);

    return names;
  }
  if (typeof value === "object" && value !== null) {
    const items: unknown[] = Object.values(value);
    for (const item of items) collectEnvPlaceholderNames(item, names);
  }

  return names;
}

export function fromNestedAgentConfig(nested: NestedAgentConfig): FlatPatch {
  const agent = parseOr(configObject, nested.agent);
  const model = parseOr(configObject, nested.model);
  const modelOptions = parseOr(configObject, model?.providerOptions);
  const tools = parseOr(configObject, nested.tools);
  for (const [branch, hint] of Object.entries(REMOVED_BRANCH_HINTS)) {
    if (nested[branch] !== undefined) {
      throw new ClientError(hint);
    }
  }

  const patch: FlatPatch = {};

  if (agent) extractAgentFields(agent, patch);
  if (model) extractModelFields(model, modelOptions, patch);
  const googleSearch = parseOr(configObject, tools?.googleSearch);
  if (googleSearch) extractSearchToolFields(googleSearch, patch);
  patch.extraConfig = collectExtraConfig(nested, agent, model, tools);

  return patch;
}

export function substituteAccountEnvPlaceholders<T>(
  config: T,
  variables: Record<string, string>,
): T {
  return substitutePlaceholders(
    config,
    variables,
    ACCOUNT_ENV_PLACEHOLDER_PATTERN_G,
  );
}

export function substituteEnvPlaceholders<T>(
  config: T,
  variables: Record<string, string>,
): T {
  return substitutePlaceholders(config, variables, ENV_PLACEHOLDER_PATTERN_G);
}

export function toNestedAgentConfig(flat: FlatAgentConfig): NestedAgentConfig {
  const extra = flat.extraConfig ?? {};

  const agent = buildNestedAgentBranch(flat, extra);
  const model = buildNestedModelBranch(flat, extra);
  const tools = buildNestedToolsBranch(flat, extra);

  return assembleNestedConfig(extra, agent, model, tools);
}

function assembleNestedConfig(
  extra: StoredExtraConfig,
  agent: Record<string, unknown>,
  model: Record<string, unknown>,
  tools: Record<string, unknown>,
): NestedAgentConfig {
  const provider = extra.provider;

  return {
    ...(pruneEmpty(agent) ? { agent: pruneEmpty(agent) } : {}),
    ...(extra.harness ? { harness: extra.harness } : {}),
    ...(pruneEmpty(model) ? { model: pruneEmpty(model) } : {}),
    ...(provider ? { provider: provider } : {}),
    ...(extra.sandboxes ? { sandboxes: extra.sandboxes } : {}),
    ...(extra.workspaces ? { workspaces: extra.workspaces } : {}),
    ...(extra.session ? { session: extra.session } : {}),
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
    ...(extra.channels ? { channels: extra.channels } : {}),
    ...(pruneEmpty(tools) ? { tools: pruneEmpty(tools) } : {}),
    ...(extra.mcp ? { mcp: extra.mcp } : {}),
    ...(extra.denyTools ? { denyTools: extra.denyTools } : {}),
    ...(extra.skills ? { skills: extra.skills } : {}),
    ...(extra.subagent ? { subagent: extra.subagent } : {}),
    ...(extra.scheduler ? { scheduler: extra.scheduler } : {}),
    ...(extra.browser ? { browser: extra.browser } : {}),
    ...(extra.policies ? { policies: extra.policies } : {}),
    ...(typeof extra.publicAccess === "boolean"
      ? { publicAccess: extra.publicAccess }
      : {}),
    ...(typeof extra.allowRunOverrides === "boolean"
      ? { allowRunOverrides: extra.allowRunOverrides }
      : {}),
  };
}

function assertNoUnsupportedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  for (const key of keys) {
    if (value[key] !== undefined) {
      throw new ClientError(`${path}.${key} is not supported`);
    }
  }
}

function buildNestedAgentBranch(
  flat: FlatAgentConfig,
  extra: StoredExtraConfig,
): Record<string, unknown> {
  const agent: Record<string, unknown> = { ...extra.agent };
  if (flat.maxTurns !== undefined) agent.maxTurn = flat.maxTurns;
  if (flat.systemPrompt && agent.system === undefined)
    agent.system = flat.systemPrompt;

  return agent;
}

function buildNestedModelBranch(
  flat: FlatAgentConfig,
  extra: StoredExtraConfig,
): Record<string, unknown> {
  const modelOptions = mergeProviderOptions(
    extra.model?.providerOptions,
    flat.providerOptions,
  );
  if (flat.temperature !== undefined)
    modelOptions.temperature = flat.temperature;
  if (flat.maxTokens !== undefined) modelOptions.maxTokens = flat.maxTokens;

  const model: Record<string, unknown> = { ...extra.model };
  if (flat.provider) model.provider = flat.provider;
  if (flat.modelId) model.modelId = flat.modelId;
  assertNoUnsupportedKeys(model, ["options"], "config.model");
  if (Object.keys(modelOptions).length > 0)
    model.providerOptions = modelOptions;
  if (flat.outputFormat !== undefined) model.output = flat.outputFormat;

  return model;
}

function buildNestedToolsBranch(
  flat: FlatAgentConfig,
  extra: StoredExtraConfig,
): Record<string, unknown> {
  const tools: Record<string, unknown> = { ...extra.tools };
  if (
    flat.searchToolEnabled !== undefined &&
    tools.googleSearch === undefined
  ) {
    tools.googleSearch = {
      enabled: flat.searchToolEnabled,
      ...flat.searchToolConfig,
    };
  }

  return tools;
}

// The branch copies must arrive already stripped of the fields the patch absorbed.
function collectExtraConfig(
  nested: NestedAgentConfig,
  agent: Record<string, unknown> | undefined,
  model: Record<string, unknown> | undefined,
  tools: Record<string, unknown> | undefined,
): StoredExtraConfig {
  const extra: Record<string, unknown> = {};
  if (agent && Object.keys(agent).length > 0) extra.agent = agent;
  if (model && Object.keys(model).length > 0) extra.model = model;
  if (nested.workspaces !== undefined) extra.workspaces = nested.workspaces;
  if (tools && Object.keys(tools).length > 0) extra.tools = tools;
  for (const branch of NESTED_BRANCHES) {
    if (
      branch === "agent" ||
      branch === "model" ||
      branch === "workspaces" ||
      branch === "tools"
    )
      continue;
    if (nested[branch] !== undefined) extra[branch] = nested[branch];
  }
  if (typeof nested.publicAccess === "boolean")
    extra.publicAccess = nested.publicAccess;
  if (typeof nested.allowRunOverrides === "boolean")
    extra.allowRunOverrides = nested.allowRunOverrides;

  // Untyped input: Convex checks it against agentExtraConfigColumn when the row is written.
  return extra as StoredExtraConfig;
}

function extractAgentFields(
  agent: Record<string, unknown>,
  patch: FlatPatch,
): void {
  if (typeof agent.maxTurn === "number") {
    patch.maxTurns = agent.maxTurn;
    delete agent.maxTurn;
  }
  if (typeof agent.system === "string") {
    patch.systemPrompt = agent.system;
    delete agent.system;
  }
}

function extractModelFields(
  model: Record<string, unknown>,
  modelOptions: Record<string, unknown> | undefined,
  patch: FlatPatch,
): void {
  if (typeof model.provider === "string") {
    patch.provider = model.provider;
    delete model.provider;
  }
  if (typeof model.modelId === "string") {
    patch.modelId = model.modelId;
    delete model.modelId;
  }
  // `null` clears the output, as the dashboard's update does; Convex checks the rest on write.
  if (model.output !== undefined) {
    if (model.output !== null)
      patch.outputFormat = model.output as AgentConfigDoc["outputFormat"];
    delete model.output;
  }
  if (modelOptions) {
    if (typeof modelOptions.temperature === "number") {
      patch.temperature = modelOptions.temperature;
      delete modelOptions.temperature;
    }
    if (typeof modelOptions.maxTokens === "number") {
      patch.maxTokens = modelOptions.maxTokens;
      delete modelOptions.maxTokens;
    }
    if (Object.keys(modelOptions).length > 0)
      patch.providerOptions = modelOptions;
    delete model.providerOptions;
  }
}

function extractSearchToolFields(
  googleSearch: Record<string, unknown>,
  patch: FlatPatch,
): void {
  const search = { ...googleSearch };
  if (typeof search.enabled === "boolean") {
    patch.searchToolEnabled = search.enabled;
    delete search.enabled;
  }
  if (Object.keys(search).length > 0) patch.searchToolConfig = search;
}

// Provider sub-objects merge key by key: reasoning lives in `extraConfig.model`, the other
// provider options in the flat column. `overlay` wins a direct conflict.
function mergeProviderOptions(
  base: unknown,
  overlay: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parseOr(configObject, base) };
  for (const [key, value] of Object.entries(
    parseOr(configObject, overlay, {}),
  )) {
    const existing = parseOr(configObject, result[key]);
    const next = parseOr(configObject, value);
    result[key] = existing && next ? { ...existing, ...next } : value;
  }

  return result;
}

function pruneEmpty(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    const branch = parseOr(configObject, raw);
    if (branch) {
      const child = pruneEmpty(branch);
      if (child) cleaned[key] = child;
      continue;
    }
    cleaned[key] = raw;
  }

  return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}

function substitutePlaceholders<T>(
  config: T,
  variables: Record<string, string>,
  pattern: RegExp,
): T {
  if (typeof config === "string") {
    return config.replace(pattern, (match, key: string) => {
      const value = Object.hasOwn(variables, key) ? variables[key] : undefined;

      return value ?? match;
    }) as unknown as T;
  }
  if (Array.isArray(config)) {
    return config.map((item) =>
      substitutePlaceholders(item, variables, pattern),
    ) as unknown as T;
  }
  if (typeof config === "object" && config !== null) {
    const result: Record<string, unknown> = {};
    const entries: [string, unknown][] = Object.entries(config);
    for (const [key, value] of entries) {
      // Prototype-pollution guard, as in the config merge helpers.
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        continue;
      result[key] = substitutePlaceholders(value, variables, pattern);
    }

    return result as unknown as T;
  }

  return config;
}

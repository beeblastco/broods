/**
 * Codec between the dashboard's flat `agentConfigs` row and the nested
 * broods `AgentConfig` shape that the Config tab exposes for editing.
 *
 * Cherry-coke stores top-level model/runtime settings as columns for fast
 * queries; everything else (workspace, tools, channels, provider settings,
 * hooks, session, skills, subagent) is stashed under `extraConfig`. This
 * file projects both into the unified nested object expected by
 * broods, and inverts the transform on save.
 *
 * Secrets in the nested config can be written as `${ENV_NAME}` placeholders.
 * Use `substituteEnvPlaceholders` to resolve them against the agent's
 * `runtimeVariables` right before pushing the config to broods.
 */

import { isPlainObject } from "./utils";

/** Recognised top-level branches in broods `AgentConfig`. */
const NESTED_BRANCHES = [
    "agent",
    "model",
    "provider",
    "sandbox",
    "workspaces",
    "workspace",
    "session",
    "hooks",
    "channels",
    "tools",
    "skills",
    "subagent",
] as const;

/** Cherry-coke columns that round-trip through `model` / `agent` branches. */
const MODEL_OPTION_KEYS = ["temperature", "maxTokens"] as const;

const UNSUPPORTED_WORKSPACE_KEYS = ["memory", "tasks", "filesystem"] as const;
const UNSUPPORTED_SANDBOX_KEYS = ["filesystem"] as const;

/** Cherry-coke flat `agentConfigs` document shape (only fields we touch). */
export interface FlatAgentConfig {
    name?: string;
    description?: string;
    provider?: string;
    modelId?: string;
    systemPrompt?: string;
    maxTurns?: number;
    allowedTools?: string[];
    permissionMode?: string;
    outputFormat?: Record<string, unknown>;
    providerOptions?: Record<string, unknown>;
    temperature?: number;
    maxTokens?: number;
    memoryToolEnabled?: boolean;
    searchToolEnabled?: boolean;
    searchToolConfig?: Record<string, unknown>;
    extraConfig?: Record<string, unknown>;
}

/** Nested broods `AgentConfig` shape rendered for the Config tab. */
export type NestedAgentConfig = Record<string, unknown>;

/**
 * One-level-deep merge of two `providerOptions` maps. Provider sub-objects
 * (e.g. `anthropic`, `openai`) merge key-by-key rather than replacing wholesale,
 * so options kept in separate stores — reasoning in `extraConfig.model` vs other
 * provider options in the flat column — don't clobber each other. `overlay` wins
 * on direct key conflicts.
 */
function mergeProviderOptions(base: unknown, overlay: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
    if (isPlainObject(overlay)) {
        for (const [key, value] of Object.entries(overlay)) {
            const existing = result[key];
            result[key] = isPlainObject(existing) && isPlainObject(value)
                ? { ...existing, ...value }
                : value;
        }
    }

    return result;
}

function pruneEmpty(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const cleaned: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === undefined) continue;
        if (isPlainObject(raw)) {
            const child = pruneEmpty(raw);
            if (child) cleaned[key] = child;
            continue;
        }
        cleaned[key] = raw;
    }
    return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}

function assertNoUnsupportedKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
    for (const key of keys) {
        if (value[key] !== undefined) {
            throw new Error(`${path}.${key} is not supported`);
        }
    }
}

/** Project a flat dashboard row into the nested broods shape. */
export function toNestedAgentConfig(flat: FlatAgentConfig): NestedAgentConfig {
    const extra = isPlainObject(flat.extraConfig) ? flat.extraConfig : {};

    const agent: Record<string, unknown> = { ...((extra.agent as Record<string, unknown> | undefined) ?? {}) };
    if (flat.maxTurns !== undefined) agent.maxTurn = flat.maxTurns;
    if (flat.systemPrompt && agent.system === undefined) agent.system = flat.systemPrompt;

    const modelOptions = mergeProviderOptions(
        (extra.model as Record<string, unknown> | undefined)?.providerOptions,
        flat.providerOptions,
    );
    for (const key of MODEL_OPTION_KEYS) {
        if (flat[key] !== undefined) modelOptions[key] = flat[key];
    }

    const model: Record<string, unknown> = {
        ...((extra.model as Record<string, unknown> | undefined) ?? {}),
    };
    if (flat.provider) model.provider = flat.provider;
    if (flat.modelId) model.modelId = flat.modelId;
    assertNoUnsupportedKeys(model, ["options"], "config.model");
    if (Object.keys(modelOptions).length > 0) model.providerOptions = modelOptions;
    if (flat.outputFormat !== undefined) model.output = flat.outputFormat;

    // Provider settings — kept entirely in extraConfig.provider.
    const provider = extra.provider;

    // Tools: surface flat memory/search toggles into config.tools.* if not set in extraConfig.
    const tools: Record<string, unknown> = { ...((extra.tools as Record<string, unknown> | undefined) ?? {}) };
    if (flat.searchToolEnabled !== undefined && tools.googleSearch === undefined) {
        tools.googleSearch = { enabled: flat.searchToolEnabled, ...(flat.searchToolConfig ?? {}) };
    }

    const workspace: Record<string, unknown> = { ...((extra.workspace as Record<string, unknown> | undefined) ?? {}) };
    assertNoUnsupportedKeys(workspace, UNSUPPORTED_WORKSPACE_KEYS, "config.workspace");
    if (isPlainObject(workspace.sandbox)) {
        const sandbox = { ...workspace.sandbox };
        assertNoUnsupportedKeys(sandbox, UNSUPPORTED_SANDBOX_KEYS, "config.workspace.sandbox");
        workspace.sandbox = sandbox;
    }

    const nested: Record<string, unknown> = {
        ...(pruneEmpty(agent) ? { agent: pruneEmpty(agent) } : {}),
        ...(pruneEmpty(model) ? { model: pruneEmpty(model) } : {}),
        ...(provider ? { provider } : {}),
        ...(extra.sandbox ? { sandbox: extra.sandbox } : {}),
        ...(extra.workspaces ? { workspaces: extra.workspaces } : {}),
        ...(pruneEmpty(workspace) ? { workspace: pruneEmpty(workspace) } : {}),
        ...(extra.session ? { session: extra.session } : {}),
        ...(extra.hooks ? { hooks: extra.hooks } : {}),
        ...(extra.channels ? { channels: extra.channels } : {}),
        ...(pruneEmpty(tools) ? { tools: pruneEmpty(tools) } : {}),
        ...(extra.skills ? { skills: extra.skills } : {}),
        ...(extra.subagent ? { subagent: extra.subagent } : {}),
        // Top-level public-endpoint opt-in carried in extraConfig (issue #65).
        ...(typeof extra.publicAccess === "boolean" ? { publicAccess: extra.publicAccess } : {}),
    };

    return nested;
}

/** Patch produced by the inverse projection — feed to the `update` mutation. */
export interface FlatPatch {
    provider?: string;
    modelId?: string;
    systemPrompt?: string;
    maxTurns?: number;
    temperature?: number;
    maxTokens?: number;
    providerOptions?: Record<string, unknown>;
    outputFormat?: Record<string, unknown>;
    memoryToolEnabled?: boolean;
    searchToolEnabled?: boolean;
    searchToolConfig?: Record<string, unknown>;
    extraConfig?: Record<string, unknown>;
}

/**
 * Reads a single top-level branch (e.g. `workspace`, `skills`) from a flat agent
 * config as an object, returning `{}` when the config or branch is absent. Lets
 * node side-panels project just their slice without repeating the codec call.
 */
export function readAgentBranch<T extends Record<string, unknown>>(
    agentConfig: FlatAgentConfig | null | undefined,
    branch: string,
): T {
    if (!agentConfig) {
        return {} as T;
    }

    const nested = toNestedAgentConfig(agentConfig) as Record<string, unknown>;

    return (nested[branch] as T | undefined) ?? ({} as T);
}

/** Inverse of {@link toNestedAgentConfig}: pull known columns back out. */
export function fromNestedAgentConfig(nested: NestedAgentConfig): FlatPatch {
    if (!isPlainObject(nested)) {
        return { extraConfig: {} };
    }

    const agent = isPlainObject(nested.agent) ? { ...nested.agent } : undefined;
    const model = isPlainObject(nested.model) ? { ...nested.model } : undefined;
    const modelOptions = isPlainObject(model?.providerOptions)
        ? { ...(model.providerOptions as Record<string, unknown>) }
        : undefined;
    const tools = isPlainObject(nested.tools) ? { ...nested.tools } : undefined;
    const workspace = isPlainObject(nested.workspace) ? { ...nested.workspace } : undefined;

    const patch: FlatPatch = {};

    if (agent) {
        if (typeof agent.maxTurn === "number") {
            patch.maxTurns = agent.maxTurn;
            delete agent.maxTurn;
        }
        if (typeof agent.system === "string") {
            patch.systemPrompt = agent.system;
            delete agent.system;
        }
    }

    if (model) {
        if (typeof model.provider === "string") {
            patch.provider = model.provider;
            delete model.provider;
        }
        if (typeof model.modelId === "string") {
            patch.modelId = model.modelId;
            delete model.modelId;
        }
        if (model.output !== undefined) {
            patch.outputFormat = model.output as Record<string, unknown>;
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
            if (Object.keys(modelOptions).length > 0) {
                patch.providerOptions = modelOptions;
            }
            delete model.providerOptions;
        }
    }

    if (tools?.googleSearch && isPlainObject(tools.googleSearch)) {
        const search = { ...tools.googleSearch } as Record<string, unknown>;
        if (typeof search.enabled === "boolean") {
            patch.searchToolEnabled = search.enabled;
            delete search.enabled;
        }
        if (Object.keys(search).length > 0) {
            patch.searchToolConfig = search;
        }
    }

    const extra: Record<string, unknown> = {};
    if (agent && Object.keys(agent).length > 0) extra.agent = agent;
    if (model && Object.keys(model).length > 0) extra.model = model;
    if (nested.sandbox !== undefined) extra.sandbox = nested.sandbox;
    if (nested.workspaces !== undefined) extra.workspaces = nested.workspaces;
    if (workspace && Object.keys(workspace).length > 0) extra.workspace = workspace;
    if (tools && Object.keys(tools).length > 0) extra.tools = tools;
    for (const branch of NESTED_BRANCHES) {
        if (
            branch in ({
                agent: 1,
                model: 1,
                sandbox: 1,
                workspaces: 1,
                workspace: 1,
                tools: 1,
            } as Record<string, number>)
        ) continue;
        if (nested[branch] !== undefined) extra[branch] = nested[branch];
    }
    // Preserve the top-level public-endpoint opt-in inside extraConfig (issue #65).
    if (typeof nested.publicAccess === "boolean") extra.publicAccess = nested.publicAccess;
    patch.extraConfig = extra;

    return patch;
}

/**
 * Replace `${KEY}` placeholders inside `config` with the matching value from
 * `variables`. Unknown placeholders are left untouched so they surface in the
 * downstream service's error rather than silently becoming empty strings.
 * Walks objects/arrays recursively; leaves all non-string leaves intact.
 */
export function substituteEnvPlaceholders<T>(
    config: T,
    variables: Record<string, string>,
): T {
    if (typeof config === "string") {
        return config.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
            return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
        }) as unknown as T;
    }
    if (Array.isArray(config)) {
        return config.map((item) => substituteEnvPlaceholders(item, variables)) as unknown as T;
    }
    if (isPlainObject(config)) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config)) {
            result[key] = substituteEnvPlaceholders(value, variables);
        }
        return result as unknown as T;
    }
    return config;
}

/**
 * Vercel AI SDK `providerOptions` keys the budget/effort knobs own per provider.
 * Only these are cleared on rewrite so unrelated options the UI doesn't manage
 * (e.g. OpenAI `reasoningSummary`) survive. MiniMax's default provider is
 * Anthropic-compatible, so it reuses the `anthropic` slot. Mirrors the
 * per-provider table in the core docs (getting-started → "Reasoning / thinking
 * tokens").
 */
const REASONING_PROVIDER_KEYS: Record<string, string[]> = {
    openai: ["reasoningEffort"],
    anthropic: ["thinking", "effort"],
    google: ["thinkingConfig"],
};

/** The `providerOptions` slot a provider stores reasoning under, if any. */
function reasoningSlot(provider: string): "openai" | "anthropic" | "google" | undefined {
    if (provider === "minimax") return "anthropic";
    if (provider === "openai" || provider === "anthropic" || provider === "google") return provider;

    return undefined;
}

/**
 * Build the reasoning slice for a provider's `providerOptions` sub-object from
 * the dashboard's two knobs. Budget tokens map to Anthropic/MiniMax `thinking`
 * or Google `thinkingConfig.thinkingBudget`; effort maps to OpenAI
 * `reasoningEffort` or Anthropic `effort`. Returns undefined when neither knob
 * applies to the slot.
 */
function reasoningSlice(
    slot: "openai" | "anthropic" | "google",
    next: { budgetTokens?: number; effort?: string },
): Record<string, unknown> | undefined {
    if (slot === "openai") {
        return next.effort ? { reasoningEffort: next.effort } : undefined;
    }
    if (slot === "google") {
        return typeof next.budgetTokens === "number"
            ? { thinkingConfig: { thinkingBudget: next.budgetTokens, includeThoughts: true } }
            : undefined;
    }

    // anthropic (and minimax via the anthropic slot): prefer an explicit budget,
    // otherwise fall back to effort.
    if (typeof next.budgetTokens === "number") {
        return { thinking: { type: "enabled", budgetTokens: next.budgetTokens } };
    }

    return next.effort ? { effort: next.effort } : undefined;
}

/**
 * Rewrite the reasoning portion of a `model` branch for `provider`, returning a
 * new model object. Strips every provider's known reasoning keys first (so
 * toggling off or switching providers leaves no residue) plus the removed
 * top-level aliases (`thinking`, `thinkingEffort`, …) the core rejects, then
 * writes the active provider's reasoning under `model.providerOptions`.
 */
export function applyModelReasoning(
    model: Record<string, unknown>,
    provider: string,
    next: { budgetTokens?: number; effort?: string },
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...model };
    for (const alias of ["thinking", "thinkingConfig", "thinkingEffort", "reasoningEffort", "reasoningSummary", "effort"]) {
        delete result[alias];
    }

    const providerOptions: Record<string, unknown> = isPlainObject(result.providerOptions)
        ? { ...result.providerOptions }
        : {};
    for (const [slot, keys] of Object.entries(REASONING_PROVIDER_KEYS)) {
        if (!isPlainObject(providerOptions[slot])) continue;
        const sub = { ...providerOptions[slot] };
        for (const key of keys) delete sub[key];
        if (Object.keys(sub).length > 0) providerOptions[slot] = sub;
        else delete providerOptions[slot];
    }

    const slot = reasoningSlot(provider);
    const slice = slot ? reasoningSlice(slot, next) : undefined;
    if (slot && slice) {
        const existing = isPlainObject(providerOptions[slot]) ? providerOptions[slot] : {};
        providerOptions[slot] = { ...existing, ...slice };
    }

    if (Object.keys(providerOptions).length > 0) result.providerOptions = providerOptions;
    else delete result.providerOptions;

    return result;
}

/**
 * Read the dashboard's reasoning knobs back out of a `model` branch's
 * `providerOptions`, regardless of which provider stored them. Inverse of
 * {@link applyModelReasoning}.
 */
export function readModelReasoning(modelBranch: Record<string, unknown>): { budgetTokens?: number; effort?: string } {
    const providerOptions = isPlainObject(modelBranch.providerOptions) ? modelBranch.providerOptions : {};
    const anthropic: Record<string, unknown> = isPlainObject(providerOptions.anthropic) ? providerOptions.anthropic : {};
    const openai: Record<string, unknown> = isPlainObject(providerOptions.openai) ? providerOptions.openai : {};
    const google: Record<string, unknown> = isPlainObject(providerOptions.google) ? providerOptions.google : {};
    const anthropicThinking: Record<string, unknown> = isPlainObject(anthropic.thinking) ? anthropic.thinking : {};
    const googleThinking: Record<string, unknown> = isPlainObject(google.thinkingConfig) ? google.thinkingConfig : {};

    const budgetTokens = typeof anthropicThinking.budgetTokens === "number"
        ? anthropicThinking.budgetTokens
        : typeof googleThinking.thinkingBudget === "number"
            ? googleThinking.thinkingBudget
            : undefined;
    const effort = typeof openai.reasoningEffort === "string"
        ? openai.reasoningEffort
        : typeof anthropic.effort === "string"
            ? anthropic.effort
            : undefined;

    return {
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        ...(effort ? { effort } : {}),
    };
}

/**
 * Codec between cherry-coke's flat `agentConfigs` row and the nested
 * filthy-panty `AgentConfig` shape that the Config tab exposes for editing.
 *
 * Cherry-coke stores top-level model/runtime settings as columns for fast
 * queries; everything else (workspace, tools, channels, provider settings,
 * hooks, session, skills, subagent) is stashed under `extraConfig`. This
 * file projects both into the unified nested object expected by
 * filthy-panty, and inverts the transform on save.
 *
 * Secrets in the nested config can be written as `${ENV_NAME}` placeholders.
 * Use `substituteEnvPlaceholders` to resolve them against the agent's
 * `runtimeVariables` right before pushing the config to filthy-panty.
 */

/** Recognised top-level branches in filthy-panty `AgentConfig`. */
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

/**
 * Workspace sub-keys removed from filthy-panty's `AgentWorkspaceConfig`. They are
 * stripped on projection so the Config tab and synced runtime config drop the
 * legacy shape, and a subsequent save persists the cleaned branch.
 */
const LEGACY_WORKSPACE_KEYS = ["memory", "tasks", "filesystem"] as const;
const LEGACY_SANDBOX_KEYS = ["filesystem"] as const;

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
    publicAccessEnabled?: boolean;
    webSocketEnabled?: boolean;
    memoryToolEnabled?: boolean;
    searchToolEnabled?: boolean;
    searchToolConfig?: Record<string, unknown>;
    extraConfig?: Record<string, unknown>;
}

/** Nested filthy-panty `AgentConfig` shape rendered for the Config tab. */
export type NestedAgentConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Project a flat cherry-coke row into the nested filthy-panty shape. */
export function toNestedAgentConfig(flat: FlatAgentConfig): NestedAgentConfig {
    const extra = isPlainObject(flat.extraConfig) ? flat.extraConfig : {};

    const agent: Record<string, unknown> = { ...((extra.agent as Record<string, unknown> | undefined) ?? {}) };
    if (flat.maxTurns !== undefined) agent.maxTurn = flat.maxTurns;
    if (flat.systemPrompt) agent.system = flat.systemPrompt;

    const modelOptions: Record<string, unknown> = {
        ...((extra.model as Record<string, unknown> | undefined)?.options as Record<string, unknown> | undefined ?? {}),
        ...(isPlainObject(flat.providerOptions) ? flat.providerOptions : {}),
    };
    for (const key of MODEL_OPTION_KEYS) {
        if (flat[key] !== undefined) modelOptions[key] = flat[key];
    }

    const model: Record<string, unknown> = {
        ...((extra.model as Record<string, unknown> | undefined) ?? {}),
    };
    if (flat.provider) model.provider = flat.provider;
    if (flat.modelId) model.modelId = flat.modelId;
    if (Object.keys(modelOptions).length > 0) model.options = modelOptions;
    if (flat.outputFormat !== undefined) model.output = flat.outputFormat;

    // Provider settings — kept entirely in extraConfig.provider.
    const provider = extra.provider;

    // Tools: surface flat memory/search toggles into config.tools.* if not set in extraConfig.
    const tools: Record<string, unknown> = { ...((extra.tools as Record<string, unknown> | undefined) ?? {}) };
    if (flat.searchToolEnabled !== undefined && tools.googleSearch === undefined) {
        tools.googleSearch = { enabled: flat.searchToolEnabled, ...(flat.searchToolConfig ?? {}) };
    }

    const workspace: Record<string, unknown> = { ...((extra.workspace as Record<string, unknown> | undefined) ?? {}) };
    for (const legacyKey of LEGACY_WORKSPACE_KEYS) delete workspace[legacyKey];
    if (isPlainObject(workspace.sandbox)) {
        const sandbox = { ...workspace.sandbox };
        for (const legacyKey of LEGACY_SANDBOX_KEYS) delete sandbox[legacyKey];
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
    const modelOptions = isPlainObject(model?.options) ? { ...(model.options as Record<string, unknown>) } : undefined;
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
            delete model.options;
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

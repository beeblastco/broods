/**
 * Server-side codec mirroring `app/lib/agentConfigCodec.ts`. Convex mutations
 * cannot import from the Next.js app tree, so the projection logic lives
 * here too. Keep the two files in lockstep — any change to the flat ↔
 * nested mapping must apply to both.
 *
 * The encryption helper at the bottom uses Web Crypto (`crypto.subtle`)
 * because Convex mutations run in a V8 isolate without `node:crypto`.
 * Output shape matches filthy-panty's `EncryptedAgentConfig` so the
 * harness can decrypt with `decodeStoredAgentConfig`.
 */

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
    if (flat.temperature !== undefined) modelOptions.temperature = flat.temperature;
    if (flat.maxTokens !== undefined) modelOptions.maxTokens = flat.maxTokens;

    const model: Record<string, unknown> = {
        ...((extra.model as Record<string, unknown> | undefined) ?? {}),
    };
    if (flat.provider) model.provider = flat.provider;
    if (flat.modelId) model.modelId = flat.modelId;
    if (Object.keys(modelOptions).length > 0) model.options = modelOptions;
    if (flat.outputFormat !== undefined) model.output = flat.outputFormat;

    const provider = extra.provider;

    const tools: Record<string, unknown> = { ...((extra.tools as Record<string, unknown> | undefined) ?? {}) };
    if (flat.searchToolEnabled !== undefined && tools.googleSearch === undefined) {
        tools.googleSearch = { enabled: flat.searchToolEnabled, ...(flat.searchToolConfig ?? {}) };
    }

    const workspace: Record<string, unknown> = { ...((extra.workspace as Record<string, unknown> | undefined) ?? {}) };
    if (flat.memoryToolEnabled !== undefined && workspace.memory === undefined) {
        workspace.memory = { enabled: flat.memoryToolEnabled };
    }

    return {
        ...(pruneEmpty(agent) ? { agent: pruneEmpty(agent) } : {}),
        ...(pruneEmpty(model) ? { model: pruneEmpty(model) } : {}),
        ...(provider ? { provider } : {}),
        ...(pruneEmpty(workspace) ? { workspace: pruneEmpty(workspace) } : {}),
        ...(extra.session ? { session: extra.session } : {}),
        ...(extra.hooks ? { hooks: extra.hooks } : {}),
        ...(extra.channels ? { channels: extra.channels } : {}),
        ...(pruneEmpty(tools) ? { tools: pruneEmpty(tools) } : {}),
        ...(extra.skills ? { skills: extra.skills } : {}),
        ...(extra.subagent ? { subagent: extra.subagent } : {}),
    };
}

/** Replace `${KEY}` placeholders recursively using values from `variables`. */
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

/** Encrypted blob shape persisted on the `agents` row. base64url-encoded. */
export interface EncryptedAgentConfig {
    ciphertext: string;
    iv: string;
    tag: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * AES-256-GCM encrypt the JSON-serialised config with a key derived from
 * SHA-256(secret). Matches filthy-panty's `encryptAgentConfig` so the harness
 * can decrypt with `decodeStoredAgentConfig` from the convex storage adapter.
 */
export async function encryptAgentConfigBlob(
    config: NestedAgentConfig,
    secret: string,
): Promise<EncryptedAgentConfig> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.digest("SHA-256", enc.encode(secret));
    const key = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = enc.encode(JSON.stringify(config));

    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plaintext),
    );

    // Web Crypto returns ciphertext || tag (last 16 bytes are the auth tag).
    const tagBytes = encrypted.slice(encrypted.length - 16);
    const ciphertextBytes = encrypted.slice(0, encrypted.length - 16);

    return {
        ciphertext: bytesToBase64Url(ciphertextBytes),
        iv: bytesToBase64Url(iv),
        tag: bytesToBase64Url(tagBytes),
    };
}

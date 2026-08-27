/**
 * The flat ↔ nested agent config codec, and the only copy of it. Convex
 * mutations cannot import from the Next.js app tree, so this is the end that
 * both sides share: `apps/dashboard/app/lib/agentConfigCodec.ts` re-exports
 * from here and keeps only its own UI helpers.
 *
 * The encryption helper at the bottom uses Web Crypto (`crypto.subtle`)
 * because Convex mutations run in a V8 isolate without `node:crypto`.
 * Output shape matches broods's `EncryptedAgentConfig` so the
 * harness can decrypt with `decodeStoredAgentConfig`.
 */

import { isPlainObject } from "./objects";

// Non-global so `.test()` carries no lastIndex state; global clones are built
// where iteration/replacement needs them.
const ACCOUNT_ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/;
const ACCOUNT_ENV_PLACEHOLDER_PATTERN_G = new RegExp(
  ACCOUNT_ENV_PLACEHOLDER_PATTERN.source,
  "g",
);
/** Account config-plane environment variable names accepted in `${NAME}` references. */
export const ACCOUNT_ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ENV_PLACEHOLDER_PATTERN_G = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const NESTED_BRANCHES = [
  "agent",
  "model",
  "provider",
  "sandbox",
  "workspaces",
  "session",
  "hooks",
  "channels",
  "tools",
  "skills",
  "subagent",
  "policy",
  "scheduler",
] as const;

// Removed branches, kept only so a write answers with a pointer instead of dropping
// the value silently. `workspace` (singular) is the pre-records shape.
const REMOVED_BRANCH_HINTS: Record<string, string> = {
  workspace:
    'config.workspace is no longer supported; reference workspace records instead with config.workspaces: [{ name, workspaceId }] and set the agent machine with config.sandbox: "sb_…"',
};

/** Encrypted blob shape persisted on the `agents` row. base64url-encoded. */
export interface EncryptedAgentConfig {
  ciphertext: string;
  iv: string;
  tag: string;
}

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

/**
 * Inverse of {@link toNestedAgentConfig}. Pulls known fields back out of a
 * nested broods AgentConfig so the canvas's flat `agentConfigs` row
 * can mirror what the API caller wrote. Anything we don't have a flat
 * column for is preserved in `extraConfig`.
 */
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

export type NestedAgentConfig = Record<string, unknown>;

/** Collect valid `${NAME}` references from strings nested anywhere in a config. */
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
  if (isPlainObject(value)) {
    for (const item of Object.values(value))
      collectEnvPlaceholderNames(item, names);
  }

  return names;
}

/**
 * Inverse of {@link encryptAgentConfigBlob}. Used to read back what an
 * API-side caller wrote so the canvas can mirror provider/model/extras.
 * Returns null on any decode failure (wrong secret, tampered blob, etc.).
 */
export async function decryptAgentConfigBlob(
  blob: EncryptedAgentConfig,
  secret: string,
): Promise<NestedAgentConfig | null> {
  try {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.digest(
      "SHA-256",
      enc.encode(secret),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      keyMaterial,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const iv = base64UrlToBytes(blob.iv);
    const ct = base64UrlToBytes(blob.ciphertext);
    const tag = base64UrlToBytes(blob.tag);
    // Web Crypto expects ciphertext || tag concatenated
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      combined.buffer as ArrayBuffer,
    );
    const decoded = new TextDecoder().decode(plaintext);
    const parsed = JSON.parse(decoded);

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * AES-256-GCM encrypt the JSON-serialised config with a key derived from
 * SHA-256(secret). Matches broods's `encryptAgentConfig` so the harness
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

export function fromNestedAgentConfig(nested: NestedAgentConfig): FlatPatch {
  if (!isPlainObject(nested)) return { extraConfig: {} };

  const agent = isPlainObject(nested.agent) ? { ...nested.agent } : undefined;
  const model = isPlainObject(nested.model) ? { ...nested.model } : undefined;
  const modelOptions = isPlainObject(model?.providerOptions)
    ? { ...(model.providerOptions as Record<string, unknown>) }
    : undefined;
  const tools = isPlainObject(nested.tools) ? { ...nested.tools } : undefined;
  // A removed branch is rejected on write. Dropping it silently would let someone
  // configure a workspace, see it saved, and never learn nothing reads it.
  for (const [branch, hint] of Object.entries(REMOVED_BRANCH_HINTS)) {
    if (nested[branch] !== undefined) {
      throw new Error(hint);
    }
  }

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
      if (Object.keys(modelOptions).length > 0)
        patch.providerOptions = modelOptions;
      delete model.providerOptions;
    }
  }
  if (tools?.googleSearch && isPlainObject(tools.googleSearch)) {
    const search = { ...tools.googleSearch } as Record<string, unknown>;
    if (typeof search.enabled === "boolean") {
      patch.searchToolEnabled = search.enabled;
      delete search.enabled;
    }
    if (Object.keys(search).length > 0) patch.searchToolConfig = search;
  }

  const extra: Record<string, unknown> = {};
  if (agent && Object.keys(agent).length > 0) extra.agent = agent;
  if (model && Object.keys(model).length > 0) extra.model = model;
  if (nested.sandbox !== undefined) extra.sandbox = nested.sandbox;
  if (nested.workspaces !== undefined) extra.workspaces = nested.workspaces;
  if (tools && Object.keys(tools).length > 0) extra.tools = tools;
  for (const branch of NESTED_BRANCHES) {
    if (
      branch === "agent" ||
      branch === "model" ||
      branch === "sandbox" ||
      branch === "workspaces" ||
      branch === "tools"
    )
      continue;
    if (nested[branch] !== undefined) extra[branch] = nested[branch];
  }
  // Preserve the top-level public-endpoint opt-in inside extraConfig (issue #65).
  if (typeof nested.publicAccess === "boolean")
    extra.publicAccess = nested.publicAccess;
  patch.extraConfig = extra;

  return patch;
}

/**
 * True when a string consists ONLY of `${NAME}` placeholder tokens. Anchored
 * on purpose: a value mixing literal content with a placeholder (e.g.
 * `sk_live_abc${FOO}`) still carries secret material and must stay redacted.
 */
export function isEntirelyEnvPlaceholders(value: string): boolean {
  return /^(\$\{[A-Z][A-Z0-9_]*\})+$/.test(value);
}

/** Replace valid uppercase account env-var `${NAME}` placeholders recursively. */
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

/** Replace `${KEY}` placeholders recursively using values from `variables`. */
export function substituteEnvPlaceholders<T>(
  config: T,
  variables: Record<string, string>,
): T {
  return substitutePlaceholders(config, variables, ENV_PLACEHOLDER_PATTERN_G);
}

/** Project a flat dashboard row into the nested broods shape. */
export function toNestedAgentConfig(flat: FlatAgentConfig): NestedAgentConfig {
  const extra = isPlainObject(flat.extraConfig) ? flat.extraConfig : {};

  const agent: Record<string, unknown> = {
    ...(extra.agent as Record<string, unknown> | undefined),
  };
  if (flat.maxTurns !== undefined) agent.maxTurn = flat.maxTurns;
  if (flat.systemPrompt && agent.system === undefined)
    agent.system = flat.systemPrompt;

  const modelOptions = mergeProviderOptions(
    (extra.model as Record<string, unknown> | undefined)?.providerOptions,
    flat.providerOptions,
  );
  if (flat.temperature !== undefined)
    modelOptions.temperature = flat.temperature;
  if (flat.maxTokens !== undefined) modelOptions.maxTokens = flat.maxTokens;

  const model: Record<string, unknown> = {
    ...(extra.model as Record<string, unknown> | undefined),
  };
  if (flat.provider) model.provider = flat.provider;
  if (flat.modelId) model.modelId = flat.modelId;
  assertNoUnsupportedKeys(model, ["options"], "config.model");
  if (Object.keys(modelOptions).length > 0)
    model.providerOptions = modelOptions;
  if (flat.outputFormat !== undefined) model.output = flat.outputFormat;

  const provider = extra.provider;

  const tools: Record<string, unknown> = {
    ...(extra.tools as Record<string, unknown> | undefined),
  };
  if (
    flat.searchToolEnabled !== undefined &&
    tools.googleSearch === undefined
  ) {
    tools.googleSearch = {
      enabled: flat.searchToolEnabled,
      ...flat.searchToolConfig,
    };
  }

  // Read drops a removed branch rather than throwing: rows written before it was
  // removed still carry the blob, and reading one must not fail. Writing it back
  // is what clears it, so an agent cleans itself on its next save.
  return {
    ...(pruneEmpty(agent) ? { agent: pruneEmpty(agent) } : {}),
    ...(pruneEmpty(model) ? { model: pruneEmpty(model) } : {}),
    ...(provider ? { provider: provider } : {}),
    ...(extra.sandbox ? { sandbox: extra.sandbox } : {}),
    ...(extra.workspaces ? { workspaces: extra.workspaces } : {}),
    ...(extra.session ? { session: extra.session } : {}),
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
    ...(extra.channels ? { channels: extra.channels } : {}),
    ...(pruneEmpty(tools) ? { tools: pruneEmpty(tools) } : {}),
    ...(extra.skills ? { skills: extra.skills } : {}),
    ...(extra.subagent ? { subagent: extra.subagent } : {}),
    ...(extra.policy ? { policy: extra.policy } : {}),
    ...(extra.scheduler ? { scheduler: extra.scheduler } : {}),
    // Top-level scalar carried in extraConfig so it flows through every
    // flat-row builder unchanged; surfaced as nested `publicAccess` (issue #65).
    ...(typeof extra.publicAccess === "boolean"
      ? { publicAccess: extra.publicAccess }
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
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++)
    bin += String.fromCharCode(bytes[i]);

  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * One-level-deep merge of two `providerOptions` maps. Provider sub-objects
 * (e.g. `anthropic`, `openai`) merge key-by-key rather than replacing wholesale,
 * so options kept in separate stores — reasoning in `extraConfig.model` vs other
 * provider options in the flat column — don't clobber each other. `overlay` wins
 * on direct key conflicts.
 */
function mergeProviderOptions(
  base: unknown,
  overlay: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = isPlainObject(base)
    ? { ...base }
    : {};
  if (isPlainObject(overlay)) {
    for (const [key, value] of Object.entries(overlay)) {
      const existing = result[key];
      result[key] =
        isPlainObject(existing) && isPlainObject(value)
          ? { ...existing, ...value }
          : value;
    }
  }

  return result;
}

function pruneEmpty(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
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

function substitutePlaceholders<T>(
  config: T,
  variables: Record<string, string>,
  pattern: RegExp,
): T {
  if (typeof config === "string") {
    return config.replace(pattern, (match, key: string) => {
      return Object.prototype.hasOwnProperty.call(variables, key)
        ? variables[key]
        : match;
    }) as unknown as T;
  }
  if (Array.isArray(config)) {
    return config.map((item) =>
      substitutePlaceholders(item, variables, pattern),
    ) as unknown as T;
  }
  if (isPlainObject(config)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      // Same prototype-pollution guard as the config merge helpers.
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        continue;
      result[key] = substitutePlaceholders(value, variables, pattern);
    }

    return result as unknown as T;
  }

  return config;
}

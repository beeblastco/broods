/**
 * Sandbox-config validation and public response mapping for the Convex config
 * plane. Ports core's former storage/sandbox-config.ts normalizer so the
 * public /v1/sandboxes contract is unchanged.
 */

import type { Doc } from "../_generated/dataModel";
import { mergeConfigObjects, redactConfigSecrets, REDACTED_SECRET_VALUE } from "./configValues";
import { isPlainObject, isStringRecord } from "./objects";

export const SANDBOX_PROVIDERS = ["sandbox", "lambda", "e2b", "daytona", "vercel"] as const;
export const SANDBOX_RUNTIMES = ["bash", "python", "node"] as const;
export const SANDBOX_PERMISSION_MODES = ["edit", "ask", "bypass"] as const;
export const SANDBOX_NETWORK_MODES = ["allow-all", "deny-all", "restricted"] as const;
export const SANDBOX_SIZE_NAMES = ["tiny", "xsmall", "small", "medium", "large"] as const;

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const LAMBDA_MAX_TIMEOUT_SECONDS = 600;
export const LAMBDA_MAX_MEMORY_LIMIT_MB = 8192;
export const PERSISTENT_MAX_TIMEOUT_SECONDS = 600;
export const MAX_IDLE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];
export type RuntimeName = (typeof SANDBOX_RUNTIMES)[number];
export type PermissionMode = (typeof SANDBOX_PERMISSION_MODES)[number];
export type NetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];
export type SandboxSize = (typeof SANDBOX_SIZE_NAMES)[number];

/**
 * Idle and maximum lifetime controls for a persistent sandbox.
 */
export interface SandboxLifecycleConfig {
    idleTimeoutSeconds?: number;
    maxLifetimeSeconds?: number;
}

/**
 * Provider-normalized sandbox network policy.
 */
export interface SandboxNetworkConfig {
    mode: NetworkMode;
    allowDomains?: string[];
    allowCidrs?: string[];
}

/**
 * Account-scoped reusable sandbox configuration referenced by agents.
 */
export interface SandboxConfig {
    provider: SandboxProvider;
    size?: SandboxSize;
    snapshot?: string;
    runtimes?: RuntimeName[];
    network?: SandboxNetworkConfig;
    permissionMode?: PermissionMode;
    persistent?: boolean;
    lifecycle?: SandboxLifecycleConfig;
    onCreate?: string[];
    onResume?: string[];
    timeout?: number;
    memoryLimit?: number;
    outputLimitBytes?: number;
    envVars?: Record<string, undefined | string>;
    options?: Record<string, unknown>;
}

/**
 * Per-call sandbox limits for validation.
 */
export interface WorkspaceSandboxLimits {
    maxTimeoutSeconds: number;
    maxMemoryLimitMb?: number;
    maxOutputLimitBytes: number;
}

/**
 * Per-call sandbox limits for a provider, including environment overrides.
 * @param provider sandbox compute backend
 * @returns provider-aware ceilings used by config validation
 */
export function workspaceSandboxLimits(provider: SandboxProvider = "lambda"): WorkspaceSandboxLimits {
    const isLambda = provider === "lambda";

    return {
        maxTimeoutSeconds: isLambda
            ? positiveIntegerEnv("WORKSPACE_SANDBOX_LAMBDA_MAX_TIMEOUT_SECONDS", LAMBDA_MAX_TIMEOUT_SECONDS)
            : positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS", PERSISTENT_MAX_TIMEOUT_SECONDS),
        ...(isLambda
            ? { maxMemoryLimitMb: positiveIntegerEnv("WORKSPACE_SANDBOX_LAMBDA_MAX_MEMORY_LIMIT_MB", LAMBDA_MAX_MEMORY_LIMIT_MB) }
            : {}),
        maxOutputLimitBytes: positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_OUTPUT_LIMIT_BYTES", DEFAULT_MAX_OUTPUT_LIMIT_BYTES),
    };
}

/**
 * Validate and normalize a sandbox config object.
 * @param value the raw config value
 * @returns the normalized sandbox config
 */
export function normalizeSandboxConfig(value: unknown): SandboxConfig {
    if (value == null) {
        return { provider: "lambda", permissionMode: "ask", network: { mode: "deny-all" } };
    }
    if (!isPlainObject(value)) {
        throw new Error("config must be an object");
    }

    const config = value;
    if ("internet" in config) {
        throw new Error("config.internet is no longer supported; use config.network");
    }
    assertOptionalEnum(config.provider, "config.provider", SANDBOX_PROVIDERS);
    assertOptionalEnum(config.permissionMode, "config.permissionMode", SANDBOX_PERMISSION_MODES);
    assertOptionalEnum(config.size, "config.size", SANDBOX_SIZE_NAMES);
    assertOptionalBoolean(config.persistent, "config.persistent");
    const snapshot = optionalString(config.snapshot, "config.snapshot");

    const provider = (config.provider as SandboxProvider | undefined) ?? "lambda";
    const network = normalizeNetwork(config.network);
    if (provider === "e2b" && network.mode !== "allow-all") {
        throw new Error("e2b cannot enforce egress restrictions; set config.network.mode to allow-all explicitly");
    }
    const lifecycle = config.lifecycle !== undefined ? normalizeLifecycle(config.lifecycle) : undefined;
    if (lifecycle && config.persistent !== true) {
        throw new Error("config.lifecycle requires config.persistent to be true");
    }
    const onCreate = config.onCreate !== undefined ? normalizeHookList(config.onCreate, "config.onCreate") : undefined;
    const onResume = config.onResume !== undefined ? normalizeHookList(config.onResume, "config.onResume") : undefined;
    if ((onCreate || onResume) && config.persistent !== true) {
        throw new Error("config.onCreate and config.onResume require config.persistent to be true");
    }
    if (provider === "e2b" && (onCreate || onResume)) {
        throw new Error("config.onCreate and config.onResume are not supported by the e2b provider; use an E2B template or run setup commands explicitly");
    }

    if (config.runtimes !== undefined) {
        if (
            !Array.isArray(config.runtimes) ||
            config.runtimes.length === 0 ||
            !config.runtimes.every((entry) => typeof entry === "string" && SANDBOX_RUNTIMES.includes(entry as RuntimeName))
        ) {
            throw new Error(`config.runtimes must be a non-empty array of: ${SANDBOX_RUNTIMES.join(", ")}`);
        }
    }

    const limits = workspaceSandboxLimits(provider);
    assertOptionalPositiveInteger(config.timeout, "config.timeout", limits.maxTimeoutSeconds);
    assertOptionalPositiveInteger(config.memoryLimit, "config.memoryLimit", limits.maxMemoryLimitMb);
    assertOptionalPositiveInteger(config.outputLimitBytes, "config.outputLimitBytes", limits.maxOutputLimitBytes);

    if (config.envVars !== undefined && !isStringRecord(config.envVars)) {
        throw new Error("config.envVars must be an object with string values");
    }
    if (config.options !== undefined && !isPlainObject(config.options)) {
        throw new Error("config.options must be an object");
    }
    if (config.options !== undefined) {
        validateProviderOptions(provider, config.options);
    }

    return {
        provider: provider,
        network: network,
        permissionMode: (config.permissionMode as PermissionMode | undefined) ?? "ask",
        ...(config.size !== undefined ? { size: config.size as SandboxSize } : {}),
        ...(snapshot ? { snapshot: snapshot } : {}),
        ...(config.persistent !== undefined ? { persistent: config.persistent as boolean } : {}),
        ...(lifecycle ? { lifecycle: lifecycle } : {}),
        ...(onCreate ? { onCreate: onCreate } : {}),
        ...(onResume ? { onResume: onResume } : {}),
        ...(config.runtimes !== undefined ? { runtimes: [...(config.runtimes as RuntimeName[])] } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout as number } : {}),
        ...(config.memoryLimit !== undefined ? { memoryLimit: config.memoryLimit as number } : {}),
        ...(config.outputLimitBytes !== undefined ? { outputLimitBytes: config.outputLimitBytes as number } : {}),
        ...(config.envVars !== undefined ? { envVars: { ...(config.envVars as Record<string, string>) } } : {}),
        ...(config.options !== undefined ? { options: { ...(config.options as Record<string, unknown>) } } : {}),
    };
}

/**
 * Validate a create-sandbox request body.
 * @param value the raw request body
 * @returns normalized create fields
 */
export function normalizeCreateSandboxConfigInput(
    value: unknown,
): { name: string; description?: string; config: SandboxConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    const name = requireString(value.name, "name");
    const description = optionalString(value.description, "description");
    const config = normalizeSandboxConfig(value.config);

    return { name: name, ...(description ? { description: description } : {}), config: config };
}

/**
 * Validate an update-sandbox request body against the stored config.
 * @param existingConfig the stored sandbox config
 * @param value the raw request body
 * @returns normalized patch fields with a fully merged config
 */
export function normalizeUpdateSandboxConfigInput(
    existingConfig: SandboxConfig,
    value: unknown,
): { name?: string; description?: string | null; config: SandboxConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");

    const config = "config" in value
        ? normalizeSandboxConfig(mergeConfigObjects(existingConfig, asObject(value.config)))
        : existingConfig;

    return {
        ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
        ...(value.description !== undefined
            ? { description: value.description === null ? null : optionalString(value.description, "description") }
            : {}),
        config: config,
    };
}

/**
 * Map a sandboxConfigs document and decrypted config to the public response.
 * @param doc the sandboxConfigs document
 * @param config decrypted sandbox config
 * @returns the public sandbox record with secrets redacted
 */
export function toPublicSandboxConfigResponse(
    doc: Doc<"sandboxConfigs">,
    config: SandboxConfig,
): Record<string, unknown> {
    return {
        accountId: doc.accountId,
        sandboxId: doc._id,
        ...(doc.projectId ? { projectId: doc.projectId } : {}),
        ...(doc.environmentId ? { environmentId: doc.environmentId } : {}),
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        config: redactSandboxConfigSecrets(config),
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}

function redactSandboxConfigSecrets(config: SandboxConfig): SandboxConfig {
    const redacted = redactConfigSecrets(config);
    if (redacted.envVars) {
        redacted.envVars = Object.fromEntries(
            Object.keys(redacted.envVars).map((key) => [key, REDACTED_SECRET_VALUE]),
        );
    }

    return redacted;
}

function asObject(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) throw new Error("config must be an object");

    return value;
}

function assertOptionalBoolean(value: unknown, name: string): void {
    if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
    }
}

function normalizeNetwork(value: unknown): SandboxNetworkConfig {
    if (value === undefined) {
        return { mode: "deny-all" };
    }
    if (!isPlainObject(value)) {
        throw new Error("config.network must be an object");
    }
    assertOptionalEnum(value.mode, "config.network.mode", SANDBOX_NETWORK_MODES);
    const mode = (value.mode as NetworkMode | undefined) ?? "deny-all";
    const allowDomains = normalizeOptionalStringList(value.allowDomains, "config.network.allowDomains");
    const allowCidrs = normalizeOptionalStringList(value.allowCidrs, "config.network.allowCidrs");
    if (mode !== "restricted" && (allowDomains || allowCidrs)) {
        throw new Error("config.network.allowDomains and config.network.allowCidrs are only valid when config.network.mode is restricted");
    }

    return {
        mode: mode,
        ...(allowDomains ? { allowDomains: allowDomains } : {}),
        ...(allowCidrs ? { allowCidrs: allowCidrs } : {}),
    };
}

function normalizeHookList(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${name} must be a non-empty array of non-empty strings`);
    }
    const commands = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
    if (commands.some((entry) => entry.length === 0)) {
        throw new Error(`${name} must be a non-empty array of non-empty strings`);
    }

    return commands;
}

function normalizeOptionalStringList(value: unknown, name: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`${name} must be an array of non-empty strings`);
    }
    const entries = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
    if (entries.some((entry) => entry.length === 0)) {
        throw new Error(`${name} must be an array of non-empty strings`);
    }

    return entries;
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
        throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
    }
}

function assertOptionalPositiveInteger(value: unknown, name: string, max?: number): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    if (max !== undefined && value > max) {
        throw new Error(`${name} must be an integer from 1 to ${max}`);
    }
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${name} must be a non-empty string`);
    }

    return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLifecycle(value: unknown): SandboxLifecycleConfig {
    if (!isPlainObject(value)) {
        throw new Error("config.lifecycle must be an object");
    }
    assertOptionalPositiveInteger(value.idleTimeoutSeconds, "config.lifecycle.idleTimeoutSeconds", MAX_IDLE_TIMEOUT_SECONDS);
    assertOptionalPositiveInteger(value.maxLifetimeSeconds, "config.lifecycle.maxLifetimeSeconds", MAX_LIFETIME_SECONDS);

    return {
        ...(value.idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds: value.idleTimeoutSeconds as number } : {}),
        ...(value.maxLifetimeSeconds !== undefined ? { maxLifetimeSeconds: value.maxLifetimeSeconds as number } : {}),
    };
}

function validateProviderOptions(provider: SandboxProvider, options: unknown): void {
    if (!isPlainObject(options)) {
        return;
    }
    if (provider === "lambda" && "functionNames" in options) {
        throw new Error("config.options.functionNames is not supported in account sandbox config");
    }
    if (provider === "vercel" && "runtime" in options && typeof options.runtime !== "string") {
        throw new Error("config.options.runtime must be a string");
    }
}

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === "") {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
}

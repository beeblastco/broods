/**
 * Sandbox config: account-scoped, reusable sandbox definitions referenced by
 * agents via `config.sandbox`. A sandbox is a collection of Claude-Code-style
 * tools (bash/read/write/edit/glob/grep) backed by a provider (lambda/e2b/
 * daytona/kubernetes). Validation + the public projection live here; the
 * DynamoDB / Convex stores call these at their create/update entry points.
 * Stored encrypted at rest because `envVars`/`options` may hold secrets.
 */

import { workspaceSandboxLimits } from "../sandbox.ts";
import { mergeConfigObjects, redactConfigSecrets } from "./agent-config.ts";

export type SandboxProvider = "lambda" | "e2b" | "daytona" | "kubernetes";
export type SandboxRuntimeName = "bash" | "python" | "node";
export type SandboxPermissionMode = "edit" | "ask" | "bypass";

const SANDBOX_PROVIDERS: readonly SandboxProvider[] = ["lambda", "e2b", "daytona", "kubernetes"];
const SANDBOX_RUNTIMES: readonly SandboxRuntimeName[] = ["bash", "python", "node"];
const SANDBOX_PERMISSION_MODES: readonly SandboxPermissionMode[] = ["edit", "ask", "bypass"];
const REDACTED_SECRET_VALUE = "********";

export interface SandboxConfig {
  provider: SandboxProvider;
  // Advisory runtime allow-list (best-effort harness-side; see docs).
  runtimes?: SandboxRuntimeName[];
  // Selects the internet-on vs internet-off deployed function (lambda provider).
  internet?: boolean;
  // Tool approval policy: edit|ask|bypass (replaces the old needsApproval boolean).
  permissionMode?: SandboxPermissionMode;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  // Env vars injected into every run. Reserved runtime vars always win and the
  // host process.env is never inherited (the sandbox env_clear()s first).
  envVars?: Record<string, string>;
  // Provider-specific knobs (e2b/daytona/kubernetes endpoints, templates, etc.).
  options?: Record<string, unknown>;
}

export interface SandboxConfigRecord {
  accountId: string;
  sandboxId: string;
  name: string;
  description?: string;
  config: SandboxConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSandboxConfigInput {
  name: string;
  description?: string;
  config: unknown;
}

export interface UpdateSandboxConfigInput {
  name?: string;
  description?: string | null;
  config?: unknown;
}

export function normalizeSandboxConfig(value: unknown): SandboxConfig {
  if (value == null) {
    return { provider: "lambda", permissionMode: "ask" };
  }
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  const config = value;
  assertOptionalEnum(config.provider, "config.provider", SANDBOX_PROVIDERS);
  assertOptionalEnum(config.permissionMode, "config.permissionMode", SANDBOX_PERMISSION_MODES);
  assertOptionalBoolean(config.internet, "config.internet");

  if (config.runtimes !== undefined) {
    if (
      !Array.isArray(config.runtimes) ||
      config.runtimes.length === 0 ||
      !config.runtimes.every((entry) => typeof entry === "string" && SANDBOX_RUNTIMES.includes(entry as SandboxRuntimeName))
    ) {
      throw new Error(`config.runtimes must be a non-empty array of: ${SANDBOX_RUNTIMES.join(", ")}`);
    }
  }

  // Provider-aware ceilings: lambda is bounded by its function; persistent
  // providers (e2b/daytona/kubernetes) are operator-sized (no memory max here).
  const limits = workspaceSandboxLimits((config.provider as SandboxProvider | undefined) ?? "lambda");
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
    validateProviderOptions((config.provider as SandboxProvider | undefined) ?? "lambda", config.options);
  }

  return {
    provider: (config.provider as SandboxProvider | undefined) ?? "lambda",
    permissionMode: (config.permissionMode as SandboxPermissionMode | undefined) ?? "ask",
    ...(config.internet !== undefined ? { internet: config.internet as boolean } : {}),
    ...(config.runtimes !== undefined ? { runtimes: [...(config.runtimes as SandboxRuntimeName[])] } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout as number } : {}),
    ...(config.memoryLimit !== undefined ? { memoryLimit: config.memoryLimit as number } : {}),
    ...(config.outputLimitBytes !== undefined ? { outputLimitBytes: config.outputLimitBytes as number } : {}),
    ...(config.envVars !== undefined ? { envVars: { ...(config.envVars as Record<string, string>) } } : {}),
    ...(config.options !== undefined ? { options: { ...(config.options as Record<string, unknown>) } } : {}),
  };
}

export function normalizeCreateSandboxConfigInput(
  value: CreateSandboxConfigInput,
): { name: string; description?: string; config: SandboxConfig } {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const config = normalizeSandboxConfig(value.config);
  return { name, ...(description ? { description } : {}), config };
}

export function normalizeUpdateSandboxConfigInput(
  existingConfig: SandboxConfig,
  value: UpdateSandboxConfigInput,
): UpdateSandboxConfigInput & { config: SandboxConfig } {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");

  const config = "config" in value
    ? normalizeSandboxConfig(mergeConfigObjects(existingConfig, asObject(value.config)))
    : existingConfig;

  return {
    ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
    ...(value.description !== undefined
      ? { description: value.description === null ? null : optionalString(value.description, "description") }
      : {}),
    config,
  };
}

export function toPublicSandboxConfig(record: SandboxConfigRecord): SandboxConfigRecord {
  return { ...record, config: redactSandboxConfigSecrets(record.config) };
}

function redactSandboxConfigSecrets(config: SandboxConfig): SandboxConfig {
  // redactConfigSecrets catches secret-shaped option keys (apiKey/token/secret).
  // envVars values are opaque and may hold secrets, so redact every value.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
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

function validateProviderOptions(provider: SandboxProvider, options: unknown): void {
  if (!isPlainObject(options)) {
    return;
  }
  if (provider === "lambda" && "functionNames" in options) {
    throw new Error("config.options.functionNames is not supported in account sandbox config");
  }
  if (provider !== "kubernetes") {
    return;
  }

  const disallowed = [
    "kubeconfig",
    "kubeconfigSsmParam",
    "namespace",
    "image",
    "serviceAccountName",
    "imagePullSecrets",
  ].filter((key) => key in options);
  if (disallowed.length > 0) {
    throw new Error(`config.options.${disallowed[0]} is managed by the service and cannot be set in account sandbox config`);
  }
}

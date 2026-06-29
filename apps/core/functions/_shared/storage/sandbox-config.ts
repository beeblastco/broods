/**
 * Sandbox config: account-scoped, reusable sandbox definitions referenced by
 * agents via `config.sandbox`. A sandbox is a collection of Claude-Code-style
 * tools (bash/read/write/edit/glob/grep) backed by a provider. Validation +
 * the public projection live here; the
 * DynamoDB / Convex stores call these at their create/update entry points.
 * Stored encrypted at rest because `envVars`/`options` may hold secrets.
 */

import {
  MAX_IDLE_TIMEOUT_SECONDS,
  MAX_LIFETIME_SECONDS,
  workspaceSandboxLimits,
} from "../sandbox.ts";
import { SANDBOX_SIZE_NAMES, type SandboxSize } from "../sandbox-sizes.ts";
import { isPlainObject, isStringRecord } from "../object.ts";
import { mergeConfigObjects, redactConfigSecrets } from "./agent-config.ts";

// "sandbox" is the self-hosted workdir (Firecracker) provider — the vanilla,
// most-featured backend. `lambda` remains the default until the workdir/MicroVM
// data planes are provisioned (see createSandboxExecutor).
export type SandboxProvider = "sandbox" | "lambda" | "e2b" | "daytona" | "vercel";
export type SandboxRuntimeName = "bash" | "python" | "node";
export type SandboxPermissionMode = "edit" | "ask" | "bypass";
export type SandboxNetworkMode = "allow-all" | "deny-all" | "restricted";

const SANDBOX_PROVIDERS: readonly SandboxProvider[] = ["sandbox", "lambda", "e2b", "daytona", "vercel"];
const SANDBOX_RUNTIMES: readonly SandboxRuntimeName[] = ["bash", "python", "node"];
const SANDBOX_PERMISSION_MODES: readonly SandboxPermissionMode[] = ["edit", "ask", "bypass"];
const SANDBOX_NETWORK_MODES: readonly SandboxNetworkMode[] = ["allow-all", "deny-all", "restricted"];
const REDACTED_SECRET_VALUE = "********";

export interface SandboxLifecycleConfig {
  // Scale to 0 / stop after this many idle seconds with no running job.
  idleTimeoutSeconds?: number;
  // Hard expiry from creation, regardless of activity. Omit for no expiry.
  maxLifetimeSeconds?: number;
}

export interface SandboxNetworkConfig {
  mode: SandboxNetworkMode;
  allowDomains?: string[];
  allowCidrs?: string[];
}

export interface SandboxConfig {
  provider: SandboxProvider;
  // Predefined compute size (tiny|xsmall|small|medium|large). Drives workdir
  // create-time resources and the control-plane specs; advisory on providers that
  // size natively (MicroVM bakes size into the image; daytona/e2b/vercel size
  // themselves). Defaults to the provider's own default when unset.
  size?: SandboxSize;
  // Prebuilt image/snapshot to launch from: a workdir image id/name, or a MicroVM
  // image ARN. Unset boots the provider's default base image. Consumed by the
  // self-hosted backends (`sandbox`/`lambda`); advisory on daytona/e2b/vercel,
  // which select images through their own `options`. The launched-from id is
  // mirrored onto the dashboard instance row (Snapshots/Images view).
  snapshot?: string;
  // Advisory runtime allow-list (best-effort harness-side; see docs).
  runtimes?: SandboxRuntimeName[];
  // Provider-normalized egress policy. Unset input normalizes to deny-all.
  network?: SandboxNetworkConfig;
  // Tool approval policy: edit|ask|bypass (replaces the old needsApproval boolean).
  permissionMode?: SandboxPermissionMode;
  // Reserve a long-lived sandbox per workspace namespace (reconnect across calls,
  // run background jobs, persist installed packages). For `lambda` this reserves a
  // snapshot-resumable MicroVM (suspend/resume on idle).
  persistent?: boolean;
  // Idle/expiry policy when `persistent` is true.
  lifecycle?: SandboxLifecycleConfig;
  // Command hooks for persistent sandboxes.
  onCreate?: string[];
  onResume?: string[];
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  // Env vars injected into every run. Reserved runtime vars always win and the
  // host process.env is never inherited (the sandbox env_clear()s first).
  envVars?: Record<string, undefined | string>;
  // Provider-specific knobs (e2b/daytona endpoints, templates, etc.).
  options?: Record<string, unknown>;
}

export interface SandboxConfigRecord {
  accountId: string;
  sandboxId: string;
  projectId?: string;
  environmentId?: string;
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
      !config.runtimes.every((entry) => typeof entry === "string" && SANDBOX_RUNTIMES.includes(entry as SandboxRuntimeName))
    ) {
      throw new Error(`config.runtimes must be a non-empty array of: ${SANDBOX_RUNTIMES.join(", ")}`);
    }
  }

  // Provider-aware ceilings: lambda is bounded by its function; persistent
  // providers (sandbox/e2b/daytona) are operator-sized (no memory max here).
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
    provider,
    network,
    permissionMode: (config.permissionMode as SandboxPermissionMode | undefined) ?? "ask",
    ...(config.size !== undefined ? { size: config.size as SandboxSize } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(config.persistent !== undefined ? { persistent: config.persistent as boolean } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(onCreate ? { onCreate } : {}),
    ...(onResume ? { onResume } : {}),
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
  const mode = (value.mode as SandboxNetworkMode | undefined) ?? "deny-all";
  const allowDomains = normalizeOptionalStringList(value.allowDomains, "config.network.allowDomains");
  const allowCidrs = normalizeOptionalStringList(value.allowCidrs, "config.network.allowCidrs");
  if (mode !== "restricted" && (allowDomains || allowCidrs)) {
    throw new Error("config.network.allowDomains and config.network.allowCidrs are only valid when config.network.mode is restricted");
  }
  return {
    mode,
    ...(allowDomains ? { allowDomains } : {}),
    ...(allowCidrs ? { allowCidrs } : {}),
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

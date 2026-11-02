import { z } from "zod/mini";

import { assertPublicHttpsUrl } from "./agentRules";
import { mergeConfigObjects } from "./configValues";
import {
  nonEmptyString,
  nonEmptyStrings,
  parseInput,
  resourceCreateInput,
  resourceUpdateInput,
  stringRecord,
  wholeValue,
} from "./inputSchema";
import { configObject, stringValues } from "./storedJson";
import { normalizeHeaders } from "./mcp";
import {
  MOUNT_FLAG_SANDBOX_PROVIDERS,
  PLATFORM_WORKER_SANDBOX_PROVIDERS,
  SANDBOX_PROVIDERS,
  SNAPSHOT_SANDBOX_PROVIDERS,
  STATELESS_SANDBOX_PROVIDERS,
  type SandboxProvider,
} from "./sandboxProviders";
import { assertStorageEndpoint } from "./workspaceRules";
import { ClientError } from "./clientError";

export {
  PLATFORM_WORKER_SANDBOX_PROVIDERS,
  SANDBOX_PROVIDERS,
  SNAPSHOT_SANDBOX_PROVIDERS,
  STATELESS_SANDBOX_PROVIDERS,
  type SandboxProvider,
} from "./sandboxProviders";

export const DEFAULT_SANDBOX_PROVIDER: SandboxProvider = "lambda";

// Core boots each as `<default image name>-<variant>` in the default image's account.
export const SANDBOX_IMAGES = ["browser", "obscura"] as const;

export const SANDBOX_RUNTIMES = ["bash", "python", "node"] as const;
export const SANDBOX_PERMISSION_MODES = ["edit", "ask", "bypass"] as const;

export const SANDBOX_NETWORK_MODES = [
  "allow-all",
  "deny-all",
  "restricted",
] as const;

export const SANDBOX_SIZE_NAMES = [
  "tiny",
  "xsmall",
  "small",
  "medium",
  "large",
] as const;

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const LAMBDA_MAX_TIMEOUT_SECONDS = 600;
export const PERSISTENT_MAX_TIMEOUT_SECONDS = 600;
export const MAX_IDLE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// Cloudflare refuses a Container idle timeout over 6h; Vercel caps a Pro session at 24h.
const PROVIDER_MAX_IDLE_TIMEOUT_SECONDS: Partial<
  Record<SandboxProvider, number>
> = {
  cloudflare: 6 * 60 * 60,
  vercel: 24 * 60 * 60,
};
// Must match MAX_TIMEOUT_MS in apps/cloudflare-worker/src/limits.ts.
export const WORKER_MAX_TIMEOUT_SECONDS = 60;
const PLATFORM_OPTION_KEYS: ReadonlySet<string> = new Set([
  "reservationKey",
  "workspaceRoot",
]);
const RETIRED_IMAGE_OPTIONS: Partial<
  Record<SandboxProvider, readonly string[]>
> = {
  daytona: ["snapshot"],
  e2b: ["template", "templateId"],
  vercel: ["image", "runtime"],
};

const POSITIVE_INTEGER = z
  .number({ error: "must be a positive integer" })
  .check(
    z.refine((value): boolean => Number.isSafeInteger(value) && value >= 1, {
      error: "must be a positive integer",
    }),
  );
const HOOK_LIST = wholeValue(
  z.array(nonEmptyString).check(z.minLength(1)),
  "must be a non-empty array of non-empty strings",
);
const SANDBOX_CONFIG_INPUT = z.looseObject({
  provider: z.optional(z.enum(SANDBOX_PROVIDERS)),
  fallbackProvider: z.optional(z.enum(SANDBOX_PROVIDERS)),
  permissionMode: z.optional(z.enum(SANDBOX_PERMISSION_MODES)),
  size: z.optional(z.enum(SANDBOX_SIZE_NAMES)),
  persistent: z.optional(z.boolean()),
  snapshot: z.optional(z.string()),
  image: z.optional(z.enum(SANDBOX_IMAGES)),
  network: z.optional(
    z.looseObject({
      mode: z.optional(z.enum(SANDBOX_NETWORK_MODES)),
      allowDomains: z.optional(nonEmptyStrings),
      allowCidrs: z.optional(nonEmptyStrings),
    }),
  ),
  lifecycle: z.optional(
    z.object({
      idleTimeoutSeconds: z.optional(
        boundedPositiveInteger(MAX_IDLE_TIMEOUT_SECONDS),
      ),
      maxLifetimeSeconds: z.optional(
        boundedPositiveInteger(MAX_LIFETIME_SECONDS),
      ),
    }),
  ),
  onCreate: z.optional(HOOK_LIST),
  onResume: z.optional(HOOK_LIST),
  runtimes: z.optional(
    wholeValue(
      z.array(z.enum(SANDBOX_RUNTIMES)).check(z.minLength(1)),
      `must be a non-empty array of: ${SANDBOX_RUNTIMES.join(", ")}`,
    ),
  ),
  timeout: z.optional(POSITIVE_INTEGER),
  outputLimitBytes: z.optional(POSITIVE_INTEGER),
  envVars: z.optional(stringRecord("must be an object with string values")),
  options: z.optional(configObject),
});

type SandboxConfigInput = z.output<typeof SANDBOX_CONFIG_INPUT>;

export type RuntimeName = (typeof SANDBOX_RUNTIMES)[number];

export type PermissionMode = (typeof SANDBOX_PERMISSION_MODES)[number];

export type NetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

export type SandboxSize = (typeof SANDBOX_SIZE_NAMES)[number];

export type SandboxImage = (typeof SANDBOX_IMAGES)[number];

export interface SandboxLifecycleConfig {
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
}

export interface SandboxNetworkConfig {
  mode: NetworkMode;
  allowDomains?: string[];
  allowCidrs?: string[];
}

export interface SandboxConfig {
  provider: SandboxProvider;
  fallbackProvider?: SandboxProvider;
  size?: SandboxSize;
  image?: SandboxImage;
  snapshot?: string;
  runtimes?: RuntimeName[];
  network?: SandboxNetworkConfig;
  permissionMode?: PermissionMode;
  persistent?: boolean;
  lifecycle?: SandboxLifecycleConfig;
  onCreate?: string[];
  onResume?: string[];
  timeout?: number;
  outputLimitBytes?: number;
  envVars?: Record<string, undefined | string>;
  options?: Record<string, unknown>;
}

export interface WorkspaceSandboxLimits {
  maxTimeoutSeconds: number;
  maxOutputLimitBytes: number;
}

export function workspaceSandboxLimits(
  provider: SandboxProvider = "lambda",
): WorkspaceSandboxLimits {
  return {
    maxTimeoutSeconds:
      provider === "lambda"
        ? positiveIntegerEnv(
            "WORKSPACE_SANDBOX_LAMBDA_MAX_TIMEOUT_SECONDS",
            LAMBDA_MAX_TIMEOUT_SECONDS,
          )
        : provider === "worker"
          ? WORKER_MAX_TIMEOUT_SECONDS
          : positiveIntegerEnv(
              "WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS",
              PERSISTENT_MAX_TIMEOUT_SECONDS,
            ),
    maxOutputLimitBytes: positiveIntegerEnv(
      "WORKSPACE_SANDBOX_MAX_OUTPUT_LIMIT_BYTES",
      DEFAULT_MAX_OUTPUT_LIMIT_BYTES,
    ),
  };
}

export function normalizeSandboxConfig(
  value: unknown,
  stored?: SandboxConfig,
): SandboxConfig {
  if (value == null) {
    return {
      provider: DEFAULT_SANDBOX_PROVIDER,
      permissionMode: "ask",
      network: { mode: "deny-all" },
    };
  }
  const config = parseInput(SANDBOX_CONFIG_INPUT, value, "config");
  if ("internet" in config) {
    throw new ClientError(
      "config.internet is no longer supported; use config.network",
    );
  }
  const provider = config.provider ?? DEFAULT_SANDBOX_PROVIDER;
  const { fallbackProvider, image } = config;
  const snapshot = config.snapshot?.trim() || undefined;
  if (
    config.snapshot !== undefined &&
    !SNAPSHOT_SANDBOX_PROVIDERS.has(provider)
  ) {
    throw new ClientError(
      `config.snapshot does not apply to the ${provider} provider`,
    );
  }
  assertImage(image, provider, fallbackProvider);

  if (fallbackProvider === provider) {
    throw new ClientError(
      "config.fallbackProvider must differ from config.provider",
    );
  }
  // A machine is one computer, and a custom server's options do not carry over to a fallback.
  if (fallbackProvider && STATELESS_SANDBOX_PROVIDERS.has(fallbackProvider)) {
    throw new ClientError(
      `config.fallbackProvider cannot be ${fallbackProvider}`,
    );
  }
  if (fallbackProvider !== undefined && config.persistent === true) {
    throw new ClientError(
      "config.fallbackProvider requires config.persistent to be false: a reserved sandbox belongs to one provider",
    );
  }
  assertStatelessProviderFields(config, provider);
  const network = normalizeNetwork(config.network);
  const persistentFields = normalizePersistentFields(config, provider);
  for (const runsOn of fallbackProvider
    ? [provider, fallbackProvider]
    : [provider]) {
    assertNetworkEnforceable(runsOn, network);
    assertResourceLimits(config, runsOn);
  }
  assertEnvVarsAndOptions(config, provider, stored);

  return buildNormalizedConfig(
    config,
    provider,
    fallbackProvider,
    network,
    image,
    snapshot,
    persistentFields,
  );
}

export function normalizeCreateSandboxConfigInput(value: unknown): {
  name: string;
  description?: string;
  config: SandboxConfig;
} {
  const input = parseInput(resourceCreateInput, value, "");
  const name = input.name.trim();
  const description = input.description?.trim() || undefined;
  const config = normalizeSandboxConfig(input.config);

  return {
    name: name,
    ...(description ? { description: description } : {}),
    config: config,
  };
}

export function assertNoRetiredImageOptions(
  provider: SandboxProvider,
  options: Record<string, unknown>,
): void {
  for (const key of RETIRED_IMAGE_OPTIONS[provider] ?? []) {
    if (key in options) {
      throw new ClientError(
        `config.options.${key} was removed; set config.snapshot to pick what a ${provider} sandbox boots from`,
      );
    }
  }
}

// Mirrors sandboxSnapshotScopeValidator.
export type SandboxScope = "account" | { projectId: string; stageId: string };

export function sandboxScope<P extends string, S extends string>(row: {
  projectId?: P;
  stageId?: S;
}): "account" | { projectId: P; stageId: S } {
  return row.projectId && row.stageId
    ? { projectId: row.projectId, stageId: row.stageId }
    : "account";
}

export function browserSandboxRefusal(
  sandbox:
    | { provider?: string; image?: unknown; network?: { mode?: unknown } }
    | undefined,
): string | null {
  if (sandbox?.provider === "machine") return null;
  if (sandbox?.provider !== "lambda" || sandbox.image !== "obscura") {
    return 'config.browser needs the agent\'s first sandbox on provider lambda with image: "obscura", or a machine sandbox with obscura installed';
  }
  if (sandbox.network?.mode !== "allow-all") {
    return "config.browser needs the agent's first sandbox to set network.mode to allow-all";
  }

  return null;
}

// A snapshot is a copy of another sandbox's disk: it boots only on its own account and stage.
export function snapshotBootRefusal(
  snapshot: { accountId: string; scope?: SandboxScope },
  sandbox: { accountId: string; scope: SandboxScope },
): string | null {
  if (snapshot.accountId !== sandbox.accountId) {
    return "config.snapshot names a snapshot of another account";
  }
  if (snapshot.scope === undefined) {
    return "config.snapshot names a snapshot taken before snapshots were locked to a stage; take it again from a sandbox on this stage";
  }
  const same =
    snapshot.scope === "account" || sandbox.scope === "account"
      ? snapshot.scope === sandbox.scope
      : snapshot.scope.projectId === sandbox.scope.projectId &&
        snapshot.scope.stageId === sandbox.scope.stageId;

  return same
    ? null
    : "config.snapshot names a snapshot taken on another stage; a sandbox boots only snapshots taken on its own stage";
}

export function normalizeUpdateSandboxConfigInput(
  existingConfig: SandboxConfig,
  value: unknown,
): { name?: string; description?: string | null; config: SandboxConfig } {
  const input = parseInput(resourceUpdateInput, value, "");
  const config =
    "config" in input
      ? normalizeSandboxConfig(
          mergeConfigObjects(
            existingConfig,
            parseInput(configObject, input.config, "config"),
          ),
          existingConfig,
        )
      : existingConfig;

  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : input.description.trim() || undefined,
        }
      : {}),
    config: config,
  };
}

function assertCustomOptions(
  options: Record<string, unknown>,
  storedHeaders: unknown,
): void {
  if (typeof options.endpoint !== "string") {
    throw new ClientError(
      "config.options.endpoint is required for the custom provider: the https URL of your sandbox server",
    );
  }
  const endpoint = assertPublicHttpsUrl(
    options.endpoint,
    "config.options.endpoint",
  );
  // Core appends `/exec` to the string, so anything after the path is lost.
  if (endpoint.search || endpoint.hash) {
    throw new ClientError(
      "config.options.endpoint must not carry a query or fragment",
    );
  }
  if (options.token !== undefined) {
    requireString(options.token, "config.options.token");
  }
  if (options.headers !== undefined) {
    const stored = stringValues.safeParse(storedHeaders);
    normalizeHeaders(options.headers, stored.success ? stored.data : undefined);
  }
}

function assertEnvVarsAndOptions(
  config: SandboxConfigInput,
  provider: SandboxProvider,
  stored: SandboxConfig | undefined,
): void {
  if (config.options !== undefined) {
    validateProviderOptions(provider, config.options, config.snapshot);
  }
  if (provider === "custom") {
    assertCustomOptions(config.options ?? {}, stored?.options?.headers);
  }
}

function assertImage(
  image: SandboxImage | undefined,
  provider: SandboxProvider,
  fallbackProvider: SandboxProvider | undefined,
): void {
  if (image === undefined) return;
  if (provider !== "lambda") {
    throw new ClientError("config.image applies to the lambda provider only");
  }
  if (fallbackProvider !== undefined) {
    throw new ClientError(
      "config.image cannot be set with config.fallbackProvider: the fallback provider has no platform image variants",
    );
  }
}

function assertNetworkEnforceable(
  provider: SandboxProvider,
  network: SandboxNetworkConfig,
): void {
  if (
    (provider === "e2b" || STATELESS_SANDBOX_PROVIDERS.has(provider)) &&
    network.mode !== "allow-all"
  ) {
    throw new ClientError(
      `${provider} cannot enforce egress restrictions; set config.network.mode to allow-all explicitly`,
    );
  }
  if (
    PLATFORM_WORKER_SANDBOX_PROVIDERS.has(provider) &&
    network.mode === "restricted"
  ) {
    throw new ClientError(
      `${provider} can only turn a sandbox's internet on or off; use config.network.mode deny-all or allow-all`,
    );
  }
  if (
    provider === "lambda" &&
    network.mode === "restricted" &&
    (network.allowDomains || network.allowCidrs)
  ) {
    throw new ClientError(
      "lambda (MicroVM) cannot enforce per-sandbox allowlists: its egress connector is fixed at deploy time; use config.network.mode deny-all or allow-all",
    );
  }
}

function assertResourceLimits(
  config: SandboxConfigInput,
  provider: SandboxProvider,
): void {
  const limits = workspaceSandboxLimits(provider);
  for (const [name, value, max] of [
    ["timeout", config.timeout, limits.maxTimeoutSeconds],
    ["outputLimitBytes", config.outputLimitBytes, limits.maxOutputLimitBytes],
  ] as const) {
    if (value !== undefined && value > max)
      throw new ClientError(
        `config.${name} must be an integer from 1 to ${max}`,
      );
  }
}

function assertStatelessProviderFields(
  config: SandboxConfigInput,
  provider: SandboxProvider,
): void {
  if (!STATELESS_SANDBOX_PROVIDERS.has(provider)) return;
  for (const field of ["persistent", "size"] as const) {
    if (config[field] !== undefined) {
      throw new ClientError(
        `config.${field} does not apply to the ${provider} provider`,
      );
    }
  }
}

function buildNormalizedConfig(
  config: SandboxConfigInput,
  provider: SandboxProvider,
  fallbackProvider: SandboxProvider | undefined,
  network: SandboxNetworkConfig,
  image: SandboxImage | undefined,
  snapshot: string | undefined,
  persistentFields: Pick<SandboxConfig, "lifecycle" | "onCreate" | "onResume">,
): SandboxConfig {
  return {
    provider: provider,
    ...(fallbackProvider ? { fallbackProvider: fallbackProvider } : {}),
    network: network,
    permissionMode: config.permissionMode ?? "ask",
    ...(config.size !== undefined ? { size: config.size } : {}),
    ...(image ? { image: image } : {}),
    ...(snapshot ? { snapshot: snapshot } : {}),
    ...(config.persistent !== undefined
      ? { persistent: config.persistent }
      : {}),
    ...persistentFields,
    ...(config.runtimes !== undefined
      ? { runtimes: [...config.runtimes] }
      : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.outputLimitBytes !== undefined
      ? { outputLimitBytes: config.outputLimitBytes }
      : {}),
    ...(config.envVars !== undefined ? { envVars: { ...config.envVars } } : {}),
    ...(config.options !== undefined ? { options: { ...config.options } } : {}),
  };
}

function normalizeNetwork(
  value: SandboxConfigInput["network"],
): SandboxNetworkConfig {
  if (value === undefined) {
    return { mode: "deny-all" };
  }
  const mode = value.mode ?? "deny-all";
  const allowDomains = value.allowDomains?.map((entry) => entry.trim());
  const allowCidrs = value.allowCidrs?.map((entry) => entry.trim());
  if (mode !== "restricted" && (allowDomains || allowCidrs)) {
    throw new ClientError(
      "config.network.allowDomains and config.network.allowCidrs are only valid when config.network.mode is restricted",
    );
  }

  return {
    mode: mode,
    ...(allowDomains ? { allowDomains: allowDomains } : {}),
    ...(allowCidrs ? { allowCidrs: allowCidrs } : {}),
  };
}

function assertWorkerLifecycle(
  config: SandboxConfigInput,
  provider: SandboxProvider,
  lifecycle: SandboxConfig["lifecycle"],
): void {
  if (!PLATFORM_WORKER_SANDBOX_PROVIDERS.has(provider)) return;
  for (const field of ["onCreate", "onResume"] as const) {
    if (config[field] !== undefined)
      throw new ClientError(
        `config.${field} is not supported by the ${provider} provider; the Worker sets the machine`,
      );
  }
  if (provider === "worker") {
    if (lifecycle !== undefined)
      throw new ClientError(
        "config.lifecycle is not supported by the worker provider: nothing runs between commands, and stored files stay until the sandbox is terminated",
      );

    return;
  }
  if (lifecycle?.maxLifetimeSeconds !== undefined)
    throw new ClientError(
      "config.lifecycle.maxLifetimeSeconds is not supported by the cloudflare provider",
    );
}

function normalizePersistentFields(
  config: SandboxConfigInput,
  provider: SandboxProvider,
): Pick<SandboxConfig, "lifecycle" | "onCreate" | "onResume"> {
  const { lifecycle } = config;
  if (lifecycle && config.persistent !== true) {
    throw new ClientError(
      "config.lifecycle requires config.persistent to be true",
    );
  }
  const onCreate = config.onCreate?.map((entry) => entry.trim());
  const onResume = config.onResume?.map((entry) => entry.trim());
  if ((onCreate || onResume) && config.persistent !== true) {
    throw new ClientError(
      "config.onCreate and config.onResume require config.persistent to be true",
    );
  }
  assertWorkerLifecycle(config, provider, lifecycle);
  const maxIdle = PROVIDER_MAX_IDLE_TIMEOUT_SECONDS[provider];
  if (maxIdle !== undefined && (lifecycle?.idleTimeoutSeconds ?? 0) > maxIdle) {
    throw new ClientError(
      `config.lifecycle.idleTimeoutSeconds must be at most ${maxIdle} on the ${provider} provider`,
    );
  }
  if (provider === "e2b" && (onCreate || onResume)) {
    throw new ClientError(
      "config.onCreate and config.onResume are not supported by the e2b provider; use an E2B template or run setup commands explicitly",
    );
  }

  return {
    ...(lifecycle ? { lifecycle: lifecycle } : {}),
    ...(onCreate ? { onCreate: onCreate } : {}),
    ...(onResume ? { onResume: onResume } : {}),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ClientError(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ClientError(`${name} must be a positive integer`);
  }

  return parsed;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientError(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function validateProviderOptions(
  provider: SandboxProvider,
  options: Record<string, unknown>,
  snapshot: unknown,
): void {
  if ("docker" in options) {
    if (typeof options.docker !== "boolean") {
      throw new ClientError("config.options.docker must be a boolean");
    }
    if (provider !== "sandbox") {
      throw new ClientError(
        "config.options.docker is only supported by the sandbox provider",
      );
    }
  }
  if (
    provider === "lambda" ||
    PLATFORM_WORKER_SANDBOX_PROVIDERS.has(provider)
  ) {
    for (const key of Object.keys(options)) {
      if (!PLATFORM_OPTION_KEYS.has(key)) {
        throw new ClientError(
          `config.options.${key} is not supported in account sandbox config`,
        );
      }
    }
  }
  if ("networkId" in options) {
    requireString(options.networkId, "config.options.networkId");
    if (provider !== "vercel") {
      throw new ClientError(
        "config.options.networkId is only supported by the vercel provider",
      );
    }
  }
  if ("mountAwsS3Buckets" in options) {
    if (typeof options.mountAwsS3Buckets !== "boolean") {
      throw new ClientError(
        "config.options.mountAwsS3Buckets must be a boolean",
      );
    }
    if (!MOUNT_FLAG_SANDBOX_PROVIDERS.has(provider)) {
      throw new ClientError(
        `config.options.mountAwsS3Buckets is only read by the daytona and sandbox providers, not ${provider}; lambda and vercel mount any attached workspace without it`,
      );
    }
  }
  if (provider === "machine" && "cwd" in options) {
    requireString(options.cwd, "config.options.cwd");
  }
  if ("s3Endpoint" in options) {
    assertStorageEndpoint(
      requireString(options.s3Endpoint, "config.options.s3Endpoint"),
      "config.options.s3Endpoint",
    );
  }
  assertNoRetiredImageOptions(provider, options);
  if (
    provider === "daytona" &&
    optionalString(options.image, "config.options.image") !== undefined &&
    snapshot !== undefined
  ) {
    throw new ClientError(
      "config.snapshot and config.options.image cannot both be set: Daytona boots a snapshot or builds one from an image",
    );
  }
}

function boundedPositiveInteger(max: number): z.ZodMiniNumber {
  return POSITIVE_INTEGER.check(
    z.refine((value): boolean => value <= max, {
      error: `must be an integer from 1 to ${max}`,
    }),
  );
}

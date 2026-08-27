/**
 * Account-owned custom tool upload validation for Convex config-plane sync.
 * Mirrors core's account tool upload contract without requiring the Node runtime.
 */

import { sha256Hex } from "./accountSecrets";
import { isPlainObject } from "./objects";

export interface AccountToolUploadInput {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  bundle?: unknown;
  runtime?: unknown;
  defaultConfig?: unknown;
}

/**
 * Execution tier for an uploaded tool bundle: "isolate" runs in core's V8
 * isolate, "sandbox" delegates to the workdir sandbox provider.
 */
export type AccountToolRuntime = "isolate" | "sandbox";

export interface NormalizedAccountToolUpload {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  bundle?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  defaultConfig?: Record<string, unknown>;
}

export interface RequiredAccountToolUpload {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  bundle: string;
  sha256: string;
  runtime: AccountToolRuntime;
  defaultConfig?: Record<string, unknown>;
}

const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Matches the CLI's MAX_BUNDLE_FILE_BYTES so a bundle that passes CLI validation
// is not rejected at this upload gate — large enough for AI-SDK-derived tools.
// Mirrors core's per-tier bound (apps/core/src/shared/domain/account-tools.ts).
const MAX_BUNDLE_BYTES: Record<AccountToolRuntime, number> = {
  isolate: 1_000_000,
  sandbox: 10_000_000,
};
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[\s\S]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
// Member reads only: a locally declared `process` method or export key is not
// the global (bundled zod ships one), and `typeof process` is a guarded probe.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
// Web Streams are outside what isolate/runner/web-globals.mjs installs, so a
// bundle touching one — every bundle importing `ai` does — runs on sandbox.
const WEB_STREAMS_PATTERN =
  /(?<![.\w$])(?:Readable|Writable|Transform)Stream\b/;

/**
 * Normalize and validate a CLI-supplied custom tool upload.
 * @param input upload object from the CLI manifest
 * @param options whether all creation fields, including bundle, are required
 * @returns normalized fields with bundle sha256 when a bundle is present
 */
export async function normalizeAccountToolUpload(
  input: unknown,
  options: { requireBundle: true; currentRuntime?: AccountToolRuntime },
): Promise<RequiredAccountToolUpload>;
export async function normalizeAccountToolUpload(
  input: unknown,
  options: { requireBundle: false; currentRuntime?: AccountToolRuntime },
): Promise<NormalizedAccountToolUpload>;
export async function normalizeAccountToolUpload(
  input: unknown,
  options: { requireBundle: boolean; currentRuntime?: AccountToolRuntime },
): Promise<NormalizedAccountToolUpload> {
  if (!isPlainObject(input)) {
    throw new Error("tool upload body must be an object");
  }

  const value = input as AccountToolUploadInput;
  const result: Partial<NormalizedAccountToolUpload> = {};

  if (value.name !== undefined) {
    result.name = normalizeToolName(value.name);
  } else if (options.requireBundle) {
    throw new Error("tool.name is required");
  }

  if (value.description !== undefined) {
    result.description = normalizeDescription(value.description);
  } else if (options.requireBundle) {
    throw new Error("tool.description is required");
  }

  if (value.inputSchema !== undefined) {
    result.inputSchema = normalizeInputSchema(value.inputSchema);
  } else if (options.requireBundle) {
    throw new Error("tool.inputSchema is required");
  }

  if (value.bundle !== undefined) {
    result.bundle = normalizeBundle(value.bundle);
  } else if (options.requireBundle) {
    throw new Error("tool.bundle is required");
  }

  if (value.runtime !== undefined) {
    result.runtime = normalizeRuntime(value.runtime);
  } else if (options.requireBundle && result.bundle !== undefined) {
    // Infer the tier only on create/full sync. A bundle-only PATCH keeps the
    // stored runtime so it cannot silently flip an explicitly chosen tier.
    result.runtime = inferAccountToolRuntime(result.bundle);
  }

  // Bound by the tier it will run on — the stored one on a bundle-only PATCH,
  // which deliberately does not restate runtime. Checked before hashing.
  if (result.bundle !== undefined) {
    assertBundleSize(
      result.bundle,
      result.runtime ??
        options.currentRuntime ??
        inferAccountToolRuntime(result.bundle),
    );
    result.sha256 = await sha256Hex(result.bundle);
  }

  if (value.defaultConfig !== undefined) {
    result.defaultConfig = normalizeDefaultConfig(value.defaultConfig);
  }

  return result as NormalizedAccountToolUpload;
}

/**
 * Build the S3 object key used for an account tool bundle.
 * @param accountId account id owning the tool
 * @param sha256 hex sha256 of the bundle contents
 * @returns stable S3 key for the bundle object
 */
export function accountToolBundleStorageKey(
  accountId: string,
  sha256: string,
): string {
  return `account-tools/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

/**
 * Cheap upload-time heuristic for choosing the default execution tier. Bundles
 * that mention Node-only globals, node: imports, require(), bare package
 * imports, or Web Streams need the sandbox tier; everything the isolate's global
 * set covers stays on the faster isolate tier.
 * @param bundleSource bundled JavaScript module source
 * @returns the inferred runtime tier
 */
export function inferAccountToolRuntime(
  bundleSource: string,
): AccountToolRuntime {
  if (
    /\brequire\s*\(/.test(bundleSource) ||
    NODE_BUILTIN_IMPORT_PATTERN.test(bundleSource) ||
    NODE_GLOBAL_MEMBER_PATTERN.test(bundleSource) ||
    WEB_STREAMS_PATTERN.test(bundleSource) ||
    /\b__dirname\b/.test(bundleSource) ||
    BARE_IMPORT_PATTERN.test(bundleSource)
  ) {
    return "sandbox";
  }

  return "isolate";
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tool.name must be a non-empty string");
  }
  const name = value.trim();
  if (!MODEL_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      "tool.name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }

  return name;
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tool.description must be a non-empty string");
  }

  return value.trim();
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("tool.inputSchema must be a JSON Schema object");
  }
  if (
    value.type !== undefined &&
    typeof value.type !== "string" &&
    !Array.isArray(value.type)
  ) {
    throw new Error("tool.inputSchema.type must be a string or array");
  }

  return value;
}

function assertBundleSize(bundle: string, runtime: AccountToolRuntime): void {
  const limit = MAX_BUNDLE_BYTES[runtime];
  if (new TextEncoder().encode(bundle).byteLength > limit) {
    throw new Error(
      `tool.bundle must be ${limit} bytes or smaller on the ${runtime} runtime`,
    );
  }
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tool.bundle must be a non-empty string");
  }

  return value;
}

function normalizeDefaultConfig(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("tool.defaultConfig must be an object");
  }

  return value;
}

/**
 * Validate an explicit runtime tier value from an upload.
 * @param value raw runtime field from the upload body
 * @returns the validated tier
 * @throws when the value is not "isolate" or "sandbox"
 */
function normalizeRuntime(value: unknown): AccountToolRuntime {
  if (value === "isolate" || value === "sandbox") return value;

  throw new Error('tool.runtime must be "isolate" or "sandbox"');
}

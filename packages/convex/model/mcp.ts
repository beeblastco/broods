/**
 * Shared validation for MCP server registrations (#331). One normalizer
 * serves every write path (CLI sync, direct API, dashboard). A `url` makes an "http" row
 * core connects to over the stateless 2026-07-28 transport; a `bundle` makes
 * a "hosted" row served by the tool-runner Lambda, hashed here so sha256
 * always travels with the bundle. Auth header values may carry ${NAME}
 * account env refs; they resolve into the encrypted agent config at sync
 * time, never on this row, and credential-bearing headers must use one
 * instead of an inline secret. `oauth` follows the same rule: clientSecret
 * and refreshToken must be ${NAME} refs, so the row never holds a secret.
 */

import { sha256Hex } from "./accountSecrets";
import { ACCOUNT_ENV_PLACEHOLDER_PATTERN } from "./envRefs";

const MAX_ALLOWED_TOOLS = 256;
/**
 * An inline `bundle` rides the JSON body, which Convex caps at ~20 MB; bigger
 * goes through file storage as `bundleStorageId` (#190). Both values mirror
 * packages/broods/src/manifest.ts (the published CLI cannot import this
 * package) — change both or the CLI accepts what the config plane rejects.
 */
const MAX_INLINE_BUNDLE_BYTES = 10_000_000;
/** Ceiling for a hosted MCP server bundle by either upload path (#190). */
export const MAX_MCP_BUNDLE_BYTES = 50_000_000;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;

/** RFC 9110 field-name token characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** Headers whose values carry credentials and so must use a ${NAME} ref. */
const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Server names become the `server__tool` namespace prefix inside provider
 * tool names, which allow only [A-Za-z0-9_-]. Underscores are excluded here
 * so the `__` separator stays unambiguous.
 */
const MCP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Remote tool names, as constrained by the MCP spec's SHOULD plus our cap. */
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type McpTransport = "http" | "hosted";

/**
 * OAuth 2.0 refresh-token grant for an external row. Core mints access tokens
 * at connect time and sends `Authorization: Bearer <token>`, so a server
 * whose tokens expire (Google's Workspace MCP endpoints) still works where a
 * static header cannot. Secret fields hold ${NAME} refs on the row.
 */
export interface McpOauth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Token endpoint, https only; core defaults to https://oauth2.googleapis.com/token. */
  tokenUrl?: string;
}

export interface McpInput {
  name?: string;
  description?: string;
  transport?: McpTransport;
  url?: string;
  /** Hosted-only: bundled server module source; sha256 derived from it. */
  bundle?: string;
  /**
   * Hosted-only alternative to `bundle` for large uploads: storage id of
   * module source POSTed to an upload URL; its declared sha256 is verified
   * against the bytes before the S3 write.
   */
  bundleStorageId?: string;
  sha256?: string;
  headers?: Record<string, string>;
  oauth?: McpOauth;
  allowedTools?: string[];
  disabled?: boolean;
}

/**
 * The name of the Authorization header as written, whatever its case, or
 * undefined. A row with oauth must not carry one: core mints it itself.
 */
export function authorizationHeaderName(
  headers: Record<string, string> | undefined,
): string | undefined {
  return Object.keys(headers ?? {}).find(
    (name) => name.toLowerCase() === "authorization",
  );
}

/**
 * Build the S3 object key used for a hosted MCP server bundle. Keeping the
 * prefix separate from account-tools/ is what makes the phase 3 deletion and
 * the account-delete sweep (accounts/cleanup.ts) unambiguous.
 */
export function mcpBundleStorageKey(accountId: string, sha256: string): string {
  return `account-mcp/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

/**
 * Validate and normalize an MCP server create or patch body. With
 * `requireConnection` (POST) `name` plus a connection are mandatory: a `url`
 * makes an "http" row, a `bundle` makes a "hosted" one. A patch (PATCH) may
 * carry any subset. Unknown keys are ignored, matching the tolerance of the
 * other config-plane normalizers.
 */
export async function normalizeMcpInput(
  body: unknown,
  options: { requireConnection: boolean },
): Promise<McpInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const input: McpInput = {};
  if (record.name !== undefined) input.name = normalizeName(record.name);
  if (record.description !== undefined && record.description !== null) {
    input.description = normalizeDescription(record.description);
  }
  normalizeConnection(record, input);
  // Hash here (async: Convex's runtime only offers web crypto) so every
  // write path gets sha256 with the bundle; a storage-id upload declares its
  // own, which the S3 writer verifies against the bytes.
  if (input.bundle !== undefined) {
    input.sha256 = await sha256Hex(input.bundle);
  }
  if (record.headers !== undefined && record.headers !== null) {
    input.headers = normalizeHeaders(record.headers);
  }
  if (record.oauth !== undefined && record.oauth !== null) {
    input.oauth = normalizeOauth(record.oauth);
    if (input.bundle !== undefined || input.bundleStorageId !== undefined) {
      throw new Error("oauth applies to external (url) servers, not hosted");
    }
    const authorization = authorizationHeaderName(input.headers);
    if (authorization !== undefined) {
      throw new Error(
        `oauth mints the Authorization header itself; drop the explicit ${authorization} header`,
      );
    }
  }
  if (record.allowedTools !== undefined && record.allowedTools !== null) {
    input.allowedTools = normalizeAllowedTools(record.allowedTools);
  }
  if (record.disabled !== undefined) {
    if (typeof record.disabled !== "boolean") {
      throw new Error("disabled must be a boolean");
    }
    input.disabled = record.disabled;
  }
  if (options.requireConnection) {
    if (input.name === undefined) throw new Error("name must be provided");
    if (
      input.url === undefined &&
      input.bundle === undefined &&
      input.bundleStorageId === undefined
    ) {
      throw new Error("url must be provided, or bundle for a hosted server");
    }
  }

  return input;
}

function normalizeAllowedTools(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("allowedTools must be an array of tool names");
  }
  if (value.length > MAX_ALLOWED_TOOLS) {
    throw new Error(
      `allowedTools must list at most ${MAX_ALLOWED_TOOLS} tools`,
    );
  }
  const names = value as string[];
  for (const name of names) {
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `allowedTools entries must match ${MCP_TOOL_NAME_PATTERN}: ${name}`,
      );
    }
  }

  return names;
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("bundle must be a non-empty string of module source");
  }
  // TextEncoder, not Buffer: this runs in Convex's V8 isolate too.
  if (new TextEncoder().encode(value).byteLength > MAX_INLINE_BUNDLE_BYTES) {
    throw new Error(
      `inline bundle must be at most ${MAX_INLINE_BUNDLE_BYTES} bytes; upload larger bundles (up to ${MAX_MCP_BUNDLE_BYTES}) to an upload URL and pass bundleStorageId`,
    );
  }

  return value;
}

/**
 * A `url` makes an "http" row; a `bundle` or `bundleStorageId` a "hosted"
 * one. Exactly one connection may be given.
 */
function normalizeConnection(
  record: Record<string, unknown>,
  input: McpInput,
): void {
  if (record.url !== undefined) input.url = normalizeUrl(record.url);
  if (record.bundle !== undefined) {
    input.bundle = normalizeBundle(record.bundle);
  }
  if (record.bundleStorageId !== undefined) {
    if (
      typeof record.bundleStorageId !== "string" ||
      record.bundleStorageId.length === 0
    ) {
      throw new Error("bundleStorageId must be a non-empty storage id");
    }
    if (
      typeof record.sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(record.sha256)
    ) {
      throw new Error(
        "bundleStorageId needs sha256, the hex digest of the uploaded bytes",
      );
    }
    input.bundleStorageId = record.bundleStorageId;
    input.sha256 = record.sha256;
  }
  const connections = [input.url, input.bundle, input.bundleStorageId].filter(
    (value) => value !== undefined,
  );
  if (connections.length > 1) {
    throw new Error("url, bundle and bundleStorageId are mutually exclusive");
  }
  if (input.url !== undefined) input.transport = "http";
  if (input.bundle !== undefined || input.bundleStorageId !== undefined) {
    input.transport = "hosted";
  }
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  return value;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("headers must be an object of header name to value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) {
    throw new Error(`headers must contain at most ${MAX_HEADERS} entries`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`headers names must be RFC 9110 tokens: ${name}`);
    }
    if (
      typeof headerValue !== "string" ||
      headerValue.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error(
        `headers values must be single-line strings of at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) &&
      !ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(headerValue)
    ) {
      throw new Error(
        `headers values for ${name} must reference an account env var like \${NAME}, not an inline secret`,
      );
    }
    headers[name] = headerValue;
  }

  return headers;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !MCP_NAME_PATTERN.test(value)) {
    throw new Error(
      "name must be 1-32 lowercase letters, digits or hyphens, starting with a letter",
    );
  }

  return value;
}

/**
 * clientId may be inline (it is not a secret); clientSecret and refreshToken
 * must be ${NAME} refs, exactly like credential-bearing headers, so a token
 * never lands on the row or in a public projection.
 */
function normalizeOauth(value: unknown): McpOauth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "oauth must be an object with clientId, clientSecret and refreshToken",
    );
  }
  const record = value as Record<string, unknown>;
  const field = (
    name: "clientId" | "clientSecret" | "refreshToken",
    secret: boolean,
  ): string => {
    const fieldValue = record[name];
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length === 0 ||
      fieldValue.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(fieldValue)
    ) {
      throw new Error(
        `oauth.${name} must be a single-line string of at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (secret && !ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(fieldValue)) {
      throw new Error(
        `oauth.${name} must reference an account env var like \${NAME}, not an inline secret`,
      );
    }

    return fieldValue;
  };
  const tokenUrl =
    record.tokenUrl === undefined || record.tokenUrl === null
      ? undefined
      : normalizeUrl(record.tokenUrl);
  // The refresh request carries the client secret in its body.
  if (tokenUrl !== undefined && new URL(tokenUrl).protocol !== "https:") {
    throw new Error("oauth.tokenUrl must use https");
  }

  return {
    clientId: field("clientId", false),
    clientSecret: field("clientSecret", true),
    refreshToken: field("refreshToken", true),
    ...(tokenUrl !== undefined ? { tokenUrl: tokenUrl } : {}),
  };
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new Error(
      `url must be a string of at most ${MAX_URL_LENGTH} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`url must be a valid absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("url must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "url must not embed credentials; put them in headers as ${NAME} refs",
    );
  }

  return value;
}

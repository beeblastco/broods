import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { sha256Hex } from "./accountSecrets";
import {
  ACCOUNT_ENV_REFS_ONLY_PATTERN,
  CREDENTIAL_HEADER_VALUE_PATTERN,
} from "./envRefs";
import { ClientError } from "./clientError";
import { isSecretName } from "./secretNames";

const MAX_ALLOWED_TOOLS = 256;
const MAX_COMMAND_ARGS = 32;
const MAX_COMMAND_ARG_LENGTH = 4096;
// Both mirrored in packages/broods/src/manifest.ts, which the published CLI can not import.
export const MAX_INLINE_BUNDLE_BYTES = 10_000_000;
export const MAX_MCP_BUNDLE_BYTES = 50_000_000;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export const MCP_CLEARABLE_FIELDS = [
  "allowedTools",
  "command",
  "description",
  "headers",
  "oauth",
] as const;

// Prefixes provider tool names as `server__tool`: no underscore keeps `__` unambiguous.
const MCP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type McpPlacement = { sandbox: string | null; transport: McpTransport };

export type McpTransport = "http" | "hosted" | "machine";

export type McpRuntime = "auto" | "lambda";

export interface McpOauth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}

export interface McpInput {
  name?: string;
  description?: string;
  transport?: McpTransport;
  url?: string;
  sandbox?: string;
  command?: string[];
  bundle?: string;
  bundleStorageId?: string;
  sha256?: string;
  runtime?: McpRuntime;
  headers?: Record<string, string>;
  oauth?: McpOauth;
  allowedTools?: string[];
  disabled?: boolean;
}

export function assertMcpRow(row: {
  transport: McpTransport;
  url?: string;
  sandbox?: string;
  command?: string[];
  runtime?: McpRuntime;
  headers?: Record<string, string>;
  oauth?: McpOauth;
}): void {
  if (row.transport === "machine" && !row.sandbox) {
    throw new ClientError(
      "a machine MCP server needs the sandbox that serves it",
    );
  }
  if (row.transport !== "machine" && row.command !== undefined) {
    throw new ClientError("command applies to a server on a sandbox");
  }
  // A headers-only patch leaves `transport` unset, so normalizeMcpInput can not catch it.
  if (row.transport === "machine" && row.headers !== undefined) {
    throw new ClientError("headers do not apply to a machine server");
  }
  if (row.runtime !== undefined && row.transport !== "hosted") {
    throw new ClientError(
      `runtime applies to hosted (bundle) servers, not ${row.transport}`,
    );
  }
  if (row.oauth === undefined) return;
  if (row.transport !== "http") {
    throw new ClientError(
      `oauth applies to external (url) servers, not ${row.transport}`,
    );
  }
  if (row.url !== undefined && new URL(row.url).protocol !== "https:") {
    throw new ClientError(
      "oauth needs an https url; the minted token rides every request",
    );
  }
  const authorization = authorizationHeaderName(row.headers);
  if (authorization !== undefined) {
    throw new ClientError(
      `oauth mints the Authorization header itself; drop the explicit ${authorization} header`,
    );
  }
}

export function authorizationHeaderName(
  headers: Record<string, string> | undefined,
): string | undefined {
  return Object.keys(headers ?? {}).find(
    (name) => name.toLowerCase() === "authorization",
  );
}

export async function loadMcpServersByNode(
  ctx: QueryCtx,
  stageId: Id<"stages">,
): Promise<Map<string, McpPlacement>> {
  const servers = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_status_and_name", (q) =>
      q.eq("stageId", stageId).eq("status", "active"),
    )
    .collect();
  const placements = new Map<string, McpPlacement>();
  for (const server of servers) {
    if (server.nodeId) {
      placements.set(server.nodeId, {
        sandbox: server.sandbox ?? null,
        transport: server.transport,
      });
    }
  }

  return placements;
}

// A prefix apart from account-tools/ keeps the account-delete sweep unambiguous.
export function mcpBundleStorageKey(accountId: string, sha256: string): string {
  return `account-mcp/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

export async function normalizeMcpInput(
  body: unknown,
  options: { requireConnection: boolean },
): Promise<McpInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ClientError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const input: McpInput = {};
  if (record.name !== undefined) input.name = normalizeName(record.name);
  if (record.description !== undefined && record.description !== null) {
    input.description = normalizeDescription(record.description);
  }
  normalizeConnection(record, input);
  if (input.bundle !== undefined) {
    input.sha256 = await sha256Hex(input.bundle);
  }
  if (record.headers !== undefined && record.headers !== null) {
    input.headers = normalizeHeaders(record.headers);
  }
  normalizeOauth(record, input);
  if (record.allowedTools !== undefined && record.allowedTools !== null) {
    input.allowedTools = normalizeAllowedTools(record.allowedTools);
  }
  if (record.disabled !== undefined) {
    if (typeof record.disabled !== "boolean") {
      throw new ClientError("disabled must be a boolean");
    }
    input.disabled = record.disabled;
  }
  if (input.transport === "machine" && input.headers !== undefined) {
    throw new ClientError("headers do not apply to a machine server");
  }
  if (options.requireConnection) {
    if (input.name === undefined)
      throw new ClientError("name must be provided");
    if (input.transport === undefined) {
      throw new ClientError(
        "url must be provided, or bundle for a hosted server, or sandbox for a server on a machine",
      );
    }
  }

  return input;
}

function normalizeAllowedTools(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ClientError("allowedTools must be an array of tool names");
  }
  if (value.length > MAX_ALLOWED_TOOLS) {
    throw new ClientError(
      `allowedTools must list at most ${MAX_ALLOWED_TOOLS} tools`,
    );
  }
  const names = value as string[];
  for (const name of names) {
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new ClientError(
        `allowedTools entries must match ${MCP_TOOL_NAME_PATTERN}: ${name}`,
      );
    }
  }

  return names;
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientError("bundle must be a non-empty string of module source");
  }
  // TextEncoder, not Buffer: this runs in Convex's V8 isolate too.
  if (new TextEncoder().encode(value).byteLength > MAX_INLINE_BUNDLE_BYTES) {
    throw new ClientError(
      `inline bundle must be at most ${MAX_INLINE_BUNDLE_BYTES} bytes; upload larger bundles (up to ${MAX_MCP_BUNDLE_BYTES}) to an upload URL and pass bundleStorageId`,
    );
  }

  return value;
}

function normalizeCommand(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_COMMAND_ARGS ||
    !value.every(
      (arg): arg is string =>
        typeof arg === "string" &&
        arg.length > 0 &&
        arg.length <= MAX_COMMAND_ARG_LENGTH,
    )
  ) {
    throw new ClientError(
      `command must be 1-${MAX_COMMAND_ARGS} non-empty strings of at most ${MAX_COMMAND_ARG_LENGTH} characters, like ["obscura", "mcp"]`,
    );
  }

  return value;
}

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
      throw new ClientError("bundleStorageId must be a non-empty storage id");
    }
    if (
      typeof record.sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(record.sha256)
    ) {
      throw new ClientError(
        "bundleStorageId needs sha256, the hex digest of the uploaded bytes",
      );
    }
    input.bundleStorageId = record.bundleStorageId;
    input.sha256 = record.sha256;
  }
  if (record.sandbox !== undefined) {
    if (typeof record.sandbox !== "string" || record.sandbox.length === 0) {
      throw new ClientError(
        "sandbox must be the name of the sandbox that serves it",
      );
    }
    input.sandbox = record.sandbox;
  }
  if (record.runtime !== undefined) {
    input.runtime = normalizeRuntime(record.runtime);
  }
  const connections = [
    input.url,
    input.bundle,
    input.bundleStorageId,
    input.sandbox,
  ].filter((value) => value !== undefined);
  if (connections.length > 1) {
    throw new ClientError(
      "url, bundle, bundleStorageId and sandbox are mutually exclusive",
    );
  }
  if (input.url !== undefined) input.transport = "http";
  if (input.bundle !== undefined || input.bundleStorageId !== undefined) {
    input.transport = "hosted";
  }
  if (input.sandbox !== undefined) input.transport = "machine";
  if (record.command !== undefined && record.command !== null) {
    input.command = normalizeCommand(record.command);
  }
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) {
    throw new ClientError(
      `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  return value;
}

// A `stored` value sent back unchanged is a ref a code sync already resolved, so it is kept.
export function normalizeHeaders(
  value: unknown,
  stored: Record<string, string> = {},
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientError("headers must be an object of header name to value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) {
    throw new ClientError(
      `headers must contain at most ${MAX_HEADERS} entries`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new ClientError(`headers names must be RFC 9110 tokens: ${name}`);
    }
    if (
      typeof headerValue !== "string" ||
      headerValue.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new ClientError(
        `headers values must be single-line strings of at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    // A bare `Key` header is a credential, though isSecretName reads a lone `key` as a row name.
    const lowerName = name.toLowerCase();
    if (
      (isSecretName(lowerName) || /^keys?$/.test(lowerName)) &&
      !CREDENTIAL_HEADER_VALUE_PATTERN.test(headerValue) &&
      stored[name] !== headerValue
    ) {
      throw new ClientError(
        `headers values for ${name} must reference an account env var like \${NAME}, not an inline secret`,
      );
    }
    headers[name] = headerValue;
  }

  return headers;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !MCP_NAME_PATTERN.test(value)) {
    throw new ClientError(
      "name must be 1-32 lowercase letters, digits or hyphens, starting with a letter",
    );
  }

  return value;
}

function normalizeOauth(
  record: Record<string, unknown>,
  input: McpInput,
): void {
  const value = record.oauth;
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ClientError(
      "oauth must be an object with clientId, clientSecret and refreshToken",
    );
  }
  const oauth = value as Record<string, unknown>;
  const field = (
    name: "clientId" | "clientSecret" | "refreshToken",
    secret: boolean,
  ): string => {
    const fieldValue = oauth[name];
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length === 0 ||
      fieldValue.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(fieldValue)
    ) {
      throw new ClientError(
        `oauth.${name} must be a single-line string of at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (secret && !ACCOUNT_ENV_REFS_ONLY_PATTERN.test(fieldValue)) {
      throw new ClientError(
        `oauth.${name} must reference an account env var like \${NAME}, not an inline secret`,
      );
    }

    return fieldValue;
  };
  const tokenUrl =
    oauth.tokenUrl === undefined || oauth.tokenUrl === null
      ? undefined
      : normalizeUrl(oauth.tokenUrl);
  // The refresh request carries the client secret in its body.
  if (tokenUrl !== undefined && new URL(tokenUrl).protocol !== "https:") {
    throw new ClientError("oauth.tokenUrl must use https");
  }
  input.oauth = {
    clientId: field("clientId", false),
    clientSecret: field("clientSecret", true),
    refreshToken: field("refreshToken", true),
    ...(tokenUrl !== undefined ? { tokenUrl: tokenUrl } : {}),
  };
}

function normalizeRuntime(value: unknown): McpRuntime {
  if (value !== "auto" && value !== "lambda") {
    throw new ClientError('runtime must be "auto" or "lambda"');
  }

  return value;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new ClientError(
      `url must be a string of at most ${MAX_URL_LENGTH} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClientError(`url must be a valid absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ClientError("url must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ClientError(
      "url must not embed credentials; put them in headers as ${NAME} refs",
    );
  }

  return value;
}

/**
 * Generic model-result helpers plus shared persistent-subagent tool plumbing.
 * Keep tool-specific schemas, inputs, and actions in their own tool files.
 */

import type { JSONValue } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { JSONSchema7, UserContent } from "ai";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import {
  parseAccountAgentScopedKey,
  scopedDirectEventId,
  subagentParentEventId,
} from "../../shared/runtime-keys.ts";
import {
  getAsyncAgentResult,
  type AsyncAgentResultRecord,
} from "../async-agent-result.ts";

export const VIRTUAL_AGENT_PREFIX = "virtual_subagent_";

export interface SubagentToolContext {
  accountId: string;
  eventId: string;
}

export interface SubagentToolInput {
  taskId: string;
  agentId: string;
}

export type UserContentPart = Exclude<UserContent, string>[number];

export const SUBAGENT_TOOL_PROPERTIES: Record<string, JSONSchema7> = {
  taskId: {
    type: "string",
    description: "The taskId returned by run_subagent.",
  },
  agentId: {
    type: "string",
    description: "The agentId returned for the same subagent task.",
  },
};

/**
 * Return native text from execute so the AI SDK selects ToolResultOutput.text.
 */
export const toolText = (value: string): string => value;

/**
 * Throw native errors from execute so the AI SDK selects its error result path.
 */
export const toolError = (value: string): never => {
  throw new Error(
    isFatalSandboxSetupError(value) ? `Sandbox setup failed: ${value}` : value,
  );
};

export async function getOwnedSubagent(
  context: SubagentToolContext,
  input: SubagentToolInput,
): Promise<AsyncAgentResultRecord | null> {
  if (subagentParentEventId(input.taskId) !== context.eventId) {
    return null;
  }

  const eventId = scopedDirectEventId(
    context.accountId,
    input.agentId,
    input.taskId,
  );
  const record = await getAsyncAgentResult(eventId);
  const scope = record
    ? parseAccountAgentScopedKey(record.conversationKey)
    : null;
  if (
    !record ||
    !scope ||
    record.eventId !== eventId ||
    record.accountId !== context.accountId ||
    scope.accountId !== context.accountId ||
    scope.agentId !== input.agentId
  ) {
    return null;
  }

  return record;
}

export function isFatalSandboxSetupError(value: string): boolean {
  return /allocated memory limit|resource limit|quota exceeded|invalid namespace: must match/i.test(
    value,
  );
}

/**
 * Adapt a retained JSON result to the richest user-message parts supported by
 * the AI SDK. JSON has no native user part, so only that case becomes text.
 */
export function modelValueToUserParts(value: JSONValue): UserContentPart[] {
  const output = parseToolResultOutput(value);
  if (!output) {
    return [textPart(formatJSONValue(value))];
  }

  switch (output.type) {
    case "text":
    case "error-text":
      return [textPart(output.value, output.providerOptions)];
    case "json":
    case "error-json":
      return [textPart(formatJSONValue(output.value), output.providerOptions)];
    case "execution-denied":
      return [
        textPart(
          output.reason
            ? `Execution denied: ${output.reason}`
            : "Execution denied",
          output.providerOptions,
        ),
      ];
    case "content":
      return output.value.map(toolContentPartToUserPart);
  }
}

export function prependTextToUserParts(
  prefix: string,
  parts: UserContentPart[],
): UserContentPart[] {
  const [first, ...rest] = parts;
  return first?.type === "text"
    ? [{ ...first, text: `${prefix}${first.text}` }, ...rest]
    : [{ type: "text", text: prefix }, ...parts];
}

export function subagentNotFound(taskId: string): string {
  return `Error: no subagent task found for ${taskId}`;
}

/**
 * Convert an erased execute result at the AI SDK model-output boundary. Static
 * tools return string or JSON and take the SDK's own default; only uploaded
 * tools need this, because the SDK default never validates what it wraps.
 */
export function normalizeToolResultOutput(output: unknown): ToolResultOutput {
  if (isToolResultOutput(output)) {
    return output;
  }
  if (hasToolResultOutputDiscriminant(output)) {
    throw new TypeError(`Invalid ToolResultOutput for type "${output.type}"`);
  }
  if (typeof output === "string") {
    return { type: "text", value: output };
  }
  if (isJSONValue(output)) {
    return { type: "json", value: output };
  }

  throw new TypeError(
    "Tool output must be a string, a JSON-compatible value, or a valid ToolResultOutput",
  );
}

/** Child agents never spawn their own subagents, whatever the base config says. */
export function withoutNestedSubagents(config: AgentConfig): AgentConfig {
  return {
    ...config,
    subagent: {
      ...config.subagent,
      enabled: false,
    },
  };
}

function formatJSONValue(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseToolResultOutput(value: unknown): ToolResultOutput | undefined {
  return isToolResultOutput(value) ? value : undefined;
}

function textPart(
  text: string,
  providerOptions?: Extract<
    UserContentPart,
    { type: "text" }
  >["providerOptions"],
): UserContentPart {
  return {
    type: "text",
    text: text,
    ...(providerOptions ? { providerOptions: providerOptions } : {}),
  };
}

function toolContentPartToUserPart(
  part: Extract<ToolResultOutput, { type: "content" }>["value"][number],
): UserContentPart {
  switch (part.type) {
    case "text":
      return textPart(part.text, part.providerOptions);
    case "file":
      return {
        type: "file",
        data: part.data,
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.providerOptions
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-data":
    case "image-data":
      return {
        type: "file",
        data: { type: "data", data: part.data },
        mediaType: part.mediaType,
        ...(part.type === "file-data" && part.filename
          ? { filename: part.filename }
          : {}),
        ...(part.providerOptions
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-url":
    case "image-url":
      return urlToolContentPartToUserPart(part);
    case "file-reference":
    case "image-file-reference":
      return {
        type: "file",
        data: {
          type: "reference",
          reference: part.providerReference,
        },
        mediaType:
          part.type === "image-file-reference"
            ? "image"
            : "application/octet-stream",
        ...(part.providerOptions
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-id":
    case "image-file-id":
      return typeof part.fileId === "string"
        ? textPart(JSON.stringify(part), part.providerOptions)
        : {
            type: "file",
            data: { type: "reference", reference: part.fileId },
            mediaType:
              part.type === "image-file-id"
                ? "image"
                : "application/octet-stream",
            ...(part.providerOptions
              ? { providerOptions: part.providerOptions }
              : {}),
          };
    case "custom":
      return textPart(JSON.stringify(part), part.providerOptions);
  }
}

function urlToolContentPartToUserPart(
  part: Extract<
    Extract<ToolResultOutput, { type: "content" }>["value"][number],
    { type: "file-url" | "image-url" }
  >,
): UserContentPart {
  try {
    return {
      type: "file",
      data: { type: "url", url: new URL(part.url) },
      mediaType:
        part.type === "image-url"
          ? "image"
          : (part.mediaType ?? "application/octet-stream"),
      ...(part.providerOptions
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  } catch {
    return textPart(JSON.stringify(part), part.providerOptions);
  }
}

function isToolResultOutput(value: unknown): value is ToolResultOutput {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
    case "error-text":
      return typeof value.value === "string" && hasValidProviderOptions(value);
    case "json":
    case "error-json":
      return isJSONValue(value.value) && hasValidProviderOptions(value);
    case "execution-denied":
      return (
        (value.reason === undefined || typeof value.reason === "string") &&
        hasValidProviderOptions(value)
      );
    case "content":
      return (
        Array.isArray(value.value) &&
        value.value.every(isToolResultContentPart) &&
        hasValidProviderOptions(value)
      );
    default:
      return false;
  }
}

function isToolResultContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string" && hasValidProviderOptions(value);
    case "file":
      return (
        typeof value.mediaType === "string" &&
        isFileData(value.data) &&
        (value.filename === undefined || typeof value.filename === "string") &&
        hasValidProviderOptions(value)
      );
    case "file-data":
    case "image-data":
      return (
        typeof value.data === "string" &&
        typeof value.mediaType === "string" &&
        (value.filename === undefined || typeof value.filename === "string") &&
        hasValidProviderOptions(value)
      );
    case "file-url":
      return (
        typeof value.url === "string" &&
        (value.mediaType === undefined ||
          typeof value.mediaType === "string") &&
        hasValidProviderOptions(value)
      );
    case "image-url":
      return typeof value.url === "string" && hasValidProviderOptions(value);
    case "file-id":
    case "image-file-id":
      return (
        (typeof value.fileId === "string" || isStringRecord(value.fileId)) &&
        hasValidProviderOptions(value)
      );
    case "file-reference":
    case "image-file-reference":
      return (
        isStringRecord(value.providerReference) &&
        hasValidProviderOptions(value)
      );
    case "custom":
      return hasValidProviderOptions(value);
    default:
      return false;
  }
}

function hasToolResultOutputDiscriminant(
  value: unknown,
): value is Record<string, unknown> & { type: string } {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    [
      "text",
      "json",
      "execution-denied",
      "error-text",
      "error-json",
      "content",
    ].includes(value.type)
  );
}

function hasValidProviderOptions(value: Record<string, unknown>): boolean {
  return (
    value.providerOptions === undefined || isJSONValue(value.providerOptions)
  );
}

function isFileData(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "data":
      return (
        typeof value.data === "string" ||
        value.data instanceof Uint8Array ||
        value.data instanceof ArrayBuffer
      );
    case "url":
      return value.url instanceof URL;
    case "reference":
      return isStringRecord(value.reference);
    case "text":
      return typeof value.text === "string";
    default:
      return false;
  }
}

function isJSONValue(
  value: unknown,
  active = new WeakSet<object>(),
): value is JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || active.has(value)) {
    return false;
  }

  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJSONValue(item, active))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((item) => isJSONValue(item, active));
  active.delete(value);

  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isStringRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

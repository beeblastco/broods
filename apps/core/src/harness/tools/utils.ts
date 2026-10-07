/**
 * Generic model-result helpers plus shared persistent-subagent tool plumbing.
 * Keep tool-specific schemas, inputs, and actions in their own tool files.
 */

import type { JSONValue } from "@ai-sdk/provider";
import { detectMediaType, type ToolResultOutput } from "@ai-sdk/provider-utils";
import type { JSONSchema7, UserContent, UserModelMessage } from "ai";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import { MAX_IMAGE_BYTES } from "../../shared/media-types.ts";
import {
  parseAccountAgentScopedKey,
  scopedDirectEventId,
  subagentParentEventId,
} from "../../shared/runtime-keys.ts";
import {
  getAsyncAgentResult,
  type AsyncAgentResultRecord,
} from "../async-agent-result.ts";

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

export const VIRTUAL_AGENT_PREFIX = "virtual_subagent_";

// Images one tool result may show the model; together they share MAX_IMAGE_BYTES.
const MAX_RESULT_IMAGES = 8;
// The longest side a model provider takes for an inline image.
const MAX_IMAGE_SIDE = 8000;
// What every model provider reads inline.
const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** One part of a `content` tool result. */
export type ToolContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];

export interface SubagentToolContext {
  accountId: string;
  eventId: string;
}

/** A persistent subagent's question to its parent; null when no answer comes. */
export type AskParent = (
  question: string,
  abortSignal?: AbortSignal,
) => Promise<string | null>;

/** This turn's live subagents, as the parent's loop and subagent tools see them. */
export interface SubagentWatch {
  waitForSettled(
    taskId: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<void>;
  markDelivered(eventId: string): void;
  answerQuestion(taskId: string, answer: string): boolean;
  takeParentMessages(): Promise<UserModelMessage[]>;
  confirmDelivered(): void;
}

export interface SubagentToolInput {
  taskId: string;
  agentId: string;
}

export type UserContentPart = Exclude<UserContent, string>[number];

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

export function prependTextToUserParts(
  prefix: string,
  parts: UserContentPart[],
): UserContentPart[] {
  const [first, ...rest] = parts;

  return first?.type === "text"
    ? [{ ...first, text: `${prefix}${first.text}` }, ...rest]
    : [{ type: "text", text: prefix }, ...parts];
}

// A child carries the parent's effective policies and withheld tools (a channel
// record's included), and never spawns subagents of its own. Workspaces are the
// exception: a predefined child keeps its own, whatever a record narrowed.
export function subagentConfig(
  config: AgentConfig,
  parent: AgentConfig,
): AgentConfig {
  const policies = [
    ...new Set([...(parent.policies ?? []), ...(config.policies ?? [])]),
  ];
  const denyTools = [
    ...new Set([...(parent.denyTools ?? []), ...(config.denyTools ?? [])]),
  ];

  return {
    ...config,
    ...(policies.length > 0 ? { policies: policies } : {}),
    ...(denyTools.length > 0 ? { denyTools: denyTools } : {}),
    subagent: {
      ...config.subagent,
      enabled: false,
    },
  };
}

export function subagentNotFound(taskId: string): string {
  return `Error: no subagent task found for ${taskId}`;
}

/** Throw native errors from execute so the AI SDK selects its error result path. */
export const toolError = (value: string): never => {
  throw new Error(
    isFatalSandboxSetupError(value) ? `Sandbox setup failed: ${value}` : value,
  );
};

/** Return native text from execute so the AI SDK selects ToolResultOutput.text. */
export const toolText = (value: string): string => value;

/**
 * A tool result's content parts with every image the model cannot read, or past
 * the result's budget (MAX_RESULT_IMAGES images sharing MAX_IMAGE_BYTES), swapped
 * for a text note. A bad image would fail the next model call, and big ones stay
 * in the conversation for every later turn. browse and MCP results go through it.
 */
export function withImageLimits(parts: ToolContentPart[]): ToolContentPart[] {
  let images = 0;
  let bytes = 0;

  return parts.map((part): ToolContentPart => {
    if (part.type !== "image-data") return part;
    const note = (problem: string): ToolContentPart => ({
      type: "text",
      text: `[An image (${part.mediaType}, ${part.data.length} base64 characters) was not shown to you: ${problem}.]`,
    });
    const size = base64Bytes(part.data);
    // The bytes name the type; a label alone is often wrong.
    const mediaType =
      size === undefined
        ? undefined
        : detectMediaType({ data: part.data, topLevelType: "image" });
    if (
      size === undefined ||
      mediaType === undefined ||
      !MODEL_IMAGE_TYPES.has(mediaType)
    ) {
      return note("it is not a PNG, JPEG, GIF or WebP image");
    }
    if (bytes + size > MAX_IMAGE_BYTES) {
      return note(
        `it would take the result over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB of images one result may carry`,
      );
    }
    if (images >= MAX_RESULT_IMAGES) {
      return note(`the result carries more than ${MAX_RESULT_IMAGES} images`);
    }
    const pixels = imageSize(Buffer.from(part.data, "base64"), mediaType);
    if (!pixels) return note("it is not a PNG, JPEG, GIF or WebP image");
    if (
      Math.max(pixels.width, pixels.height) > MAX_IMAGE_SIDE ||
      Math.min(pixels.width, pixels.height) < 1
    ) {
      return note(
        `it is ${pixels.width}x${pixels.height} pixels; a side must be 1 to ${MAX_IMAGE_SIDE}`,
      );
    }
    images += 1;
    bytes += size;

    return { ...part, mediaType: mediaType };
  });
}

/** Decoded size of a base64 string, or undefined when it is not valid base64. */
function base64Bytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return (data.length / 4) * 3 - padding;
}

/**
 * An image's pixel size, read from the header its type defines, or undefined
 * when that header is not all there: a signature alone is not an image.
 */
function imageSize(
  bytes: Buffer,
  mediaType: string,
): { width: number; height: number } | undefined {
  if (mediaType === "image/png") {
    return bytes.length >= 24 && bytes.toString("latin1", 12, 16) === "IHDR"
      ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : undefined;
  }
  if (mediaType === "image/gif") {
    return bytes.length >= 10
      ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
      : undefined;
  }
  if (mediaType === "image/webp") {
    return webpSize(bytes);
  }

  return jpegSize(bytes);
}

/** A JPEG's size from its first start-of-frame segment. */
function jpegSize(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes.readUInt8(offset + 1);
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }

  return undefined;
}

/** A WebP's size from its VP8, VP8L or VP8X chunk. */
function webpSize(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  switch (bytes.toString("latin1", 12, 16)) {
    case "VP8 ":
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    case "VP8L": {
      const bits = bytes.readUInt32LE(21);

      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    case "VP8X":
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    default:
      return undefined;
  }
}

function formatJSONValue(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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

export function parseToolResultOutput(
  value: unknown,
): ToolResultOutput | undefined {
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

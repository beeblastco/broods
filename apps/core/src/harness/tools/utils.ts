import type { JSONValue } from "@ai-sdk/provider";
import { detectMediaType, type ToolResultOutput } from "@ai-sdk/provider-utils";
import type {
  JSONSchema7,
  ToolModelMessage,
  UserContent,
  UserModelMessage,
} from "ai";
import { z } from "zod";
import {
  applyRunOverrides,
  type AgentConfig,
} from "../../shared/domain/agent-config.ts";
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
import { getIngressStatusByEventId } from "../ingress.ts";

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

export const MAX_RESULT_IMAGES = 8;
const MAX_IMAGE_SIDE = 8000;
const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const jsonValueSchema = z.custom<JSONValue>((value) => isJSONValue(value));
const providerOptionsSchema = z
  .record(z.string(), z.record(z.string(), jsonValueSchema))
  .optional();
const providerReferenceSchema = z.record(z.string(), z.string());
const toolContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.literal("file"),
    data: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("data"),
        data: z.union([
          z.string(),
          z.instanceof(Uint8Array),
          z.instanceof(ArrayBuffer),
        ]),
      }),
      z.object({ type: z.literal("url"), url: z.instanceof(URL) }),
      z.object({
        type: z.literal("reference"),
        reference: providerReferenceSchema,
      }),
      z.object({ type: z.literal("text"), text: z.string() }),
    ]),
    mediaType: z.string(),
    filename: z.string().optional(),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.enum(["file-data", "image-data"]),
    data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.literal("file-url"),
    url: z.string(),
    mediaType: z.string().optional(),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.literal("image-url"),
    url: z.string(),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.enum(["file-id", "image-file-id"]),
    fileId: z.union([z.string(), providerReferenceSchema]),
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.enum(["file-reference", "image-file-reference"]),
    providerReference: providerReferenceSchema,
    providerOptions: providerOptionsSchema,
  }),
  z.object({
    type: z.literal("custom"),
    providerOptions: providerOptionsSchema,
  }),
]);
const toolResultOutputTypeSchema = z.object({
  type: z.enum([
    "text",
    "error-text",
    "json",
    "error-json",
    "execution-denied",
    "content",
  ]),
});
const toolResultOutputSchema: z.ZodType<ToolResultOutput> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.enum(["text", "error-text"]),
      value: z.string(),
      providerOptions: providerOptionsSchema,
    }),
    z.object({
      type: z.enum(["json", "error-json"]),
      value: jsonValueSchema,
      providerOptions: providerOptionsSchema,
    }),
    z.object({
      type: z.literal("execution-denied"),
      reason: z.string().optional(),
      providerOptions: providerOptionsSchema,
    }),
    z.object({
      type: z.literal("content"),
      value: z.array(toolContentPartSchema),
      providerOptions: providerOptionsSchema,
    }),
  ]);

export type ToolContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];

export interface SubagentToolContext {
  accountId: string;
  eventId: string;
  conversationKey: string;
}

export type AskParent = (
  question: string,
  abortSignal?: AbortSignal,
) => Promise<string | null>;

export interface SubagentWatch {
  answerQuestion(taskId: string, answer: string): boolean;
  takeParentMessages(): Promise<UserModelMessage[]>;
}

export interface SubagentToolInput {
  taskId: string;
  agentId: string;
}

export type UserContentPart = Exclude<UserContent, string>[number];

// A child can outlive the run that started it, so any run of its conversation owns it.
export async function getOwnedSubagent(
  context: SubagentToolContext,
  input: SubagentToolInput,
): Promise<AsyncAgentResultRecord | null> {
  if (!(await startedInConversation(context, input.taskId))) {
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

// For uploaded tools: the SDK's default output conversion never validates what it wraps.
export function normalizeToolResultOutput(output: unknown): ToolResultOutput {
  const parsed = parseToolResultOutput(output);
  if (parsed) {
    return parsed;
  }
  const typed = toolResultOutputTypeSchema.safeParse(output);
  if (typed.success) {
    throw new TypeError(
      `Invalid ToolResultOutput for type "${typed.data.type}"`,
    );
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

// Workspaces are not inherited: a predefined child keeps its own, whatever a record narrowed.
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

export function toolContentItems(message: ToolModelMessage): ToolContentPart[] {
  return message.content.flatMap((part): ToolContentPart[] =>
    part.type === "tool-result" && part.output.type === "content"
      ? part.output.value
      : [],
  );
}

export const toolError = (value: string): never => {
  throw new Error(
    isFatalSandboxSetupError(value) ? `Sandbox setup failed: ${value}` : value,
  );
};

export const toolText = (value: string): string => value;

export function virtualSubagentConfig(parent: AgentConfig): AgentConfig {
  return subagentConfig(
    applyRunOverrides(parent, { model: parent.subagent?.model }),
    parent,
  );
}

// A bad image fails the next model call, and a big one rides along on every later turn.
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

function base64Bytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return (data.length / 4) * 3 - padding;
}

function formatJSONValue(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

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

function jpegSize(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes.readUInt8(offset + 1);
    // Any number of 0xFF fill bytes may precede a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
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

export function parseToolResultOutput(
  value: unknown,
): ToolResultOutput | undefined {
  // The input, not zod's copy, which would drop the keys the schema does not name.
  return toolResultOutputSchema.safeParse(value).success
    ? (value as ToolResultOutput)
    : undefined;
}

async function startedInConversation(
  context: SubagentToolContext,
  taskId: string,
): Promise<boolean> {
  const parentEventId = subagentParentEventId(taskId);
  if (parentEventId === null) {
    return false;
  }
  if (parentEventId === context.eventId) {
    return true;
  }
  const scope = parseAccountAgentScopedKey(parentEventId);
  if (!scope || scope.accountId !== context.accountId) {
    return false;
  }
  const parent = await getIngressStatusByEventId({
    accountId: scope.accountId,
    agentId: scope.agentId,
    eventId: parentEventId,
  });

  return parent?.conversationKey === context.conversationKey;
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

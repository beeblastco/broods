// Inbound channel media. A row keeps a sealed link into the attachment store (no sandbox mounts
// it), or with no workspace a `broods-media:` reference the channel is asked for again.

import {
  detectMediaType,
  getTopLevelMediaType,
  mediaTypeToExtension,
} from "@ai-sdk/provider-utils";
import type {
  FilePart,
  ImagePart,
  ModelMessage,
  ToolModelMessage,
  UserContent,
} from "ai";
import type { Attachment } from "chat";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { channelAdapterFromConfig } from "./integrations.ts";
import { readFetchedBytes } from "../shared/channels.ts";
import { createHash } from "node:crypto";
import { basename } from "node:path/posix";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import {
  getHarnessPublicUrl,
  requireEnv,
  requireSecretsEnv,
} from "../shared/env.ts";
import { guardedFetch } from "./isolate/runner/pinned-fetch.mjs";
import type { PinnedFetchTransport } from "../shared/http.ts";
import { logWarn } from "../shared/log.ts";
import { locateMediaObject, readMediaObject } from "../media.ts";
import {
  attachmentStoreKey,
  MEDIA_PATH_PREFIX,
  openMediaTicket,
  sealMediaTicket,
  type AttachmentMediaTicket,
} from "../shared/media-ticket.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  unreadableMediaNote,
} from "../shared/media-types.ts";
import { writeS3Object } from "../shared/s3.ts";
import type { ResolvedWorkspace } from "../shared/workspaces.ts";
import { recordUsage } from "./plan-limits.ts";
import {
  transcribeAudio,
  TRANSCRIPTION_RETRIES,
  transcriptAdvice,
  type TranscriptOutcome,
} from "./transcribe.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";
import { toolContentItems, type ToolContentPart } from "./tools/utils.ts";

const MEDIA_DIRECTORY = "media";

// Not `https:`: a provider would fetch that itself, without the bot token or a soft failure.
export const MEDIA_REFERENCE_SCHEME = "broods-media:";

const MEDIA_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Replayed bytes ride every request as base64 and providers cap a request (Anthropic: 32 MB).
const MAX_REPLAY_BYTES_PER_TURN = 20 * 1024 * 1024;

// Anthropic refuses over 100 images a request, or any side over 2000 px past 20.
const MAX_REPLAYED_MEDIA = 20;

const REPLAY_OMIT_BATCH = 10;

const OMITTED_MEDIA_NOTE = "[an earlier image is not shown here]";

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

// .docx and .xlsx sniff as zip; that must not overrule the provider's claimed type.
const UNSPECIFIC_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "application/x-zip-compressed",
  "application/zip",
]);

// A floor: an unlisted type becomes a workspace file, as an unsupported part fails the turn.
// Not the model's `supportedUrls`, which lists what the provider fetches for itself.
const PROVIDER_NATIVE_MEDIA: Partial<
  Record<AccountModelProviderName, readonly string[]>
> = {
  anthropic: ["application/pdf"],
  azure: ["application/pdf"],
  bedrock: ["application/pdf"],
  google: ["application/pdf", "audio/*", "video/*"],
  openai: ["application/pdf"],
  vertex: ["application/pdf", "audio/*", "video/*"],
};

// Map order is LRU order: a hit re-inserts, eviction takes from the front.
const mediaCache = new Map<string, Buffer>();
let mediaCacheBytes = 0;

export interface InboundMediaContext {
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
  channelName: string;
  eventId: string;
  workspace?: ResolvedWorkspace;
}

interface IngestedAttachment {
  stored: StoredAttachment;
  part: UserContentPart | null;
}

/** Bytes never go in `stored`: a 6 MB picture would become an 8 MB JSON row. */
export interface IngestedMediaParts {
  stored: UserContentPart[];
  turn: UserContentPart[];
}

interface MediaReference {
  channelName: string;
  mediaType: string;
  name: string;
  metadata: Record<string, string>;
  type: Attachment["type"];
  url: string;
}

interface StoredAttachment {
  name: string;
  mediaType: string;
  data?: Buffer;
  path?: string;
  reference?: string;
  url?: string;
  failure?: string;
  transcript?: TranscriptOutcome;
  receivedBytes: number;
}

type SealedMedia = { bytes: Buffer } | { gone: string };

interface SealedReplay {
  accountId: string | undefined;
  remainingBytes: number;
}

type UserContentPart = Exclude<UserContent, string>[number];

export function acceptsNativeMedia(
  provider: AccountModelProviderName | undefined,
  mediaType: string,
): boolean {
  if (mediaType.startsWith("image/")) {
    return true;
  }
  const patterns = provider ? PROVIDER_NATIVE_MEDIA[provider] : undefined;
  const wildcard = `${getTopLevelMediaType(mediaType)}/*`;

  return (
    patterns?.some(
      (pattern) => pattern === mediaType || pattern === wildcard,
    ) ?? false
  );
}

/** Never throws: an unreadable attachment becomes a line of text, so it costs one picture. */
export async function ingestInboundAttachments(
  attachments: Attachment[],
  context: InboundMediaContext,
): Promise<IngestedMediaParts> {
  if (attachments.length === 0) {
    return { stored: [], turn: [] };
  }
  const accepted = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const overflow = attachments.length - accepted.length;
  const read = await Promise.all(
    accepted.map((attachment, index): Promise<StoredAttachment> =>
      storeAttachment(attachment, index, context),
    ),
  );
  const receivedBytes = read.reduce((sum, item) => sum + item.receivedBytes, 0);
  if (context.accountId && receivedBytes > 0) {
    recordUsage(
      context.accountId,
      { ingressGb: receivedBytes / 1e9 },
      context.agentId === undefined ? undefined : { agentId: context.agentId },
    );
  }

  const provider = context.agentConfig?.model?.provider;
  const ingested = read.map((item): IngestedAttachment => ({
    stored: item,
    part: nativePart(item, provider, item.url ?? item.data),
  }));

  const stored: UserContentPart[] = [];
  const turn: UserContentPart[] = [];
  for (const { stored: item, part } of ingested) {
    if (!part) {
      continue;
    }
    turn.push(part);
    const kept = item.url ? part : nativePart(item, provider, item.reference);
    if (kept) {
      stored.push(kept);
    }
  }
  const note = attachmentNote(ingested, overflow, context.channelName);
  if (note) {
    const text: UserContentPart = { type: "text", text: note };
    stored.push(text);
    turn.push(text);
  }

  return { stored: stored, turn: turn };
}

export async function readAttachmentBytes(
  attachment: Attachment,
  transport?: PinnedFetchTransport,
): Promise<Buffer> {
  if (attachment.data) {
    return Buffer.isBuffer(attachment.data)
      ? attachment.data
      : Buffer.from(await attachment.data.arrayBuffer());
  }
  if (attachment.fetchData) {
    return await readFetchedBytes(attachment.fetchData);
  }
  if (!attachment.url) {
    throw new Error("attachment carries neither data, a reader, nor a URL");
  }

  return await fetchAttachmentUrl(attachment.url, transport);
}

export async function rehydrateStoredMedia(
  messages: ModelMessage[],
  agentConfig: AgentConfig,
  accountId: string | undefined,
): Promise<ModelMessage[]> {
  const carriesMedia = messages.some(
    (message): boolean =>
      (message.role === "user" &&
        typeof message.content !== "string" &&
        message.content.some(isStoredMediaPart)) ||
      (message.role === "tool" && imageLinks(message).length > 0),
  );
  if (!carriesMedia) {
    return messages;
  }

  const replay: SealedReplay = {
    accountId: accountId,
    remainingBytes: MAX_REPLAY_BYTES_PER_TURN,
  };

  // Newest first, one message at a time, so the oldest pictures are the ones past the budget.
  const replayed: ModelMessage[] = [];
  for (const message of (await withOldMediaOmitted(messages)).toReversed()) {
    replayed.push(await rehydrateMessage(message, agentConfig, replay));
  }

  return replayed.toReversed();
}

/** The bytes beat the claim: Telegram calls every photo a JPEG. */
export function resolveMediaType(
  bytes: Uint8Array,
  claimed: string | undefined,
): string {
  const sniffed = detectMediaType({ data: bytes });
  if (sniffed && !UNSPECIFIC_MEDIA_TYPES.has(sniffed)) {
    return sniffed;
  }
  if (claimed && !UNSPECIFIC_MEDIA_TYPES.has(claimed)) {
    return claimed;
  }

  return sniffed ?? claimed ?? "application/octet-stream";
}

export async function sealConversationMedia(
  messages: ModelMessage[],
  accountId: string,
): Promise<ModelMessage[]> {
  const carriesMedia = messages.some(
    (message): boolean =>
      (message.role === "user" &&
        typeof message.content !== "string" &&
        message.content.some(
          (part): boolean => part.type === "image" || part.type === "file",
        )) ||
      (message.role === "tool" &&
        toolContentItems(message).some(isToolImageBytes)),
  );
  if (!carriesMedia || !getHarnessPublicUrl()) {
    return messages;
  }

  return await Promise.all(
    messages.map((message): Promise<ModelMessage> =>
      sealMessageMedia(message, accountId),
    ),
  );
}

function assertWithinLimit(size: number, mediaType: string | null): void {
  const limit = limitForMediaType(mediaType ?? undefined);
  if (size > limit) {
    throw new Error(`file is larger than ${formatBytes(limit)}`);
  }
}

/** Says "open it yourself": told only that a file exists, models ask the sender to paste it. */
function attachmentNote(
  ingested: IngestedAttachment[],
  overflow: number,
  channelName: string,
): string | null {
  const lines = ingested.map(({ stored: item, part }): string => {
    if (item.failure) {
      return `- ${item.name} (${item.mediaType}) could not be read: ${item.failure}`;
    }

    return `- ${item.name} (${item.mediaType}) ${whereItLanded(item, part, channelName)}${transcriptLine(item)}`;
  });
  if (overflow > 0) {
    lines.push(
      `- ${overflow} further attachment(s) were left with the provider; this message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE}.`,
    );
  }
  if (lines.length === 0) {
    return null;
  }

  return [
    `Attachments received on ${channelName}:`,
    ...lines,
    "Open any file you have not been shown directly with your own tools before answering; do not ask the sender to paste its contents.",
  ].join("\n");
}

async function audioTranscript(
  bytes: Buffer,
  mediaType: string,
  agentConfig: AgentConfig | undefined,
): Promise<TranscriptOutcome | undefined> {
  if (
    !agentConfig ||
    !mediaType.startsWith("audio/") ||
    acceptsNativeMedia(agentConfig.model?.provider, mediaType)
  ) {
    return undefined;
  }

  return await transcribeAudio(
    agentConfig,
    bytes,
    TRANSCRIPTION_RETRIES.ingest,
  );
}

function cachedMedia(reference: string): Buffer | undefined {
  const bytes = mediaCache.get(reference);
  if (!bytes) {
    return undefined;
  }
  mediaCache.delete(reference);
  mediaCache.set(reference, bytes);

  return bytes;
}

function cacheMedia(reference: string, bytes: Buffer): void {
  if (bytes.byteLength > MEDIA_CACHE_MAX_BYTES) {
    return;
  }
  const replaced = mediaCache.get(reference);
  if (replaced) {
    mediaCache.delete(reference);
    mediaCacheBytes -= replaced.byteLength;
  }
  mediaCache.set(reference, bytes);
  mediaCacheBytes += bytes.byteLength;
  for (const [key, value] of mediaCache) {
    if (mediaCacheBytes <= MEDIA_CACHE_MAX_BYTES) {
      break;
    }
    mediaCache.delete(key);
    mediaCacheBytes -= value.byteLength;
  }
}

/** The URL can come straight from a webhook body, so `guardedFetch` pins a public address. */
async function fetchAttachmentUrl(
  raw: string,
  transport?: PinnedFetchTransport,
): Promise<Buffer> {
  const response = await guardedFetch(raw, undefined, {
    ...transport,
    binary: true,
    bodyLimitBytes: MAX_ATTACHMENT_BYTES,
    timeoutMs: ATTACHMENT_FETCH_TIMEOUT_MS,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`provider answered ${response.status}`);
  }
  const bytes = Buffer.from(
    response.bodyBytes.buffer,
    response.bodyBytes.byteOffset,
    response.bodyBytes.byteLength,
  );
  assertWithinLimit(bytes.byteLength, response.headers["content-type"] ?? null);

  return bytes;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function imageLinks(message: ModelMessage): string[] {
  const links =
    message.role === "user" && typeof message.content !== "string"
      ? message.content.map(sealedImageLink)
      : message.role === "tool"
        ? toolContentItems(message).map(sealedToolLink)
        : [];

  return links.filter((link): link is string => link !== null);
}

/** Tool results and subagent output are file parts too, and must not be re-gated. */
function isStoredMediaPart(part: UserContentPart): boolean {
  return mediaReferenceOf(part) !== null || sealedMediaLink(part) !== null;
}

function isToolImageBytes(
  item: ToolContentPart,
): item is Extract<
  ToolContentPart,
  { type: "image-data" | "file-data" | "file" }
> {
  return (
    (item.type === "image-data" ||
      item.type === "file-data" ||
      item.type === "file") &&
    item.mediaType.startsWith("image")
  );
}

function limitForMediaType(mediaType: string | undefined): number {
  return mediaType?.startsWith("image/")
    ? MAX_IMAGE_BYTES
    : MAX_ATTACHMENT_BYTES;
}

/** Each `map` call starts in item order, so its code before an await may count. */
async function mapToolItems(
  message: ToolModelMessage,
  map: (item: ToolContentPart) => Promise<ToolContentPart>,
): Promise<ToolModelMessage> {
  const content = await Promise.all(
    message.content.map(
      async (part): Promise<ToolModelMessage["content"][number]> =>
        part.type === "tool-result" && part.output.type === "content"
          ? {
              ...part,
              output: {
                ...part.output,
                value: await Promise.all(part.output.value.map(map)),
              },
            }
          : part,
    ),
  );

  return { ...message, content: content };
}

function mediaBytes(
  value: ImagePart["image"] | FilePart["data"],
): Buffer | null {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    const dataUrl = /^data:[^,]*;base64,/i.exec(value);
    if (dataUrl) {
      return Buffer.from(value.slice(dataUrl[0].length), "base64");
    }

    return /^[a-z][a-z0-9+.-]*:/i.test(value)
      ? null
      : Buffer.from(value, "base64");
  }
  if (!(value instanceof URL) && "type" in value && value.type === "data") {
    return mediaBytes(value.data);
  }

  return null;
}

function mediaFileName(
  attachment: Attachment,
  mediaType: string,
  index: number,
): string {
  if (attachment.name) {
    return attachment.name;
  }
  const extension = mediaTypeToExtension(mediaType);

  return `${attachment.type}-${index + 1}${extension ? `.${extension}` : ""}`;
}

function mediaPath(name: string, eventId: string, index: number): string {
  const folder = createHash("sha256")
    .update(eventId)
    .digest("hex")
    .slice(0, 12);
  const safeName = name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${MEDIA_DIRECTORY}/${folder}/${index}-${safeName || "attachment"}`;
}

function mediaReferenceOf(part: UserContentPart): MediaReference | null {
  if (part.type === "image") {
    return parseMediaReference(part.image);
  }
  if (part.type === "file") {
    return parseMediaReference(part.data);
  }

  return null;
}

function mediaReferenceUrl(
  attachment: Attachment,
  mediaType: string,
  name: string,
  channelName: string,
): string | undefined {
  const metadata =
    attachment.fetchMetadata ??
    (attachment.url ? { url: attachment.url } : undefined);
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }
  const url = new URL(
    `${MEDIA_REFERENCE_SCHEME}//${channelName}/${encodeURIComponent(name)}`,
  );
  for (const [key, value] of Object.entries(metadata)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("mediaType", mediaType);
  url.searchParams.set("type", attachment.type);

  return url.toString();
}

function nativePart(
  item: StoredAttachment,
  provider: AccountModelProviderName | undefined,
  source: string | Buffer | undefined,
): UserContentPart | null {
  if (!source) {
    return null;
  }
  if (item.mediaType.startsWith("image/")) {
    return { type: "image", image: source, mediaType: item.mediaType };
  }
  if (!acceptsNativeMedia(provider, item.mediaType)) {
    return null;
  }

  return {
    type: "file",
    data: source,
    mediaType: item.mediaType,
    filename: item.name,
  };
}

function parseMediaReference(value: unknown): MediaReference | null {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${MEDIA_REFERENCE_SCHEME}//`)
  ) {
    return null;
  }
  const url = new URL(value);
  const metadata: Record<string, string> = {};
  for (const [key, entry] of url.searchParams) {
    if (key !== "mediaType" && key !== "type") {
      metadata[key] = entry;
    }
  }
  const kind = url.searchParams.get("type");

  return {
    channelName: url.hostname,
    mediaType: url.searchParams.get("mediaType") ?? "application/octet-stream",
    name: decodeURIComponent(url.pathname.slice(1)),
    metadata: metadata,
    type:
      kind === "image" || kind === "audio" || kind === "video" ? kind : "file",
    url: value,
  };
}

// Null keeps the link (a read error is no proof of deletion). The account check alone ties a
// pasted link to the running account, and this read runs on core's own credentials.
async function readSealedMedia(
  link: string | null,
  replay: SealedReplay,
): Promise<SealedMedia | null> {
  if (!link) {
    return null;
  }
  const ticket = openMediaTicket(
    link.slice(link.indexOf(MEDIA_PATH_PREFIX) + MEDIA_PATH_PREFIX.length),
    requireSecretsEnv("MEDIA_TICKET_SECRET"),
  );
  if (!ticket) {
    return link.startsWith(`${getHarnessPublicUrl()}${MEDIA_PATH_PREFIX}`)
      ? { gone: "a linked file" }
      : null;
  }
  if (ticket.accountId !== replay.accountId) {
    return null;
  }
  const cached = cachedMedia(link);
  if (cached) {
    if (cached.byteLength > Math.min(MAX_IMAGE_BYTES, replay.remainingBytes)) {
      return null;
    }
    replay.remainingBytes -= cached.byteLength;

    return { bytes: cached };
  }
  try {
    const object = await locateMediaObject(ticket);
    if (!object) {
      return { gone: basename(ticket.path) };
    }
    // Charged before the read, so links read side by side never pass the budget together.
    const size = object.head.contentLength;
    if (
      size === undefined ||
      size > Math.min(MAX_IMAGE_BYTES, replay.remainingBytes)
    ) {
      return null;
    }
    replay.remainingBytes -= size;
    const bytes = Buffer.from(await readMediaObject(object, ticket));
    cacheMedia(link, bytes);

    return { bytes: bytes };
  } catch (err) {
    logWarn("Stored media link could not be read", {
      path: ticket.path,
      error: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
}

async function rehydrateMessage(
  message: ModelMessage,
  agentConfig: AgentConfig,
  replay: SealedReplay,
): Promise<ModelMessage> {
  if (message.role === "tool") {
    return rehydrateToolMessage(message, replay);
  }
  if (message.role !== "user" || typeof message.content === "string") {
    return message;
  }
  const provider = agentConfig.model?.provider;
  const content = await Promise.all(
    message.content.map(async (part): Promise<UserContentPart> => {
      if (part.type !== "image" && part.type !== "file") {
        return part;
      }
      // Re-gated for the current provider: a part stored under another could fail every turn.
      if (
        part.type === "file" &&
        isStoredMediaPart(part) &&
        !acceptsNativeMedia(provider, part.mediaType)
      ) {
        return {
          type: "text",
          text: unreadableMediaNote(part.filename, part.mediaType),
        };
      }
      const reference = mediaReferenceOf(part);
      if (!reference) {
        const sealed = await readSealedMedia(sealedMediaLink(part), replay);
        if (!sealed) {
          return part;
        }
        if ("gone" in sealed) {
          return {
            type: "text",
            text: `[${sealed.gone} is no longer available]`,
          };
        }

        return part.type === "image"
          ? { ...part, image: sealed.bytes }
          : { ...part, data: sealed.bytes };
      }
      const bytes = await resolveMediaReference(reference, agentConfig);
      if (!bytes) {
        return {
          type: "text",
          text: `[${reference.name} is no longer available from ${reference.channelName}]`,
        };
      }

      return part.type === "image"
        ? { ...part, image: bytes }
        : { ...part, data: bytes };
    }),
  );

  return { ...message, content: content };
}

/** A link is never left for the provider: Bedrock refuses a URL in a tool result. */
async function rehydrateToolMessage(
  message: ToolModelMessage,
  replay: SealedReplay,
): Promise<ToolModelMessage> {
  if (imageLinks(message).length === 0) {
    return message;
  }

  return mapToolItems(message, async (item): Promise<ToolContentPart> => {
    const link = sealedToolLink(item);
    if (item.type !== "file-url" || !link) {
      return item;
    }
    const sealed = await readSealedMedia(link, replay);
    if (!sealed) {
      return { type: "text", text: OMITTED_MEDIA_NOTE };
    }

    return "gone" in sealed
      ? { type: "text", text: `[${sealed.gone} is no longer available]` }
      : {
          type: "file",
          mediaType: item.mediaType ?? "application/octet-stream",
          data: { type: "data", data: sealed.bytes },
        };
  });
}

async function resolveMediaReference(
  reference: MediaReference,
  agentConfig: AgentConfig,
): Promise<Buffer | null> {
  const cached = cachedMedia(reference.url);
  if (cached) {
    return cached;
  }
  try {
    const attachment: Attachment = {
      type: reference.type,
      name: reference.name,
      mimeType: reference.mediaType,
      fetchMetadata: reference.metadata,
      ...(reference.metadata.url ? { url: reference.metadata.url } : {}),
    };
    const adapter = channelAdapterFromConfig(
      agentConfig,
      reference.channelName,
    );
    const bytes = await readAttachmentBytes(
      adapter?.rehydrateAttachment?.(attachment) ?? attachment,
    );
    assertWithinLimit(bytes.byteLength, reference.mediaType);
    cacheMedia(reference.url, bytes);

    return bytes;
  } catch (err) {
    logWarn("Stored attachment could not be read again", {
      channel: reference.channelName,
      name: reference.name,
      error: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
}

async function sealBytes(
  value: ImagePart["image"] | FilePart["data"],
  claimed: string | undefined,
  accountId: string,
): Promise<{ link: string; mediaType: string } | undefined> {
  const bytes = mediaBytes(value);
  if (!bytes || bytes.byteLength === 0) {
    return undefined;
  }
  const mediaType = resolveMediaType(bytes, claimed);
  try {
    assertWithinLimit(bytes.byteLength, mediaType);
    const extension = mediaTypeToExtension(mediaType);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const ticket: AttachmentMediaTicket = {
      accountId: accountId,
      path: `${MEDIA_DIRECTORY}/${hash}${extension ? `.${extension}` : ""}`,
    };
    const link = sealedLinkFor(ticket);
    if (!link) {
      return undefined;
    }
    await writeS3Object(
      requireEnv("FILESYSTEM_BUCKET_NAME"),
      attachmentStoreKey(ticket),
      bytes,
      { contentType: mediaType },
    );
    cacheMedia(link, bytes);

    return { link: link, mediaType: mediaType };
  } catch (err) {
    logWarn("Conversation media could not be stored", {
      accountId: accountId,
      mediaType: mediaType,
      error: err instanceof Error ? err.message : String(err),
    });

    return undefined;
  }
}

function sealedImageLink(part: UserContentPart): string | null {
  return part.type === "image" ||
    (part.type === "file" && part.mediaType.startsWith("image"))
    ? sealedMediaLink(part)
    : null;
}

function sealedLinkFor(ticket: AttachmentMediaTicket): string | undefined {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) {
    return undefined;
  }
  const token = sealMediaTicket(
    ticket,
    requireSecretsEnv("MEDIA_TICKET_SECRET")[0],
  );

  return `${baseUrl}${MEDIA_PATH_PREFIX}${token}`;
}

function sealedMediaLink(part: UserContentPart): string | null {
  if (part.type !== "image" && part.type !== "file") {
    return null;
  }
  const value = part.type === "image" ? part.image : part.data;

  return typeof value === "string" && value.includes(MEDIA_PATH_PREFIX)
    ? value
    : null;
}

function sealedToolLink(item: ToolContentPart): string | null {
  return item.type === "file-url" &&
    item.mediaType?.startsWith("image") === true &&
    item.url.includes(MEDIA_PATH_PREFIX)
    ? item.url
    : null;
}

async function sealMessageMedia(
  message: ModelMessage,
  accountId: string,
): Promise<ModelMessage> {
  if (message.role === "user" && typeof message.content !== "string") {
    const content = await Promise.all(
      message.content.map(async (part): Promise<UserContentPart> => {
        if (part.type !== "image" && part.type !== "file") {
          return part;
        }
        const sealed = await sealBytes(
          part.type === "image" ? part.image : part.data,
          part.mediaType,
          accountId,
        );
        if (!sealed) {
          return part;
        }

        return part.type === "image"
          ? { ...part, image: sealed.link, mediaType: sealed.mediaType }
          : { ...part, data: sealed.link, mediaType: sealed.mediaType };
      }),
    );

    return { ...message, content: content };
  }
  if (message.role !== "tool") {
    return message;
  }

  return mapToolItems(message, async (item): Promise<ToolContentPart> => {
    const sealed = isToolImageBytes(item)
      ? await sealBytes(item.data, item.mediaType, accountId)
      : undefined;

    return sealed
      ? { type: "file-url", url: sealed.link, mediaType: sealed.mediaType }
      : item;
  });
}

async function storeAttachment(
  attachment: Attachment,
  index: number,
  context: InboundMediaContext,
): Promise<StoredAttachment> {
  const claimed = attachment.mimeType;
  const fallbackName = attachment.name ?? `${attachment.type}-${index + 1}`;
  let receivedBytes = 0;
  try {
    if (
      attachment.size !== undefined &&
      attachment.size > limitForMediaType(claimed)
    ) {
      throw new Error(
        `file is larger than ${formatBytes(limitForMediaType(claimed))}`,
      );
    }
    const bytes = await readAttachmentBytes(attachment);
    receivedBytes = bytes.byteLength;
    const mediaType = resolveMediaType(bytes, claimed);
    assertWithinLimit(bytes.byteLength, mediaType);
    const name = mediaFileName(attachment, mediaType, index);
    const transcribing = audioTranscript(bytes, mediaType, context.agentConfig);
    const workspace = context.workspace;
    if (!workspace || !context.accountId) {
      const reference = mediaReferenceUrl(
        attachment,
        mediaType,
        name,
        context.channelName,
      );
      if (reference) {
        cacheMedia(reference, bytes);
      }

      const transcript = await transcribing;

      return {
        name: name,
        mediaType: mediaType,
        data: bytes,
        ...(reference ? { reference: reference } : {}),
        ...(transcript ? { transcript: transcript } : {}),
        receivedBytes: receivedBytes,
      };
    }
    const path = mediaPath(name, context.eventId, index);
    const [transcript, url] = await Promise.all([
      transcribing,
      writeMediaObject(workspace, context.accountId, path, bytes, mediaType),
    ]);

    return {
      name: name,
      mediaType: mediaType,
      path: path,
      ...(url ? { url: url } : { data: bytes }),
      ...(transcript ? { transcript: transcript } : {}),
      receivedBytes: receivedBytes,
    };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    logWarn("Inbound attachment could not be stored", {
      channel: context.channelName,
      eventId: context.eventId,
      attachmentType: attachment.type,
      error: failure,
    });

    return {
      name: fallbackName,
      mediaType: claimed ?? "application/octet-stream",
      failure: failure,
      receivedBytes: receivedBytes,
    };
  }
}

function transcriptLine(item: StoredAttachment): string {
  const transcript = item.transcript;
  if (!transcript) {
    return "";
  }
  if (transcript.status === "transcribed") {
    return transcript.text
      ? `\n  Transcript: ${transcript.text}`
      : "\n  Transcript: no speech in the recording.";
  }

  return `\n  Not transcribed: ${transcript.reason}. ${transcriptAdvice(transcript.recovery, item.path)}`;
}

function whereItLanded(
  item: StoredAttachment,
  part: UserContentPart | null,
  channelName: string,
): string {
  if (item.path) {
    return `saved to ${item.path}`;
  }
  if (item.reference) {
    return `is read from ${channelName} whenever it is needed; it lasts as long as ${channelName} keeps the file.`;
  }
  if (part) {
    return "is available for this message only; no workspace is attached to store it.";
  }

  return "could not be shown: this model does not accept the type, and there is no workspace to store it in.";
}

async function withOldMediaOmitted(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const over = messages.flatMap(imageLinks).length - MAX_REPLAYED_MEDIA;
  if (over <= 0) {
    return messages;
  }
  // Whole batches keep the prompt's opening, and its cache, stable across turns.
  let toOmit = Math.ceil(over / REPLAY_OMIT_BATCH) * REPLAY_OMIT_BATCH;
  const omits = (link: string | null): boolean => {
    if (link === null || toOmit <= 0) {
      return false;
    }
    toOmit -= 1;

    return true;
  };
  const note = { type: "text" as const, text: OMITTED_MEDIA_NOTE };

  return await Promise.all(
    messages.map(async (message): Promise<ModelMessage> => {
      if (message.role === "user" && typeof message.content !== "string") {
        return {
          ...message,
          content: message.content.map((part): UserContentPart =>
            omits(sealedImageLink(part)) ? note : part,
          ),
        };
      }

      return message.role === "tool"
        ? mapToolItems(message, async (item): Promise<ToolContentPart> =>
            omits(sealedToolLink(item)) ? note : item,
          )
        : message;
    }),
  );
}

async function writeMediaObject(
  workspace: ResolvedWorkspace,
  accountId: string,
  path: string,
  bytes: Buffer,
  mediaType: string,
): Promise<string | undefined> {
  const ticket: AttachmentMediaTicket = { accountId: accountId, path: path };
  const target = await resolveS3ReadTarget(
    workspaceReadContext(workspace.config.storage, workspace.namespace),
  );
  await Promise.all([
    writeS3Object(target.bucket, `${target.prefix}${path}`, bytes, {
      contentType: mediaType,
      access: target.access,
    }),
    writeS3Object(
      requireEnv("FILESYSTEM_BUCKET_NAME"),
      attachmentStoreKey(ticket),
      bytes,
      { contentType: mediaType },
    ),
  ]);

  return sealedLinkFor(ticket);
}

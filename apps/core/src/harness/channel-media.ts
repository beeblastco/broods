/**
 * Inbound channel media, the mirror of the outbound `send-files` / `send-images` path.
 *
 * With a workspace, each attachment is read once and written twice. The row keeps a sealed,
 * non-expiring media ticket into the attachment store, a managed-bucket prefix
 * no sandbox mounts, so replayed turns keep working even after the agent tidies
 * its files. Each turn reads the bytes behind it once and hands the model those,
 * so the provider never fetches the link again on every step. The agent's own
 * copy goes under `media/` in its default workspace, for what the model cannot
 * read natively.
 *
 * With no workspace the row keeps a `broods-media:` reference instead, and the
 * channel is asked for the bytes again on replay, for as long as it keeps them.
 */

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

/** Where an inbound attachment lands, relative to the workspace root. */
const MEDIA_DIRECTORY = "media";

/**
 * The scheme naming a file the channel still holds. Its own scheme, not
 * `https:`, because nothing but this module may resolve it: the model provider
 * would fetch a bare URL itself, without the bot token it needs and without a
 * way to fail softly when the file is gone.
 */
export const MEDIA_REFERENCE_SCHEME = "broods-media:";

// Bytes read back from a channel, kept so the same picture is not downloaded
// again for every turn that replays it. Small on purpose: core's pod has a
// gigabyte for everything, and the cache is a courtesy, not the storage.
const MEDIA_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Sealed-link bytes one turn inlines into the prompt. Every replayed picture
// rides each model request as base64, and providers cap a request (Anthropic at
// 32 MB, after base64's third), while the pod holds them all at once. Past it a
// user part's link stays a link and the provider fetches it, as it did before
// replay read; a tool result's becomes OMITTED_MEDIA_NOTE. One file inlines
// only up to the picture cap, so a big PDF stays a link too.
const MAX_REPLAY_BYTES_PER_TURN = 20 * 1024 * 1024;

// Stored pictures one turn replays, the newest. Each rides every model request,
// and Anthropic refuses more than 100 images in one, or any side over 2000 px
// once there are more than 20. Older ones become OMITTED_MEDIA_NOTE.
const MAX_REPLAYED_MEDIA = 20;

// Pictures past the cap are dropped this many at a time, so between
// MAX_REPLAYED_MEDIA - REPLAY_OMIT_BATCH and MAX_REPLAYED_MEDIA replay.
const REPLAY_OMIT_BATCH = 10;

// What the model reads where a stored picture is not shown this turn.
const OMITTED_MEDIA_NOTE = "[an earlier image is not shown here]";

// A bound on one message, not on the conversation. Every attachment past it is
// still named for the agent; only the bytes are left with the provider.
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// A stalled provider download must not hold the turn open until the platform
// kills it; past this the attachment becomes a described failure instead.
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

// A sniff that only proves "this is a zip" must not overrule a provider that
// already said which zip it is, since .docx and .xlsx are both zip containers.
const UNSPECIFIC_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "application/x-zip-compressed",
  "application/zip",
]);

/**
 * What each provider reads as a native prompt part beyond pictures, as exact
 * media types or a `type/*` wildcard.
 *
 * A floor, not a ceiling: a media type missing here is not rejected, it is
 * delivered as a workspace file instead of as a part the provider would refuse.
 * Guessing upward is the expensive direction. An unsupported part fails the
 * whole turn, while an under-claimed one costs the agent one `read` call.
 *
 * The model's own `supportedUrls` is not this question. It says which URLs the
 * provider fetches for itself, so bedrock omits the PDFs it does read as bytes
 * and vertex claims `*`. Asking it would demote and promote the wrong things.
 */
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

// Least-recently-used first, which is the order `cacheMedia` evicts in.
const mediaCache = new Map<string, Buffer>();
let mediaCacheBytes = 0;

/** What `ingestInboundAttachments` needs to know about the message's run. */
export interface InboundMediaContext {
  accountId?: string;
  /** The agent the message is for; its project is billed the ingress. */
  agentId?: string;
  /**
   * Decides which media types go over as native parts, and supplies the
   * credentials audio is transcribed with. Absent means neither: every
   * attachment becomes a workspace file, which is the safe direction.
   */
  agentConfig?: AgentConfig;
  /** Names the channel in the note the agent reads, and in the logs. */
  channelName: string;
  /** Scopes the media folder so two messages cannot overwrite each other. */
  eventId: string;
  /** Where the bytes are stored. Without one, only the current turn sees them. */
  workspace?: ResolvedWorkspace;
}

/**
 * One attachment paired with the part it produced. A null part means the model
 * gets no prompt part for it, so the note has to describe it.
 */
interface IngestedAttachment {
  stored: StoredAttachment;
  part: UserContentPart | null;
}

/**
 * One ingested message in its two forms. `turn` is what the turn starts from:
 * sealed links, and raw bytes for an agent with no workspace. `stored` is what
 * the row keeps: the same sealed links, or a reference that reads the bytes
 * again later. Bytes never appear in `stored`, where a 6 MB picture would
 * become an 8 MB JSON row.
 */
export interface IngestedMediaParts {
  stored: UserContentPart[];
  turn: UserContentPart[];
}

/** A file a channel still holds, named well enough to ask for it again. */
interface MediaReference {
  channelName: string;
  mediaType: string;
  name: string;
  /** What the channel's own adapter needs: a Telegram file id, a Slack URL. */
  metadata: Record<string, string>;
  type: Attachment["type"];
  /** The reference as stored, which is also what the byte cache is keyed by. */
  url: string;
}

/**
 * One attachment after ingestion: where its bytes ended up (workspace, channel
 * reference, or memory for this turn only), or why they could not be read.
 */
interface StoredAttachment {
  name: string;
  mediaType: string;
  /** The bytes themselves, kept when there is no sealed link (no workspace or no public base URL). */
  data?: Buffer;
  /** Set once the bytes are in the workspace. */
  path?: string;
  /** How to ask the channel for these bytes again, when nothing stored them. */
  reference?: string;
  /** The sealed link the model is handed. Absent with no workspace or no public base URL. */
  url?: string;
  /** Why the bytes are not available, for the note the agent reads. */
  failure?: string;
  /** What the audio says, or why it is not known. Absent for everything else. */
  transcript?: TranscriptOutcome;
  /** Bytes read from the channel, metered as ingress even when a later step failed. */
  receivedBytes: number;
}

/** A sealed link read back: its bytes, or the name of the file that is gone. */
type SealedMedia = { bytes: Buffer } | { gone: string };

/** One turn's sealed-link reads: whose links it may open, and bytes left. */
interface SealedReplay {
  accountId: string | undefined;
  remainingBytes: number;
}

type UserContentPart = Exclude<UserContent, string>[number];

/**
 * Whether this provider reads this media type as a prompt part of its own.
 * Pictures are the one kind every provider takes; everything else has to be
 * listed, exactly or as a `type/*` wildcard.
 */
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

/**
 * Reads each attachment once and returns the parts to append to the message.
 *
 * Never throws: an attachment that cannot be read becomes a line of text saying
 * so, because a provider outage should cost the agent one picture, not the turn,
 * and a silent drop would leave the model answering half a message.
 */
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
  // Free to the account; metered once per message so the billing tab can
  // show the data its channels sent in.
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
    // A sealed link is already the same part in both. Bytes are not: the row
    // keeps the reference that reads them again, or keeps no media at all.
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

/**
 * The bytes behind one attachment, however this provider carries them.
 * Telegram never sets a URL and signs its download with the bot token; Slack
 * needs a bearer header on a private file. Both hand that over as `fetchData`,
 * so the reader the adapter built is always preferred to the raw URL.
 */
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
    return await attachment.fetchData();
  }
  if (!attachment.url) {
    throw new Error("attachment carries neither data, a reader, nor a URL");
  }

  return await fetchAttachmentUrl(attachment.url, transport);
}

/**
 * Reads the media a stored conversation only points at, so a picture sent last
 * week is still a picture this turn.
 *
 * Every reference is resolved through the channel that delivered it, with that
 * channel's own credentials, and every sealed link is read into bytes, which
 * also catches a workspace file the agent deleted. Either one gone becomes a line of text
 * saying so: a photo the sender deleted must cost that message its picture, not
 * cost the conversation every turn from here on.
 */
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

  // Newest first: a cached link is charged before its read starts, so when the
  // budget runs out it is the oldest pictures that stay behind, not the latest.
  const replayed = await Promise.all(
    (await withOldMediaOmitted(messages))
      .toReversed()
      .map((message): Promise<ModelMessage> =>
        rehydrateMessage(message, agentConfig, replay),
      ),
  );

  return replayed.toReversed();
}

/**
 * The bytes win over the provider's claim. Telegram calls every photo a JPEG
 * whatever was uploaded, and Discord labels a voice note `application/ogg`
 * without saying whether it is audio or video. The exception is a sniff that
 * only identifies the container: a .docx really is a zip, and "zip" is a worse
 * answer than the one the provider already gave.
 */
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

/**
 * Moves the media a message carries as bytes into the attachment store, so its
 * row keeps a sealed link `rehydrateStoredMedia` reads back on every later turn
 * instead of dropping the picture. A part that cannot be stored stays as it
 * was, and the row drops it as before.
 */
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
  // With no public base URL there is no link to keep, so nothing is stored.
  if (!carriesMedia || !getHarnessPublicUrl()) {
    return messages;
  }

  return await Promise.all(
    messages.map((message): Promise<ModelMessage> =>
      sealMessageMedia(message, accountId),
    ),
  );
}

/** Throws the size failure `storeAttachment` turns into the agent's note. */
function assertWithinLimit(size: number, mediaType: string | null): void {
  const limit = limitForMediaType(mediaType ?? undefined);
  if (size > limit) {
    throw new Error(`file is larger than ${formatBytes(limit)}`);
  }
}

/**
 * The line the agent reads: what arrived, where it landed, and what to do with
 * the parts the model cannot see for itself. The "read it yourself" wording is
 * deliberate. Told only that a file exists, models ask the sender to paste it.
 */
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

/**
 * Audio the model cannot hear for itself, read into words. Skipped where the
 * provider takes the recording natively, since listening to it beats a
 * transcript of it.
 */
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

/**
 * Bytes for a reference, if this pod still holds them. Re-inserting on a hit
 * keeps the Map in least-recently-used order, which is the order eviction wants.
 */
function cachedMedia(reference: string): Buffer | undefined {
  const bytes = mediaCache.get(reference);
  if (!bytes) {
    return undefined;
  }
  mediaCache.delete(reference);
  mediaCache.set(reference, bytes);

  return bytes;
}

/**
 * Keeps bytes for the next turn that replays this message, evicting the least
 * recently used until the cache is back under its ceiling.
 */
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

/**
 * Downloads an attachment named only by URL. The URL is untrusted (Zalo and
 * Pancake take it straight from the webhook body), so `guardedFetch` pins the
 * validated public address on every hop and caps the body as it streams.
 */
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
  // A zero-copy view, not Buffer.from(bytes): the guard already assembled the
  // body into a fresh allocation nothing else references, and a second copy of
  // a 25 MB attachment is pure waste.
  const bytes = Buffer.from(
    response.bodyBytes.buffer,
    response.bodyBytes.byteOffset,
    response.bodyBytes.byteLength,
  );
  assertWithinLimit(bytes.byteLength, response.headers["content-type"] ?? null);

  return bytes;
}

/** Whole megabytes, for the size limit in a failure note. */
function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The sealed picture links a message carries, in order. */
function imageLinks(message: ModelMessage): string[] {
  const links =
    message.role === "user" && typeof message.content !== "string"
      ? message.content.map(sealedImageLink)
      : message.role === "tool"
        ? toolContentItems(message).map(sealedToolLink)
        : [];

  return links.filter((link): link is string => link !== null);
}

/**
 * A part this module stored: a channel reference or a sealed media link. Tool
 * results and subagent output are file parts too, and must not be re-gated.
 */
function isStoredMediaPart(part: UserContentPart): boolean {
  return mediaReferenceOf(part) !== null || sealedMediaLink(part) !== null;
}

/** A tool result's picture that may carry its own bytes, the one tool media a row keeps. */
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

/** The byte cap for one attachment: smaller for pictures, which go inline. */
function limitForMediaType(mediaType: string | undefined): number {
  return mediaType?.startsWith("image/")
    ? MAX_IMAGE_BYTES
    : MAX_ATTACHMENT_BYTES;
}

/**
 * A tool message with `map` applied to every content item of its results. Each
 * `map` call starts in item order, so its code before an await may count.
 */
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

/**
 * The bytes a part carries itself. Null for anything that already points
 * elsewhere: a URL, a sealed link, a channel reference, a provider reference.
 */
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

/**
 * A name to store the file under. Telegram photos and voice notes both arrive
 * nameless, and a file with no name lands extensionless, so every client, and
 * the media route, would treat it as a raw download.
 */
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

/**
 * A workspace path an agent can read back, and a shell will not fight over.
 * The hash keeps two messages that both carry `image.jpg` apart without making
 * the name unreadable.
 */
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

/** The channel reference an image or file part carries, or null. */
function mediaReferenceOf(part: UserContentPart): MediaReference | null {
  if (part.type === "image") {
    return parseMediaReference(part.image);
  }
  if (part.type === "file") {
    return parseMediaReference(part.data);
  }

  return null;
}

/**
 * How to ask this channel for these bytes again. The chat SDK already names
 * what each provider needs in `fetchMetadata`, a Telegram file id or a Slack
 * private URL, so that map is carried verbatim rather than re-derived, and a
 * provider that names nothing but a URL falls back to it.
 */
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

/**
 * The part the model actually receives. Pictures go over as pictures; anything
 * else only when this provider reads it, because a part a provider refuses
 * fails the whole turn while a file it never saw costs one `read`.
 */
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

/**
 * The reference a stored part points at, or null for anything else: bytes, a
 * sealed workspace link, an ordinary URL the model provider reads for itself.
 */
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

/**
 * The bytes behind a sealed link, read once per turn and kept in the media
 * cache. A link left for the provider is fetched by it again on every model
 * step, and a file the agent deleted would 404 there and fail the whole turn.
 * Null keeps a user part's link (a tool result's becomes a note): not a sealed
 * link, another account's link, a file over
 * the picture cap or past the turn's budget, or a read error (a file over the media cap among them),
 * which is not proof of a deletion. The account check matters because this
 * read runs on core's own credentials and meters the ticket's account, and
 * nothing else ties a link pasted into a conversation to the account running it.
 */
async function readSealedMedia(
  link: string | null,
  replay: SealedReplay,
): Promise<SealedMedia | null> {
  const ticket = link
    ? openMediaTicket(
        link.slice(link.indexOf(MEDIA_PATH_PREFIX) + MEDIA_PATH_PREFIX.length),
        requireSecretsEnv("MEDIA_TICKET_SECRET"),
      )
    : null;
  if (!link || !ticket || ticket.accountId !== replay.accountId) {
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
    // The head's length is charged before the read, so links read side by
    // side never pass the budget together; the read itself caps the object.
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

/**
 * One stored message with its references read back. A reference the channel
 * will not serve, or a workspace link whose file is gone, becomes text in the
 * same position, so the turn still says a file was there and the model stops
 * waiting to be shown it.
 */
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
      // The gate runs again here, against the model running now. A part stored
      // while the agent was on another provider would otherwise be replayed as
      // a part that provider refuses, and fail every turn from here on rather
      // than the one it arrived in.
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

/**
 * A tool message with its sealed links read back into bytes, or into a line
 * when they cannot be. A link is never left for the provider: Bedrock refuses
 * a URL in a tool result before the request is sent.
 */
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

/**
 * The bytes behind one reference, read through the channel that delivered it so
 * the provider's own credentials are used. Null rather than a throw: this runs
 * while a turn is being assembled, and one unreadable picture must not take the
 * conversation with it.
 */
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

/**
 * Stores bytes in the attachment store under their hash, so a screenshot sent
 * twice is kept once, and returns the sealed link with the type the bytes name.
 * Undefined for a part that carries no bytes, with no public base URL, or when
 * the bytes are over the attachment cap or cannot be stored: the caller keeps
 * the part as it was.
 */
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

/** The sealed media URL a picture points at, or null; a PDF is not one. */
function sealedImageLink(part: UserContentPart): string | null {
  return part.type === "image" ||
    (part.type === "file" && part.mediaType.startsWith("image"))
    ? sealedMediaLink(part)
    : null;
}

/** The public link that opens a ticket; undefined with no public base URL. */
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

/** The sealed media URL an image or file part points at, or null. */
function sealedMediaLink(part: UserContentPart): string | null {
  if (part.type !== "image" && part.type !== "file") {
    return null;
  }
  const value = part.type === "image" ? part.image : part.data;

  return typeof value === "string" && value.includes(MEDIA_PATH_PREFIX)
    ? value
    : null;
}

/** The sealed media URL a tool result's content item points at, or null. */
function sealedToolLink(item: ToolContentPart): string | null {
  return item.type === "file-url" &&
    item.mediaType?.startsWith("image") === true &&
    item.url.includes(MEDIA_PATH_PREFIX)
    ? item.url
    : null;
}

/** One message with each picture or file it carries as bytes swapped for a sealed link. */
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

  // Only a tool's pictures: another file it returns is dropped from the row.
  return mapToolItems(message, async (item): Promise<ToolContentPart> => {
    const sealed = isToolImageBytes(item)
      ? await sealBytes(item.data, item.mediaType, accountId)
      : undefined;

    return sealed
      ? { type: "file-url", url: sealed.link, mediaType: sealed.mediaType }
      : item;
  });
}

/**
 * Reads one attachment and stores it in the workspace behind a sealed link, or
 * as a channel reference when there is no workspace. Never throws: a failure
 * comes back as `failure`, so one unreadable picture costs a line of text.
 */
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
    // With nothing to store the bytes in, the row keeps a reference to the copy
    // the channel already has. The bytes just read are cached under it, so the
    // turns that follow this one do not go back out for the same picture.
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

/**
 * What the audio said, or what to do about not knowing.
 */
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

/**
 * Where the agent goes to open this attachment, or why it cannot.
 */
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

/**
 * The messages with every sealed picture before the newest MAX_REPLAYED_MEDIA as
 * a line of text, so a long conversation replays its recent pictures, not all.
 * Other files are not counted: the cap is the providers' limit on images.
 */
async function withOldMediaOmitted(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const over = messages.flatMap(imageLinks).length - MAX_REPLAYED_MEDIA;
  if (over <= 0) {
    return messages;
  }
  // Whole batches, so the prompt's opening stays the same, and stays cached,
  // for the next REPLAY_OMIT_BATCH pictures instead of changing every turn.
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

/**
 * Writes the workspace copy straight to S3 on the mount's credentials (the
 * assumed role for a bring-your-own bucket) and the attachment store copy on
 * the harness's own role, so no sandbox has to boot, then returns the sealed
 * link. Returns undefined with no public base URL: the files are stored, but a
 * link would resolve nowhere.
 */
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

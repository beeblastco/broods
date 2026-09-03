/**
 * Inbound channel media — the mirror of the outbound `send-files` / `send-images` path.
 *
 * A picture, document, voice note or video that arrives on a channel is read
 * once, stored in the agent's workspace, and handed to the model as a sealed
 * media link rather than as bytes. That link is the same durable ticket the
 * outbound tools mint: storage stays private, the ticket is the only credential,
 * and it never expires, so the turn still resolves when the conversation is
 * replayed months later. A presigned S3 URL cannot do that, and inlining base64
 * cannot either — the conversation is persisted as JSON.
 *
 * Whatever the model cannot read natively still arrives. It becomes a saved
 * workspace file the agent can open with `read` or `bash`, so a voice note is a
 * transcription job rather than a failed turn.
 *
 * An agent with no workspace stores nothing and keeps the media anyway: the
 * message row holds a reference to the file the channel still hosts, and the
 * bytes are read from the channel again whenever a later turn replays that
 * message. How long that keeps working is the channel's answer, not ours —
 * Telegram serves a file id forever, a Discord link dies within a day.
 */

import {
  detectMediaType,
  getTopLevelMediaType,
  mediaTypeToExtension,
} from "@ai-sdk/provider-utils";
import type { ModelMessage, UserContent } from "ai";
import type { Attachment } from "chat";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { channelAdapterFromConfig } from "./integrations.ts";
import { createHash } from "node:crypto";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import { getHarnessPublicUrl, requireEnv } from "../shared/env.ts";
import { guardedFetch } from "./isolate/runner/pinned-fetch.mjs";
import type { PinnedFetchTransport } from "../shared/http.ts";
import { logWarn } from "../shared/log.ts";
import { MEDIA_PATH_PREFIX, sealMediaTicket } from "../shared/media-ticket.ts";
import { unreadableMediaNote } from "../shared/media-types.ts";
import { writeS3Object } from "../shared/s3.ts";
import type { ResolvedWorkspace } from "../shared/workspaces.ts";
import { transcribeAudio, type TranscriptOutcome } from "./transcribe.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";

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

// One ceiling for everything stored, matching the public media route: past it
// the route answers 413 and the link the model was handed would be dead.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Pictures are the one kind a model reads inline on nearly every provider, and
// a 25 MB one costs far more in tokens than it carries in meaning.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// A bound on one message, not on the conversation. Every attachment past it is
// still named for the agent; only the bytes are left with the provider.
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// A stalled provider download must not hold the turn open until the platform
// kills it; past this the attachment becomes a described failure instead.
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

// A sniff that only proves "this is a zip" must not overrule a provider that
// already said which zip it is — .docx and .xlsx are both zip containers.
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
 * Guessing upward is the expensive direction — an unsupported part fails the
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

type UserContentPart = Exclude<UserContent, string>[number];

// Least-recently-used first, which is the order `cacheMedia` evicts in.
const mediaCache = new Map<string, Buffer>();
let mediaCacheBytes = 0;

/**
 * One ingested message in its two forms. `turn` is what the model reads now:
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

export interface InboundMediaContext {
  accountId?: string;
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

// One attachment after ingestion, in either of the two states that matter: it
// reached the workspace, or it did not and the agent is told why.
interface StoredAttachment {
  name: string;
  mediaType: string;
  /** The bytes themselves, kept only when no durable link exists to hand over. */
  data?: Buffer;
  /** Set once the bytes are in the workspace. */
  path?: string;
  /** How to ask the channel for these bytes again, when nothing stored them. */
  reference?: string;
  /** The sealed link the model is handed. Absent when there is no workspace. */
  url?: string;
  /** Why the bytes are not available, for the note the agent reads. */
  failure?: string;
  /** What the audio says, or why it is not known. Absent for everything else. */
  transcript?: TranscriptOutcome;
}

// One attachment paired with the part it produced. A null part means nothing
// about it reached the model, which the note has to say rather than imply the
// file is there to look at.
interface IngestedAttachment {
  stored: StoredAttachment;
  part: UserContentPart | null;
}

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
 * so. A provider outage should cost the agent one picture, not the turn — and a
 * silent drop would leave the model answering a message it cannot see the half
 * of.
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
 * channel's own credentials. One the channel no longer serves becomes a line of
 * text saying so: a photo the sender deleted must cost that message its picture,
 * not cost the conversation every turn from here on.
 */
export async function rehydrateStoredMedia(
  messages: ModelMessage[],
  agentConfig: AgentConfig,
): Promise<ModelMessage[]> {
  // File parts count as well as references: a part stored under one provider is
  // replayed under whichever provider the agent runs on now, and the one that
  // has to be demoted carries no reference at all.
  const carriesMedia = messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) => part.type === "file" || mediaReferenceOf(part) !== null,
      ),
  );
  if (!carriesMedia) {
    return messages;
  }

  return await Promise.all(
    messages.map((message) => rehydrateMessage(message, agentConfig)),
  );
}

/**
 * The media type to trust for these bytes.
 * The bytes win over the provider's claim — Telegram calls every photo a JPEG
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

function assertWithinLimit(size: number, mediaType: string | null): void {
  const limit = limitForMediaType(mediaType ?? undefined);
  if (size > limit) {
    throw new Error(`file is larger than ${formatBytes(limit)}`);
  }
}

// Bytes for a reference, if this pod still holds them. Re-inserting on a hit
// keeps the Map in least-recently-used order, which is the order eviction wants.
function cachedMedia(reference: string): Buffer | undefined {
  const bytes = mediaCache.get(reference);
  if (!bytes) {
    return undefined;
  }
  mediaCache.delete(reference);
  mediaCache.set(reference, bytes);

  return bytes;
}

// Keeps bytes for the next turn that replays this message, evicting the least
// recently used until the cache is back under its ceiling.
function cacheMedia(reference: string, bytes: Buffer): void {
  if (bytes.byteLength > MEDIA_CACHE_MAX_BYTES) {
    return;
  }
  mediaCache.delete(reference);
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

// The line the agent reads: what arrived, where it landed, and what to do with
// the parts the model cannot see for itself. The "read it yourself" wording is
// deliberate — told only that a file exists, models ask the sender to paste it.
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

// Where the agent goes to open this attachment, or why it cannot.
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

// What the audio said, or what to do about not knowing. Telling the agent
// whether a retry can work is the point: without it, it either asks the sender
// to repeat themselves when a second attempt would have worked, or burns a turn
// on a provider that has no speech-to-text to try.
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

  return transcript.retryable
    ? `\n  Not transcribed: ${transcript.reason}. Read the file to try again before you answer.`
    : `\n  Not transcribed: ${transcript.reason}. Reading it again will not help; ask what was said.`;
}

/**
 * The provider's own fetch, for an attachment named only by URL. The URL is not
 * trusted input: `zalo-channel` and `pancake-channel` both take it straight out
 * of the inbound webhook body, so whoever posts to the webhook picks the host.
 * Protocol alone is not the boundary, because a public name can resolve to a
 * private address — and a name that resolves publicly once can resolve privately
 * a moment later. `guardedFetch` closes both: it refuses private and metadata
 * addresses on the original URL and on every redirect hop, and it opens the
 * socket to the exact address it validated, so a DNS answer that changes
 * between lookup and connect changes nothing. The body is counted as it
 * arrives, so a missing or lying Content-Length cannot be used to exhaust the
 * pod, ten attachments at a time.
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

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function limitForMediaType(mediaType: string | undefined): number {
  return mediaType?.startsWith("image/")
    ? MAX_IMAGE_BYTES
    : MAX_ATTACHMENT_BYTES;
}

// A name to store the file under. A provider that sends none — Telegram photos
// and voice notes both arrive nameless — would otherwise land extensionless,
// and every client, and the media route, would treat it as a raw download.
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

// The reference a part carries, when it carries one. Only a plain string is
// ever ours: everything this module writes into a stored row is written here.
function mediaReferenceOf(part: UserContentPart): MediaReference | null {
  if (part.type === "image") {
    return parseMediaReference(part.image);
  }
  if (part.type === "file") {
    return parseMediaReference(part.data);
  }

  return null;
}

// How to ask this channel for these bytes again. The chat SDK already names
// what each provider needs in `fetchMetadata` — a Telegram file id, a Slack
// private URL — so that map is carried verbatim rather than re-derived, and a
// provider that names nothing but a URL falls back to it.
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

// A workspace path an agent can read back, and a shell will not fight over.
// The hash keeps two messages that both carry `image.jpg` apart without making
// the name unreadable.
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

// The part the model actually receives. Pictures go over as pictures; anything
// else only when this provider reads it, because a part a provider refuses
// fails the whole turn while a file it never saw costs one `read`.
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

// The reference a stored part points at, or null for anything else — bytes, a
// sealed workspace link, an ordinary URL the model provider reads for itself.
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

// One stored message with its references read back. A reference the channel
// will not serve becomes text in the same position, so the turn still says a
// file was there and the model stops waiting to be shown it.
async function rehydrateMessage(
  message: ModelMessage,
  agentConfig: AgentConfig,
): Promise<ModelMessage> {
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
        !acceptsNativeMedia(provider, part.mediaType)
      ) {
        return {
          type: "text",
          text: unreadableMediaNote(part.filename, part.mediaType),
        };
      }
      const reference = mediaReferenceOf(part);
      if (!reference) {
        return part;
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

// The bytes behind one reference, read through the channel that delivered it so
// the provider's own credentials are used. Null rather than a throw: this runs
// while a turn is being assembled, and one unreadable picture must not take the
// conversation with it.
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

// Read the bytes, put them in the workspace, and seal the link. Every failure
// is caught and described rather than thrown: the caller's contract is that one
// unreadable picture costs a line of text, not the message.
async function storeAttachment(
  attachment: Attachment,
  index: number,
  context: InboundMediaContext,
): Promise<StoredAttachment> {
  const claimed = attachment.mimeType;
  const fallbackName = attachment.name ?? `${attachment.type}-${index + 1}`;
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
    };
  }
}

// Audio the model cannot hear for itself, read into words. Skipped where the
// provider takes the recording natively, since listening to it beats a
// transcript of it.
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

  return await transcribeAudio(agentConfig, bytes);
}

// Straight to S3 rather than through the sandbox: a read-only workspace has no
// sandbox to write through, and a picture does not deserve a VM boot. The mount
// credentials already carry PutObject, which is what makes this the same write
// the sandbox would have performed.
//
// The link is what the model reads, so a deployment with no public base URL
// stores the file and returns nothing: the agent can still open it, and no part
// is built around a URL that would resolve nowhere.
async function writeMediaObject(
  workspace: ResolvedWorkspace,
  accountId: string,
  path: string,
  bytes: Buffer,
  mediaType: string,
): Promise<string | undefined> {
  const target = await resolveS3ReadTarget(
    workspaceReadContext(workspace.config.storage, workspace.namespace),
  );
  await writeS3Object(target.bucket, `${target.prefix}${path}`, bytes, {
    contentType: mediaType,
  });
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) {
    return undefined;
  }
  const token = sealMediaTicket(
    {
      accountId: accountId,
      workspaceId: workspace.workspaceId,
      namespace: workspace.namespace,
      path: path,
    },
    requireEnv("SERVICE_AUTH_SECRET"),
  );

  return `${baseUrl}${MEDIA_PATH_PREFIX}${token}`;
}

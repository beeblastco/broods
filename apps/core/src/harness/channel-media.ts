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
 */

import { detectMediaType, mediaTypeToExtension } from "@ai-sdk/provider-utils";
import type { UserContent } from "ai";
import type { Attachment } from "chat";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import { getHarnessPublicUrl, requireEnv } from "../shared/env.ts";
import {
  isDeniedAddress,
  REDIRECT_LIMIT,
} from "./isolate/runner/pinned-fetch.mjs";
import { logWarn } from "../shared/log.ts";
import { MEDIA_PATH_PREFIX, sealMediaTicket } from "../shared/media-ticket.ts";
import { writeS3Object } from "../shared/s3.ts";
import type { ResolvedWorkspace } from "../shared/workspaces.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";

/** Where an inbound attachment lands, relative to the workspace root. */
const INBOX_DIRECTORY = ".inbox";

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
 * What each provider reads as a native prompt part beyond pictures.
 * A floor, not a ceiling: a media type missing here is not rejected, it is
 * delivered as a workspace file instead of as a part the provider would refuse.
 * Guessing upward is the expensive direction — an unsupported part fails the
 * whole turn, while an under-claimed one costs the agent one `read` call.
 */
const PROVIDER_NATIVE_MEDIA: Partial<
  Record<AccountModelProviderName, ReadonlySet<string>>
> = {
  anthropic: new Set(["application/pdf"]),
  azure: new Set(["application/pdf", "audio"]),
  bedrock: new Set(["application/pdf"]),
  google: new Set(["application/pdf", "audio", "video"]),
  openai: new Set(["application/pdf", "audio"]),
  vertex: new Set(["application/pdf", "audio", "video"]),
};

type UserContentPart = Exclude<UserContent, string>[number];

/**
 * The two halves of an ingested message, split by what may be persisted.
 * Durable parts are sealed links and text — safe in the queue and the stored
 * conversation. Transient parts carry raw bytes for an agent with no workspace:
 * the live turn sees them, but they must never be written into a queued or
 * stored record, where a 6 MB picture becomes an 8 MB JSON row.
 */
export interface IngestedMediaParts {
  durable: UserContentPart[];
  transient: UserContentPart[];
}

export interface InboundMediaContext {
  accountId?: string;
  /** Names the channel in the note the agent reads, and in the logs. */
  channelName: string;
  /** Scopes the inbox folder so two messages cannot overwrite each other. */
  eventId: string;
  /** Decides which media types go over as native parts. */
  provider?: AccountModelProviderName;
  /** Where the bytes are stored. Without one, only the current turn sees them. */
  workspace?: ResolvedWorkspace;
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
    return { durable: [], transient: [] };
  }
  const accepted = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const overflow = attachments.length - accepted.length;
  const stored = await Promise.all(
    accepted.map((attachment, index): Promise<StoredAttachment> =>
      storeAttachment(attachment, index, context),
    ),
  );

  const durable: UserContentPart[] = [];
  const transient: UserContentPart[] = [];
  for (const item of stored) {
    const part = nativePart(item, context.provider);
    if (part) {
      (item.url ? durable : transient).push(part);
    }
  }
  const note = attachmentNote(stored, overflow, context.channelName);
  if (note) {
    durable.push({ type: "text", text: note });
  }

  return { durable: durable, transient: transient };
}

/**
 * The bytes behind one attachment, however this provider carries them.
 * Telegram never sets a URL and signs its download with the bot token; Slack
 * needs a bearer header on a private file. Both hand that over as `fetchData`,
 * so the reader the adapter built is always preferred to the raw URL.
 */
export async function readAttachmentBytes(
  attachment: Attachment,
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

  return await fetchAttachmentUrl(attachment.url);
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

// One attachment after ingestion, in either of the two states that matter: it
// reached the workspace, or it did not and the agent is told why.
interface StoredAttachment {
  name: string;
  mediaType: string;
  /** The bytes themselves, kept only when no durable link exists to hand over. */
  data?: Buffer;
  /** Set once the bytes are in the workspace. */
  path?: string;
  /** The sealed link the model is handed. Absent when there is no workspace. */
  url?: string;
  /** Why the bytes are not available, for the note the agent reads. */
  failure?: string;
}

// The line the agent reads: what arrived, where it landed, and what to do with
// the parts the model cannot see for itself. The "read it yourself" wording is
// deliberate — told only that a file exists, models ask the sender to paste it.
function attachmentNote(
  stored: StoredAttachment[],
  overflow: number,
  channelName: string,
): string | null {
  const lines = stored.map((item): string => {
    if (item.failure) {
      return `- ${item.name} (${item.mediaType}) could not be read: ${item.failure}`;
    }
    if (!item.path) {
      return `- ${item.name} (${item.mediaType}) is available for this message only; no workspace is attached to store it.`;
    }

    return `- ${item.name} (${item.mediaType}) saved to ${item.path}`;
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
 * The host to fetch an attachment from, once it is known to resolve somewhere
 * public. The URL is not trusted input: `zalo-channel` and `pancake-channel`
 * both take it straight out of the inbound webhook body, so whoever posts to the
 * webhook picks the host. Protocol alone is not the boundary, because a public
 * name can resolve to a private address.
 *
 * `fetch` resolves the name again when it opens the socket, so this narrows the
 * attack to a DNS rebind between the two lookups rather than closing it. Pinning
 * the socket the way `guardedFetch` does would close it, at the cost of the
 * binary body this path exists to carry: that helper reads every response as
 * text.
 */
async function allowedAttachmentUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing to fetch an attachment over ${url.protocol}`);
  }
  const addresses = await lookup(url.hostname, {
    all: true,
    verbatim: false,
  });
  if (addresses.length === 0) {
    throw new Error(`attachment host ${url.hostname} did not resolve`);
  }
  for (const address of addresses) {
    if (isDeniedAddress(address.address)) {
      throw new Error(
        `refusing to fetch an attachment from ${url.hostname}: private or metadata address`,
      );
    }
  }

  return url;
}

// The provider's own fetch, for an attachment named only by URL. Redirects are
// followed by hand so every hop is checked, not just the first: `redirect:
// "follow"` would let one 302 carry this to the metadata endpoint past a guard
// that only ever saw the original host. Bounded so a lying Content-Length cannot
// be used to exhaust the pod.
async function fetchAttachmentUrl(raw: string): Promise<Buffer> {
  let url = await allowedAttachmentUrl(raw);
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS),
    });
    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;
    if (location) {
      url = await allowedAttachmentUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`provider answered ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `file is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assertWithinLimit(bytes.byteLength, response.headers.get("content-type"));

    return bytes;
  }

  throw new Error(`attachment redirected more than ${REDIRECT_LIMIT} times`);
}

function assertWithinLimit(size: number, mediaType: string | null): void {
  const limit = limitForMediaType(mediaType ?? undefined);
  if (size > limit) {
    throw new Error(`file is larger than ${formatBytes(limit)}`);
  }
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// A workspace path an agent can read back, and a shell will not fight over.
// The hash keeps two messages that both carry `image.jpg` apart without making
// the name unreadable.
function inboxPath(name: string, eventId: string, index: number): string {
  const folder = createHash("sha256")
    .update(eventId)
    .digest("hex")
    .slice(0, 12);
  const safeName = name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${INBOX_DIRECTORY}/${folder}/${index}-${safeName || "attachment"}`;
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

// The part the model actually receives. Pictures go over as pictures; anything
// else only when this provider reads it, because a part a provider refuses
// fails the whole turn while a file it never saw costs one `read`.
function nativePart(
  item: StoredAttachment,
  provider: AccountModelProviderName | undefined,
): UserContentPart | null {
  const source = item.url ?? item.data;
  if (!source) {
    return null;
  }
  if (item.mediaType.startsWith("image/")) {
    return { type: "image", image: source, mediaType: item.mediaType };
  }
  const native = provider ? PROVIDER_NATIVE_MEDIA[provider] : undefined;
  const topLevel = item.mediaType.split("/")[0] ?? "";
  if (!native?.has(item.mediaType) && !native?.has(topLevel)) {
    return null;
  }

  return {
    type: "file",
    data: source,
    mediaType: item.mediaType,
    filename: item.name,
  };
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
    const workspace = context.workspace;
    // Without a durable link the bytes ride along for the current turn only —
    // persistence drops them, which is exactly the documented behaviour.
    if (!workspace || !context.accountId) {
      return { name: name, mediaType: mediaType, data: bytes };
    }
    const path = inboxPath(name, context.eventId, index);
    const url = await writeInboxObject(
      workspace,
      context.accountId,
      path,
      bytes,
      mediaType,
    );

    return {
      name: name,
      mediaType: mediaType,
      path: path,
      ...(url ? { url: url } : { data: bytes }),
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

// Straight to S3 rather than through the sandbox: a read-only workspace has no
// sandbox to write through, and a picture does not deserve a VM boot. The mount
// credentials already carry PutObject, which is what makes this the same write
// the sandbox would have performed.
//
// The link is what the model reads, so a deployment with no public base URL
// stores the file and returns nothing: the agent can still open it, and no part
// is built around a URL that would resolve nowhere.
async function writeInboxObject(
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

/**
 * Matrix channel adapter.
 *
 * Matrix delivers nothing over a webhook, so `apps/matrix-forwarder` holds a
 * `/sync` long-poll per account, decrypts what arrives and POSTs each room
 * message here. The forwarder also holds the account's end-to-end encryption
 * keys, which is why every event sent into a room goes back through it.
 * Media never does: an attachment's key rides the decrypted event, so this
 * module downloads, decrypts, encrypts and uploads files against the
 * homeserver itself.
 *
 * The wire shapes shared with the forwarder live in `matrix-wire.ts`.
 */

import { createHash } from "node:crypto";
import type { Attachment } from "chat";
import { matrixWebhook, parseChannelWebhook } from "./channel-webhook.ts";
import { timingSafeStringEqual } from "./auth.ts";
import {
  channelAttachmentBytes,
  channelAttachmentName,
  isAllowedId,
  type ChannelActions,
  type ChannelAdapter,
  type ChannelFile,
  type ChannelImage,
  type ChannelParseResult,
} from "./channels.ts";
import { parseCommand } from "./commands.ts";
import { logDebug, logWarn } from "./log.ts";
import {
  MATRIX_ACCESS_TOKEN_HEADER,
  MATRIX_BOT_MARKER,
  type MatrixForwardedEvent,
  type MatrixSendRequest,
  type MatrixTypingRequest,
} from "./matrix-wire.ts";
import { contentTypeForPath } from "./media-types.ts";
import {
  CHANNEL_THREAD_SEPARATOR,
  MATRIX_INTEGRATION_PREFIX,
} from "./runtime-keys.ts";

const DEFAULT_REACTION = "👀";
/** Read by `createMatrixChannelFromConfig`, never by the adapter itself. */
export const MATRIX_FORWARDER_URL_ENV = "MATRIX_FORWARDER_URL";
const MATRIX_REQUEST_TIMEOUT_MS = 30_000;
const MEDIA_MSGTYPES: Record<string, Attachment["type"]> = {
  "m.audio": "audio",
  "m.file": "file",
  "m.image": "image",
  "m.video": "video",
};
const TEXT_MSGTYPES = new Set(["m.emote", "m.text"]);
/** Stops renewing a run that never replies, so its timer cannot outlive it. */
const TYPING_CEILING_MS = 10 * 60_000;
/** Shorter than the timeout the forwarder asks the homeserver for. */
const TYPING_REFRESH_MS = 20_000;

/** The `file` object of an encrypted attachment (spec: EncryptedFile). */
interface EncryptedFile {
  hashes: { sha256: string };
  iv: string;
  key: {
    alg: "A256CTR";
    ext: true;
    k: string;
    key_ops: ["encrypt", "decrypt"];
    kty: "oct";
  };
  url: string;
  v: "v2";
}

/** Where the account lives, and how core reaches the forwarder that holds it. */
export interface MatrixConnection {
  accessToken: string;
  apiUrl: string;
  botName?: string;
  /** `MATRIX_FORWARDER_URL`, resolved once by the caller. */
  forwarderUrl: string;
}

export interface MatrixChannelOptions extends MatrixConnection {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  mentionText?: string;
}

/** Where a reply goes: the room, and the thread when the message was in one. */
export interface MatrixSource {
  encrypted: boolean;
  messageId: string;
  roomId: string;
  threadRootId?: string;
  userId: string;
}

// Strings only: `fetchMetadata` is persisted into a `broods-media:` reference.
interface MediaLocation {
  iv?: string;
  key?: string;
  mxcUrl: string;
  sha256?: string;
}

/** A typing notice this process is renewing, and what it needs to keep or stop it. */
interface TypingNotice {
  deadlineMs: number;
  key: string;
  /** The refresh in flight, so a clear cannot overtake it on the wire. */
  pending: Promise<void> | null;
  roomId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Every room this process is currently showing as typing in, keyed by the
 * account and room the notice belongs to. Process-wide because the notice is
 * server-side state on that pair, and the reply that clears it often comes
 * through a different `ChannelActions` object than the one that set it: a
 * message that arrives mid-run is drained with actions built from its own
 * reply source (`handler.ts` `channelFactory`).
 */
const TYPING_NOTICES = new Map<string, TypingNotice>();

export function createMatrixActions(
  connection: MatrixConnection,
  source: MatrixSource,
): ChannelActions {
  const sendMedia = async function (
    attachments: ChannelFile[] | ChannelImage[],
    caption?: string,
  ): Promise<void> {
    clearTyping(connection, source.roomId);
    if (caption) {
      await sendMessage(
        connection,
        source,
        formatReply(caption, connection, source),
      );
    }
    for (const attachment of attachments) {
      const name = channelAttachmentName(attachment);
      const bytes = await channelAttachmentBytes(attachment);
      const mimeType = attachment.mimeType ?? contentTypeForPath(name);
      const media = source.encrypted
        ? { file: await uploadEncrypted(connection, name, bytes) }
        : { url: await uploadMedia(connection, name, bytes, mimeType) };
      await sendMessage(connection, source, {
        ...media,
        body: name,
        filename: name,
        info: { mimetype: mimeType, size: bytes.byteLength },
        "m.relates_to": replyRelation(source),
        msgtype: attachment.type === "image" ? "m.image" : "m.file",
        [MATRIX_BOT_MARKER]: true,
      });
    }
  };

  return {
    sendFiles: sendMedia,
    sendImages: sendMedia,

    sendText: async function (text): Promise<void> {
      clearTyping(connection, source.roomId);
      await sendMessage(
        connection,
        source,
        formatReply(text, connection, source),
      );
    },

    sendTyping: async function (): Promise<void> {
      await startTyping(connection, source.roomId);
    },

    supportsReactions: true,
    reactToMessage: async function (emoji): Promise<void> {
      const request: MatrixSendRequest = {
        content: {
          "m.relates_to": {
            event_id: source.messageId,
            key: emoji ?? DEFAULT_REACTION,
            rel_type: "m.annotation",
          },
          [MATRIX_BOT_MARKER]: true,
        },
        roomId: source.roomId,
        type: "m.reaction",
      };
      await callForwarder(connection, "/v1/send", request);
    },
  };
}

export function createMatrixChannel(
  options: MatrixChannelOptions,
): ChannelAdapter {
  return {
    name: "matrix",

    rehydrateAttachment: function (attachment): Attachment {
      const location = attachment.fetchMetadata as MediaLocation | undefined;
      if (!location?.mxcUrl) {
        return attachment;
      }

      return {
        ...attachment,
        fetchData: (): Promise<Buffer> => downloadMedia(options, location),
      };
    },

    canHandle: function (req): boolean {
      return req.method === "POST" && MATRIX_ACCESS_TOKEN_HEADER in req.headers;
    },

    authenticate: function (req): boolean {
      const token = req.headers[MATRIX_ACCESS_TOKEN_HEADER];

      return (
        token !== undefined && timingSafeStringEqual(token, options.accessToken)
      );
    },

    parse: function (req): ChannelParseResult {
      const payload = parseChannelWebhook(req.body, matrixWebhook);
      if (!payload) {
        return { kind: "ignore", reason: "invalid_payload" };
      }
      if (
        payload.type !== "MATRIX_ROOM_EVENT" ||
        payload.event?.type !== "m.room.message"
      ) {
        return ignore("unsupported_event");
      }

      return parseRoomMessage(payload, options);
    },

    actions: function (msg): ChannelActions {
      return createMatrixActions(options, toMatrixSource(msg.source));
    },
  };
}

async function callForwarder(
  connection: MatrixConnection,
  path: "/v1/send" | "/v1/typing",
  body: MatrixSendRequest | MatrixTypingRequest,
): Promise<void> {
  if (!connection.forwarderUrl) {
    throw new Error(
      `${MATRIX_FORWARDER_URL_ENV} is not set, so Matrix replies cannot be sent`,
    );
  }
  const response = await fetch(`${trimSlash(connection.forwarderUrl)}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      [MATRIX_ACCESS_TOKEN_HEADER]: connection.accessToken,
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(MATRIX_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Matrix forwarder ${path} failed (${response.status}): ${await response.text()}`,
    );
  }
}

/**
 * Clears the typing notice beside the reply rather than before it. The notice
 * is an acknowledgement, and a homeserver that stalls on `/v1/typing` must not
 * hold the answer behind it for the request timeout.
 */
function clearTyping(connection: MatrixConnection, roomId: string): void {
  // Safe to drop on the floor: `stopTyping` retires the notice synchronously,
  // logs its own failure, and never rejects.
  void stopTyping(connection, roomId);
}

async function decryptMedia(
  bytes: Buffer,
  location: MediaLocation,
): Promise<Buffer> {
  if (!location.key || !location.iv || !location.sha256) {
    return bytes;
  }
  const digest = await crypto.subtle.digest("SHA-256", view(bytes));
  if (
    Buffer.from(digest).toString("base64").replace(/=+$/, "") !==
    location.sha256.replace(/=+$/, "")
  ) {
    throw new Error("Matrix attachment failed its integrity check");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      alg: "A256CTR",
      ext: true,
      k: location.key,
      key_ops: ["decrypt"],
      kty: "oct",
    },
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      counter: view(Buffer.from(location.iv, "base64")),
      length: 64,
      name: "AES-CTR",
    },
    key,
    view(bytes),
  );

  return Buffer.from(plaintext);
}

async function downloadMedia(
  connection: MatrixConnection,
  location: MediaLocation,
): Promise<Buffer> {
  const mxc = /^mxc:\/\/([^/]+)\/(.+)$/.exec(location.mxcUrl);
  if (!mxc) {
    throw new Error(`Not a Matrix media URL: ${location.mxcUrl}`);
  }
  const [, serverName, mediaId] = mxc;
  const response = await fetch(
    `${trimSlash(connection.apiUrl)}/_matrix/client/v1/media/download/${encodeURIComponent(serverName!)}/${encodeURIComponent(mediaId!)}`,
    {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(MATRIX_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`Matrix media download failed (${response.status})`);
  }

  return await decryptMedia(
    Buffer.from(await response.arrayBuffer()),
    location,
  );
}

/**
 * Why this event never reaches the agent, or null to keep it. `m.notice` is how
 * other bots talk, and the marker is how this channel's own replies are known:
 * the account sends both the agent's messages and its owner's.
 */
function droppedReason(
  payload: MatrixForwardedEvent,
  options: MatrixChannelOptions,
): string | null {
  const { event, roomId } = payload;
  const content = event.content;
  const msgtype = String(content.msgtype);
  const relation = content["m.relates_to"] as
    | { rel_type?: unknown }
    | undefined;
  if (content[MATRIX_BOT_MARKER] === true || msgtype === "m.notice") {
    return "bot_message";
  }
  if (relation?.rel_type === "m.replace") {
    return "edit";
  }
  if (!TEXT_MSGTYPES.has(msgtype) && !MEDIA_MSGTYPES[msgtype]) {
    return `unsupported_msgtype:${msgtype}`;
  }
  // Debug, unlike the other channels' allow-list misses. A bot is invited to
  // the rooms it serves, so an event from elsewhere means a misconfiguration
  // worth a warning. This account is a person's: it sits in every room they are
  // in and sees every sender there, so a miss here is the steady state, not news.
  if (!isAllowedId(options.allowedChannelIds, roomId)) {
    logDebug("Matrix room not in allow list", { roomId: roomId });

    return "channel_not_allowed";
  }
  if (!isAllowedId(options.allowedUserIds, event.sender)) {
    logDebug("Matrix sender not in allow list", { userId: event.sender });

    return "user_not_allowed";
  }

  return null;
}

// Matrix encrypted attachments: AES-256-CTR, a random 8-byte counter prefix,
// and a SHA-256 of the ciphertext so the receiver can check it first.
async function encryptMedia(
  bytes: Buffer,
): Promise<{ ciphertext: Buffer; file: Omit<EncryptedFile, "url"> }> {
  const key = await crypto.subtle.generateKey(
    { length: 256, name: "AES-CTR" },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = Buffer.from(
    await crypto.subtle.encrypt(
      { counter: iv, length: 64, name: "AES-CTR" },
      key,
      view(bytes),
    ),
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const digest = await crypto.subtle.digest("SHA-256", ciphertext);

  return {
    ciphertext: ciphertext,
    file: {
      hashes: { sha256: unpaddedBase64(Buffer.from(digest)) },
      iv: unpaddedBase64(Buffer.from(iv)),
      key: {
        alg: "A256CTR",
        ext: true,
        k: jwk.k!,
        key_ops: ["encrypt", "decrypt"],
        kty: "oct",
      },
      v: "v2",
    },
  };
}

/**
 * Markdown to a Matrix message. With a bot name the reply carries a per-message
 * profile, and a bold "Name: " fallback that clients supporting profiles hide.
 */
function formatReply(
  markdown: string,
  connection: MatrixConnection,
  source: MatrixSource,
): Record<string, unknown> {
  const html = Bun.markdown.html(markdown, {
    autolinks: true,
    noHtmlBlocks: true,
    noHtmlSpans: true,
    strikethrough: true,
    tables: true,
  });
  const botName = connection.botName;
  const content: Record<string, unknown> = {
    body: botName ? `${botName}: ${markdown}` : markdown,
    format: "org.matrix.custom.html",
    formatted_body: botName
      ? `<strong data-mx-profile-fallback>${Bun.escapeHTML(botName)}: </strong>${html}`
      : html,
    "m.mentions": {},
    "m.relates_to": replyRelation(source),
    // m.text rather than m.notice: clients strip the profile fallback from m.text only.
    msgtype: "m.text",
    [MATRIX_BOT_MARKER]: true,
  };
  if (botName) {
    content["com.beeper.per_message_profile"] = {
      displayname: botName,
      has_fallback: true,
      id: botName.toLowerCase(),
    };
  }

  return content;
}

function ignore(reason: string): ChannelParseResult {
  return {
    kind: "ignore",
    reason: reason,
    response: { statusCode: 200, body: "ok" },
  };
}

function isAddressed(
  body: string,
  content: Record<string, unknown>,
  accountUserId: string,
  mentionText: string | undefined,
): boolean {
  if (mentionText) {
    return mentionPattern(mentionText).test(body);
  }
  const mentions = content["m.mentions"] as { user_ids?: unknown } | undefined;

  return (
    (Array.isArray(mentions?.user_ids) &&
      mentions.user_ids.includes(accountUserId)) ||
    body.includes(accountUserId)
  );
}

/** Media on a message, named and located, with the bytes left for later. */
function mediaAttachment(
  connection: MatrixConnection,
  content: Record<string, unknown>,
): Attachment | null {
  const type = MEDIA_MSGTYPES[String(content.msgtype)];
  const file = content.file as Partial<EncryptedFile> | undefined;
  const mxcUrl = typeof content.url === "string" ? content.url : file?.url;
  if (!type || !mxcUrl) {
    return null;
  }
  const location: MediaLocation = {
    mxcUrl: mxcUrl,
    ...(file?.key?.k && file.iv && file.hashes?.sha256
      ? { iv: file.iv, key: file.key.k, sha256: file.hashes.sha256 }
      : {}),
  };
  const info = content.info as
    | { mimetype?: unknown; size?: unknown }
    | undefined;
  const name =
    typeof content.filename === "string"
      ? content.filename
      : String(content.body ?? "attachment");

  return {
    fetchData: (): Promise<Buffer> => downloadMedia(connection, location),
    fetchMetadata: { ...location },
    name: name,
    type: type,
    url: mxcUrl,
    ...(typeof info?.mimetype === "string" ? { mimeType: info.mimetype } : {}),
    ...(typeof info?.size === "number" ? { size: info.size } : {}),
  };
}

function mentionPattern(mentionText: string): RegExp {
  // Sable turns a typed mention into a pill whose body carries the server too.
  return new RegExp(
    `(^|\\s)${RegExp.escape(mentionText)}(?::[\\w.-]+)?(?![\\w-])`,
    "gi",
  );
}

/**
 * The text a message says, without the quoted reply fallback older clients
 * prepend. A media message's body is its file name unless a separate
 * `filename` makes the body a caption.
 */
function messageText(content: Record<string, unknown>): string {
  const body = typeof content.body === "string" ? content.body : "";
  if (content.msgtype && MEDIA_MSGTYPES[String(content.msgtype)]) {
    return typeof content.filename === "string" && content.filename !== body
      ? body.trim()
      : "";
  }
  const relation = content["m.relates_to"] as
    | { "m.in_reply_to"?: unknown }
    | undefined;
  if (!relation?.["m.in_reply_to"] || !body.startsWith("> ")) {
    return body.trim();
  }
  const lines = body.split("\n");
  const firstReal = lines.findIndex((line): boolean => !line.startsWith(">"));

  return firstReal === -1 ? "" : lines.slice(firstReal).join("\n").trim();
}

function parseRoomMessage(
  payload: MatrixForwardedEvent,
  options: MatrixChannelOptions,
): ChannelParseResult {
  const { event, roomId } = payload;
  const content = event.content;
  const relation = content["m.relates_to"] as
    | { event_id?: unknown; rel_type?: unknown }
    | undefined;
  const dropped = droppedReason(payload, options);
  if (dropped) {
    return ignore(dropped);
  }

  const attachment = mediaAttachment(options, content);
  const body = messageText(content);
  const runAgent = isAddressed(
    body,
    content,
    payload.userId,
    options.mentionText,
  );
  const text =
    runAgent && options.mentionText
      ? body.replace(mentionPattern(options.mentionText), " ").trim()
      : body;
  if (!text && !attachment) {
    return ignore("empty_message");
  }

  const threadRootId =
    relation?.rel_type === "m.thread" && typeof relation.event_id === "string"
      ? relation.event_id
      : undefined;
  const author = payload.senderName ?? event.sender;
  const source: MatrixSource = {
    encrypted: payload.encrypted,
    messageId: event.event_id,
    roomId: roomId,
    userId: event.sender,
    ...(threadRootId ? { threadRootId: threadRootId } : {}),
  };

  return {
    kind: runAgent ? "message" : "context",
    ack: { statusCode: 200, body: "ok" },
    message: {
      eventId: `${MATRIX_INTEGRATION_PREFIX}${event.event_id}`,
      conversationKey: `${MATRIX_INTEGRATION_PREFIX}${roomId}${threadRootId ? `${CHANNEL_THREAD_SEPARATOR}${threadRootId}` : ""}`,
      channelName: "matrix",
      // A command keeps its bare text so the leading token still parses.
      content: [
        {
          type: "text",
          text: !text || parseCommand(text) ? text : `${author}: ${text}`,
        },
      ],
      ...(attachment ? { attachments: [attachment] } : {}),
      identity: {
        channelId: roomId,
        userId: event.sender,
        userName: author,
        ...(threadRootId ? { threadId: threadRootId } : {}),
      },
      // Spread so the typed source reaches a Record<string, unknown> field.
      source: { ...source },
    },
  };
}

/**
 * Schedules the next refresh of `notice`, or retires it once past its ceiling.
 * The homeserver expires a notice after the timeout the forwarder sends, which
 * is far shorter than most runs.
 */
function renewTyping(connection: MatrixConnection, notice: TypingNotice): void {
  // A superseded notice is no longer the map's, so it stops here rather than
  // refreshing a room a newer lifecycle now owns.
  if (TYPING_NOTICES.get(notice.key) !== notice) return;
  if (Date.now() >= notice.deadlineMs) {
    retireTyping(notice);

    return;
  }
  notice.timer = setTimeout((): void => {
    notice.timer = null;
    notice.pending = sendTypingNotice(connection, notice.roomId, true)
      .then((): void => renewTyping(connection, notice))
      .catch((error: unknown): void => {
        // One refusal ends the loop: the notice expires on its own, and a
        // homeserver that refused this call will refuse the next twenty.
        retireTyping(notice);
        logWarn("Matrix typing refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          roomId: notice.roomId,
        });
      });
  }, TYPING_REFRESH_MS);
}

/**
 * Where a reply hangs: inside the thread when the message it answers was in
 * one, otherwise on the message itself.
 */
function replyRelation(source: MatrixSource): Record<string, unknown> {
  if (source.threadRootId === undefined) {
    return { "m.in_reply_to": { event_id: source.messageId } };
  }

  return {
    event_id: source.threadRootId,
    is_falling_back: false,
    "m.in_reply_to": { event_id: source.messageId },
    rel_type: "m.thread",
  };
}

/**
 * Drops `notice` and its timer, unless a newer one has already replaced it in
 * the map: a lifecycle only ever retires itself.
 */
function retireTyping(notice: TypingNotice): void {
  if (notice.timer !== null) {
    clearTimeout(notice.timer);
    notice.timer = null;
  }
  if (TYPING_NOTICES.get(notice.key) === notice) {
    TYPING_NOTICES.delete(notice.key);
  }
}

async function sendMessage(
  connection: MatrixConnection,
  source: MatrixSource,
  content: Record<string, unknown>,
): Promise<void> {
  const request: MatrixSendRequest = {
    content: content,
    roomId: source.roomId,
    type: "m.room.message",
  };
  await callForwarder(connection, "/v1/send", request);
}

async function sendTypingNotice(
  connection: MatrixConnection,
  roomId: string,
  typing: boolean,
): Promise<void> {
  const request: MatrixTypingRequest = { roomId: roomId, typing: typing };
  await callForwarder(connection, "/v1/typing", request);
}

/** Shows the typing notice and renews it until `stopTyping`, or the ceiling. */
async function startTyping(
  connection: MatrixConnection,
  roomId: string,
): Promise<void> {
  const key = typingKey(connection, roomId);
  const superseded = TYPING_NOTICES.get(key);
  if (superseded?.timer != null) clearTimeout(superseded.timer);
  const notice: TypingNotice = {
    deadlineMs: Date.now() + TYPING_CEILING_MS,
    key: key,
    pending: null,
    roomId: roomId,
    timer: null,
  };
  // Registered before the request, not after it: holding the map entry is what
  // marks this lifecycle current, and two messages landing in one room start
  // their notices inside each other's round trip.
  TYPING_NOTICES.set(key, notice);
  try {
    await sendTypingNotice(connection, roomId, true);
  } catch (error) {
    // Nothing to renew: the room was never shown a notice.
    retireTyping(notice);
    throw error;
  }
  renewTyping(connection, notice);
}

/** Clears the notice and stops renewing it. A no-op when none is running. */
async function stopTyping(
  connection: MatrixConnection,
  roomId: string,
): Promise<void> {
  const key = typingKey(connection, roomId);
  const notice = TYPING_NOTICES.get(key);
  if (notice === undefined) return;
  retireTyping(notice);
  // The in-flight refresh first, or the clear races it and the room keeps
  // showing the agent as typing for the rest of the homeserver's timeout.
  await notice.pending;
  // A message that arrived while that refresh settled owns the room now, and
  // clearing here would blank the notice it just set.
  if (TYPING_NOTICES.has(key)) return;
  // Never fails the reply it precedes; a stale notice expires on its own.
  await sendTypingNotice(connection, roomId, false).catch(
    (error: unknown): void => {
      logWarn("Matrix typing clear failed", {
        error: error instanceof Error ? error.message : String(error),
        roomId: roomId,
      });
    },
  );
}

function toMatrixSource(source: Record<string, unknown>): MatrixSource {
  if (
    typeof source.roomId !== "string" ||
    typeof source.messageId !== "string" ||
    typeof source.userId !== "string" ||
    typeof source.encrypted !== "boolean"
  ) {
    throw new Error("Invalid Matrix source payload");
  }

  return {
    encrypted: source.encrypted,
    messageId: source.messageId,
    roomId: source.roomId,
    userId: source.userId,
    ...(typeof source.threadRootId === "string"
      ? { threadRootId: source.threadRootId }
      : {}),
  };
}

/** Both Matrix URLs this module builds are joined onto the homeserver by hand. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * A notice belongs to one account in one room: two agents on different accounts
 * can sit in the same room, and each shows as typing under its own user. The
 * account is named by a hash of its token so no key holds the token itself.
 */
function typingKey(connection: MatrixConnection, roomId: string): string {
  const account = createHash("sha256")
    .update(connection.accessToken)
    .digest("hex");

  return `${account}\u0000${roomId}`;
}

/**
 * A `Buffer` as Web Crypto wants it. `new Uint8Array(buffer)` would copy the
 * whole attachment, twice for an inbound encrypted one, so this views the same
 * bytes instead. The assertion holds because Node never backs a `Buffer` with
 * a `SharedArrayBuffer`, which is the only other member of `ArrayBufferLike`.
 */
function view(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function unpaddedBase64(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "");
}

async function uploadEncrypted(
  connection: MatrixConnection,
  name: string,
  bytes: Buffer,
): Promise<EncryptedFile> {
  const { ciphertext, file } = await encryptMedia(bytes);
  const url = await uploadMedia(
    connection,
    name,
    ciphertext,
    "application/octet-stream",
  );

  return { ...file, url: url };
}

async function uploadMedia(
  connection: MatrixConnection,
  name: string,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  const response = await fetch(
    `${trimSlash(connection.apiUrl)}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
    {
      body: bytes,
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "Content-Type": mimeType,
      },
      method: "POST",
      // The account's token rides this request and an upload never redirects.
      redirect: "error",
      signal: AbortSignal.timeout(MATRIX_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Matrix media upload failed (${response.status}): ${await response.text()}`,
    );
  }
  const { content_uri } = (await response.json()) as { content_uri: string };

  return content_uri;
}

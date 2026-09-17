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

import type { Attachment } from "chat";
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
import { optionalEnv } from "./env.ts";
import { logWarn } from "./log.ts";
import {
  MATRIX_ACCESS_TOKEN_HEADER,
  type MatrixForwardedEvent,
  type MatrixSendRequest,
  type MatrixTypingRequest,
} from "./matrix-wire.ts";
import { contentTypeForPath } from "./media-types.ts";
import { MATRIX_INTEGRATION_PREFIX } from "./runtime-keys.ts";

/**
 * Marks an event this channel sent. The account is usually a person's, so the
 * sender alone cannot tell the agent's replies from its owner's messages.
 */
export const MATRIX_BOT_MARKER = "app.broods.bot";

const DEFAULT_REACTION = "👀";
const FORWARDER_URL_ENV = "MATRIX_FORWARDER_URL";
const MATRIX_REQUEST_TIMEOUT_MS = 30_000;
// Message types that carry media, mapped to the attachment type they become.
const MEDIA_MSGTYPES: Record<string, Attachment["type"]> = {
  "m.audio": "audio",
  "m.file": "file",
  "m.image": "image",
  "m.video": "video",
};
const TEXT_MSGTYPES = new Set(["m.emote", "m.text"]);

/** Where a reply goes: the room, and the thread when the message was in one. */
export interface MatrixSource {
  encrypted: boolean;
  messageId: string;
  roomId: string;
  threadRootId?: string;
  userId: string;
}

export interface MatrixChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  botName?: string;
  mentionText?: string;
}

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

// Strings only: `fetchMetadata` is persisted into a `broods-media:` reference.
interface MediaLocation {
  iv?: string;
  key?: string;
  mxcUrl: string;
  sha256?: string;
}

export function createMatrixActions(
  apiUrl: string,
  accessToken: string,
  source: MatrixSource,
  botName: string | undefined,
): ChannelActions {
  const sendMedia = async function (
    attachments: ChannelFile[] | ChannelImage[],
    caption?: string,
  ): Promise<void> {
    if (caption) {
      await sendMessage(
        accessToken,
        source,
        formatReply(caption, botName, source),
      );
    }
    for (const attachment of attachments) {
      const name = channelAttachmentName(attachment);
      const bytes = await channelAttachmentBytes(attachment);
      const mimeType = attachment.mimeType ?? contentTypeForPath(name);
      const media = source.encrypted
        ? { file: await uploadEncrypted(apiUrl, accessToken, name, bytes) }
        : {
            url: await uploadMedia(apiUrl, accessToken, name, bytes, mimeType),
          };
      await sendMessage(accessToken, source, {
        ...media,
        body: name,
        filename: name,
        info: { mimetype: mimeType, size: bytes.byteLength },
        msgtype: attachment.type === "image" ? "m.image" : "m.file",
        [MATRIX_BOT_MARKER]: true,
        ...(source.threadRootId
          ? { "m.relates_to": threadRelation(source, source.threadRootId) }
          : {}),
      });
    }
  };

  return {
    sendFiles: sendMedia,
    sendImages: sendMedia,

    sendText: async function (text): Promise<void> {
      await sendMessage(
        accessToken,
        source,
        formatReply(text, botName, source),
      );
    },

    sendTyping: async function (): Promise<void> {
      const request: MatrixTypingRequest = {
        roomId: source.roomId,
        typing: true,
      };
      await callForwarder(accessToken, "/v1/typing", request);
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
      await callForwarder(accessToken, "/v1/send", request);
    },
  };
}

export function createMatrixChannel(
  apiUrl: string,
  accessToken: string,
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
        fetchData: (): Promise<Buffer> =>
          downloadMedia(apiUrl, accessToken, location),
      };
    },

    canHandle: function (req): boolean {
      return req.method === "POST" && MATRIX_ACCESS_TOKEN_HEADER in req.headers;
    },

    authenticate: function (req): boolean {
      const token = req.headers[MATRIX_ACCESS_TOKEN_HEADER];

      return token !== undefined && timingSafeStringEqual(token, accessToken);
    },

    parse: function (req): ChannelParseResult {
      const payload = JSON.parse(req.body) as MatrixForwardedEvent;
      if (
        payload.type !== "MATRIX_ROOM_EVENT" ||
        payload.event?.type !== "m.room.message"
      ) {
        return ignore("unsupported_event");
      }

      return parseRoomMessage(apiUrl, accessToken, payload, options);
    },

    actions: function (msg): ChannelActions {
      return createMatrixActions(
        apiUrl,
        accessToken,
        toMatrixSource(msg.source),
        options.botName,
      );
    },
  };
}

async function callForwarder(
  accessToken: string,
  path: "/v1/send" | "/v1/typing",
  body: MatrixSendRequest | MatrixTypingRequest,
): Promise<Response> {
  const baseUrl = optionalEnv(FORWARDER_URL_ENV);
  if (!baseUrl) {
    throw new Error(
      `${FORWARDER_URL_ENV} is not set, so Matrix replies cannot be sent`,
    );
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      [MATRIX_ACCESS_TOKEN_HEADER]: accessToken,
    },
    method: "POST",
    signal: AbortSignal.timeout(MATRIX_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Matrix forwarder ${path} failed (${response.status}): ${await response.text()}`,
    );
  }

  return response;
}

async function decryptMedia(
  bytes: Buffer,
  location: MediaLocation,
): Promise<Buffer> {
  if (!location.key || !location.iv || !location.sha256) {
    return bytes;
  }
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
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
      counter: new Uint8Array(Buffer.from(location.iv, "base64")),
      length: 64,
      name: "AES-CTR",
    },
    key,
    new Uint8Array(bytes),
  );

  return Buffer.from(plaintext);
}

async function downloadMedia(
  apiUrl: string,
  accessToken: string,
  location: MediaLocation,
): Promise<Buffer> {
  const mxc = /^mxc:\/\/([^/]+)\/(.+)$/.exec(location.mxcUrl);
  if (!mxc) {
    throw new Error(`Not a Matrix media URL: ${location.mxcUrl}`);
  }
  const [, serverName, mediaId] = mxc;
  const response = await fetch(
    `${homeserver(apiUrl)}/_matrix/client/v1/media/download/${encodeURIComponent(serverName!)}/${encodeURIComponent(mediaId!)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
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
      new Uint8Array(bytes),
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
  botName: string | undefined,
  source: MatrixSource,
): Record<string, unknown> {
  const html = Bun.markdown.html(markdown, {
    autolinks: true,
    noHtmlBlocks: true,
    noHtmlSpans: true,
    strikethrough: true,
    tables: true,
  });
  const relation = source.threadRootId
    ? threadRelation(source, source.threadRootId)
    : { "m.in_reply_to": { event_id: source.messageId } };
  const content: Record<string, unknown> = {
    body: botName ? `${botName}: ${markdown}` : markdown,
    format: "org.matrix.custom.html",
    formatted_body: botName
      ? `<strong data-mx-profile-fallback>${Bun.escapeHTML(botName)}: </strong>${html}`
      : html,
    "m.mentions": {},
    "m.relates_to": relation,
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
  if (!isAllowedId(options.allowedChannelIds, roomId)) {
    logWarn("Matrix room not in allow list", { roomId: roomId });

    return "channel_not_allowed";
  }
  if (!isAllowedId(options.allowedUserIds, event.sender)) {
    logWarn("Matrix sender not in allow list", { userId: event.sender });

    return "user_not_allowed";
  }

  return null;
}

function homeserver(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
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
  apiUrl: string,
  accessToken: string,
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
    fetchData: (): Promise<Buffer> =>
      downloadMedia(apiUrl, accessToken, location),
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
  apiUrl: string,
  accessToken: string,
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

  const attachment = mediaAttachment(apiUrl, accessToken, content);
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
      conversationKey: `${MATRIX_INTEGRATION_PREFIX}${roomId}${threadRootId ? `:${threadRootId}` : ""}`,
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

async function sendMessage(
  accessToken: string,
  source: MatrixSource,
  content: Record<string, unknown>,
): Promise<void> {
  const request: MatrixSendRequest = {
    content: content,
    roomId: source.roomId,
    type: "m.room.message",
  };
  await callForwarder(accessToken, "/v1/send", request);
}

function threadRelation(
  source: MatrixSource,
  threadRootId: string,
): Record<string, unknown> {
  return {
    event_id: threadRootId,
    is_falling_back: false,
    "m.in_reply_to": { event_id: source.messageId },
    rel_type: "m.thread",
  };
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

function unpaddedBase64(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "");
}

async function uploadEncrypted(
  apiUrl: string,
  accessToken: string,
  name: string,
  bytes: Buffer,
): Promise<EncryptedFile> {
  const { ciphertext, file } = await encryptMedia(bytes);
  const url = await uploadMedia(
    apiUrl,
    accessToken,
    name,
    ciphertext,
    "application/octet-stream",
  );

  return { ...file, url: url };
}

async function uploadMedia(
  apiUrl: string,
  accessToken: string,
  name: string,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  const response = await fetch(
    `${homeserver(apiUrl)}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
    {
      body: bytes,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      method: "POST",
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

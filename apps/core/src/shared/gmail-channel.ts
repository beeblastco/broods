/**
 * Gmail channel adapter, for one mailbox an agent reads and answers. A Gmail
 * watch publishes mailbox changes to a Pub/Sub topic whose push subscription
 * POSTs here with a Google-signed token. A notification only says the mailbox
 * changed, so `parse` lists the inbox mail received since shortly before it was
 * published, and the event claim drops the messages an earlier notification
 * already admitted. Replies are threaded drafts a person sends from Gmail,
 * unless `autoSend` is set. Convex `channel/gmail.ts` keeps the watch alive.
 */

import {
  createGmailDraft,
  createGmailTokenProvider,
  getGmailMessage,
  GmailApiError,
  type GmailApiOptions,
  type GmailContinuation,
  listGmailMessages,
  sendGmailMessage,
} from "@chat-adapter/gmail/api";
import {
  extractGmailContinuation,
  GmailContentError,
  type GmailEmail,
  parseGmailMessage,
} from "@chat-adapter/gmail/format";
import {
  createGmailWebhookVerifier,
  type GmailNotification,
  GmailWebhookError,
  parseGmailNotification,
} from "@chat-adapter/gmail/webhook";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIdentity,
  ChannelParseResult,
  ChannelRequest,
  ParsedChannelMessage,
} from "./channels.ts";
import { isAllowedId } from "./channels.ts";
import { logWarn } from "./log.ts";
import { GMAIL_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// Pub/Sub publishes a moment after Gmail commits the change, so the listing
// starts a little before the publish time.
const LOOKBACK_MS = 10 * 60 * 1000;
// The event claim holds for a day; mail older than that would run again.
const MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;
// A long thread quotes itself; the model needs the new part at the top.
const MAX_TEXT_CHARS = 20_000;
// Token providers cache the access token and verifiers cache Google's keys, so
// one pair is kept per mailbox setup. Adapters are rebuilt per request.
const TRANSPORT_CACHE_MAX = 100;
const transports = new Map<string, GmailTransport>();

const ADDRESS = z.object({ address: z.string(), name: z.string().optional() });
const SOURCE = z.object({
  continuation: z.object({
    mailbox: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    subject: z.string(),
    inReplyTo: z.string(),
    references: z.array(z.string()),
    to: z.array(ADDRESS),
    cc: z.array(ADDRESS).optional(),
  }),
  gmailMessageId: z.string(),
});

export interface GmailChannelOptions {
  /** Mailboxes this agent answers for; the channel's room is its mailbox. */
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  /** The push subscription's token audience; defaults to the webhook URL. */
  audience?: string;
  autoSend: boolean;
  clientId: string;
  clientSecret: string;
  mailbox: string;
  publicBaseUrl?: string;
  refreshToken: string;
  serviceAccountEmail: string;
  subscription: string;
}

export interface GmailSource {
  continuation: GmailContinuation;
  gmailMessageId: string;
}

interface GmailTransport {
  token: () => Promise<string>;
  verifiers: Map<string, (request: Request) => Promise<GmailNotification>>;
}

/**
 * Builds the Gmail adapter from one agent's `config.channels.gmail`.
 * `integrations.ts` calls it per request; only the token and verifiers are reused.
 */
export function createGmailChannel(
  options: GmailChannelOptions,
): ChannelAdapter {
  const mailbox = options.mailbox.toLowerCase();
  const transport = gmailTransport(options);
  const api: GmailApiOptions = { mailbox: mailbox, token: transport.token };

  return {
    name: "gmail",

    canHandle: function (req): boolean {
      return req.method === "POST" && "authorization" in req.headers;
    },

    authenticate: async function (req): Promise<boolean> {
      const audience = options.audience ?? webhookUrl(options, req);
      if (!audience) {
        logWarn(
          "Gmail webhook cannot be verified: set audience or PUBLIC_BASE_URL",
        );

        return false;
      }
      try {
        const notification = await verifier(
          transport,
          options,
          audience,
        )(
          new Request(`https://core.invalid${req.rawPath}`, {
            method: "POST",
            headers: { authorization: req.headers.authorization ?? "" },
            body: req.body,
          }),
        );
        if (notification.emailAddress.toLowerCase() !== mailbox) {
          logWarn("Gmail notification names another mailbox", {
            emailAddress: notification.emailAddress,
          });

          return false;
        }

        return true;
      } catch (error) {
        if (!(error instanceof GmailWebhookError)) throw error;
        logWarn("Gmail webhook token verification failed", {
          status: error.status,
          reason: error.message,
        });

        return false;
      }
    },

    parse: async function (req): Promise<ChannelParseResult> {
      if (!isAllowedId(options.allowedChannelIds, mailbox)) {
        logWarn("Gmail mailbox not in allow list", { mailbox: mailbox });

        return { kind: "ignore", reason: "not allowed" };
      }
      const notification = parseGmailNotification(req.body);
      const publishedAt = Date.parse(
        notification.envelope.message.publishTime ?? "",
      );
      const now = Date.now();
      const since = Math.max(
        (Number.isNaN(publishedAt) ? now : publishedAt) - LOOKBACK_MS,
        now - MAX_LOOKBACK_MS,
      );
      try {
        const listing = await listGmailMessages(
          {
            q: `in:inbox -from:me after:${Math.floor(since / 1000)}`,
            maxResults: MAX_MESSAGES,
          },
          api,
        );
        const results: ParsedChannelMessage[] = [];
        // Gmail lists newest first; turns run in arrival order.
        for (const pointer of listing.messages.toReversed()) {
          const result = await toMessageResult(
            pointer.id,
            mailbox,
            options,
            api,
          );
          if (result) results.push(result);
        }

        return results.length > 0
          ? { kind: "batch", results: results }
          : { kind: "ignore", reason: "no new mail" };
      } catch (error) {
        // Pub/Sub redelivers anything but a 2xx. A revoked grant or a missing
        // scope fails the same way every time, so it is acknowledged and logged.
        if (
          error instanceof GmailApiError &&
          error.status < 500 &&
          error.status !== 429
        ) {
          logWarn("Gmail mailbox could not be read", {
            status: error.status,
            reason: error.reason,
          });

          return { kind: "ignore", reason: "mailbox unreadable" };
        }
        throw error;
      }
    },

    actions: function (msg): ChannelActions {
      const source = SOURCE.parse(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          const reply = { continuation: source.continuation, text: text };
          if (options.autoSend) {
            await sendGmailMessage(reply, api);
          } else {
            await createGmailDraft(reply, api);
          }
        },
        // Email has neither a typing indicator nor reactions.
        sendTyping: async function (): Promise<void> {
          return;
        },
        reactToMessage: async function (): Promise<void> {
          return;
        },
      };
    },
  };
}

// The text a turn starts from: who wrote, about what, then the body.
function emailText(email: GmailEmail): string {
  const from = email.email.from;
  const sender = from?.address
    ? from.name
      ? `${from.name} <${from.address}>`
      : from.address
    : "unknown sender";
  const body =
    email.text.length > MAX_TEXT_CHARS
      ? `${email.text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated ${email.text.length - MAX_TEXT_CHARS} chars]`
      : email.text;
  const attachments =
    email.attachments.length > 0
      ? `\n\n[${email.attachments.length} attachment(s) not shown]`
      : "";

  return `From: ${sender}\nSubject: ${email.email.subject ?? ""}\nDate: ${email.email.date ?? ""}\n\n${body}${attachments}`;
}

// One token provider and the verifiers built for it, least recently used
// dropped past the cap. The key hashes the OAuth client and grant.
function gmailTransport(options: GmailChannelOptions): GmailTransport {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        options.clientId,
        options.clientSecret,
        options.refreshToken,
      ]),
    )
    .digest("hex");
  const cached = transports.get(key);
  if (cached) {
    transports.delete(key);
    transports.set(key, cached);

    return cached;
  }
  const transport: GmailTransport = {
    token: createGmailTokenProvider({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken,
    }),
    verifiers: new Map(),
  };
  transports.set(key, transport);
  if (transports.size > TRANSPORT_CACHE_MAX) {
    const oldest = transports.keys().next().value;
    if (oldest !== undefined) {
      transports.delete(oldest);
    }
  }

  return transport;
}

// Reads one listed message into a turn, or null when it is not one to answer:
// unparseable, sent by the mailbox itself, or from a sender off the allow list.
async function toMessageResult(
  id: string,
  mailbox: string,
  options: GmailChannelOptions,
  api: GmailApiOptions,
): Promise<ParsedChannelMessage | null> {
  let email: GmailEmail;
  try {
    email = await parseGmailMessage(await getGmailMessage(id, api));
  } catch (error) {
    if (!(error instanceof GmailContentError)) throw error;
    logWarn("Gmail message skipped", { messageId: id, reason: error.reason });

    return null;
  }
  const sender = email.email.from?.address?.toLowerCase();
  if (!sender || sender === mailbox) {
    return null;
  }
  if (!isAllowedId(options.allowedUserIds, sender)) {
    logWarn("Gmail sender not in allow list", { sender: sender });

    return null;
  }
  const threadId = email.message.threadId;
  const identity: ChannelIdentity = {
    channelId: mailbox,
    threadId: threadId,
    userId: sender,
    ...(email.email.from?.name ? { userName: email.email.from.name } : {}),
  };
  const source: GmailSource = {
    continuation: extractGmailContinuation(email, mailbox),
    gmailMessageId: email.message.id,
  };

  return {
    kind: "message",
    message: {
      eventId: `${GMAIL_INTEGRATION_PREFIX}${email.message.id}`,
      conversationKey: `${GMAIL_INTEGRATION_PREFIX}${mailbox}:${threadId}`,
      channelName: "gmail",
      content: emailText(email),
      identity: identity,
      source: { ...source },
    },
  };
}

// One verifier per audience, so a stage URL and the production URL each verify.
function verifier(
  transport: GmailTransport,
  options: GmailChannelOptions,
  audience: string,
): (request: Request) => Promise<GmailNotification> {
  const key = JSON.stringify([
    audience,
    options.serviceAccountEmail,
    options.subscription,
  ]);
  const cached = transport.verifiers.get(key);
  if (cached) return cached;
  const created = createGmailWebhookVerifier({
    audience: audience,
    serviceAccountEmail: options.serviceAccountEmail,
    subscription: options.subscription,
  });
  transport.verifiers.set(key, created);

  return created;
}

function webhookUrl(
  options: GmailChannelOptions,
  req: ChannelRequest,
): string | undefined {
  return options.publicBaseUrl
    ? `${options.publicBaseUrl}${req.rawPath}`
    : undefined;
}

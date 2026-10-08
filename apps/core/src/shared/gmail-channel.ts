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
import { z } from "zod";
import { cacheDigest } from "./cache-digest.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIdentity,
  ChannelParseResult,
  ParsedChannelMessage,
} from "./channels.ts";
import { CHANNEL_REACH_WILDCARD, isAllowedId } from "./channels.ts";
import { logWarn } from "./log.ts";
import { GMAIL_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// Pub/Sub publishes a moment after Gmail commits the change, so the listing
// starts a little before the publish time.
const LOOKBACK_MS = 10 * 60 * 1000;
// The event claim holds for a day; mail older than that would run again.
const MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;
// Gmail's own verdict on a received message; it prepends this header itself.
const GMAIL_AUTHSERV_ID = "mx.google.com";
// A long thread quotes itself; the model needs the new part at the top.
const MAX_TEXT_CHARS = 20_000;
// Token providers cache the access token and verifiers cache Google's keys, so
// one pair is kept per mailbox setup. Adapters are rebuilt per request.
const TRANSPORT_CACHE_MAX = 100;
const transports = new Map<string, GmailTransport>();

// The adapter validates the continuation itself when it composes a reply.
const SOURCE = z.object({
  continuation: z.custom<GmailContinuation>(
    (value) => typeof value === "object" && value !== null,
  ),
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

export type GmailSource = z.infer<typeof SOURCE>;

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
      const audience =
        options.audience ??
        (options.publicBaseUrl && `${options.publicBaseUrl}${req.rawPath}`);
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
            q: `in:inbox -from:me after:${Math.floor(since / 1000)}${senderQuery(options.allowedUserIds)}`,
            maxResults: MAX_MESSAGES,
          },
          api,
        );
        if (listing.nextPageToken) {
          logWarn("Gmail listing cut at its first page", {
            mailbox: mailbox,
            limit: MAX_MESSAGES,
          });
        }
        // Fetched together, so the push is acknowledged inside Pub/Sub's
        // deadline. Gmail lists newest first; turns run in arrival order.
        const fetched = await Promise.all(
          listing.messages
            .toReversed()
            .map((pointer) =>
              toMessageResult(pointer.id, mailbox, options, api),
            ),
        );
        const results = fetched.filter(
          (result): result is ParsedChannelMessage => result !== null,
        );

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
  const key = cacheDigest(
    JSON.stringify([
      options.clientId,
      options.clientSecret,
      options.refreshToken,
    ]),
  );
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

// Whether Gmail authenticated the sender's domain: its own Authentication-Results
// header holds a result that is exactly `dmarc=pass` with `header.from=<domain>`,
// or `dkim=pass` with `header.i=@<domain>`. The first header with Gmail's id is
// Gmail's; a sender can only add ones below it.
function isAuthenticatedSender(email: GmailEmail, sender: string): boolean {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  const verdict = email.email.headers.find(
    (header) =>
      header.key === "authentication-results" &&
      header.value.trim().split(/[\s;]/, 1)[0] === GMAIL_AUTHSERV_ID,
  )?.value;
  if (!verdict) return false;

  return resultTokens(verdict.toLowerCase()).some(
    ([method, ...properties]) =>
      (method === "dmarc=pass" &&
        properties.includes(`header.from=${domain}`)) ||
      (method === "dkim=pass" && properties.includes(`header.i=@${domain}`)),
  );
}

// Whether the allow list names senders, rather than letting anyone in.
function isRestricted(
  allowed: ReadonlySet<string> | null,
): allowed is ReadonlySet<string> {
  return allowed !== null && !allowed.has(CHANNEL_REACH_WILDCARD);
}

// An Authentication-Results value split into its `;` results, each a list of
// whitespace-separated tokens. Comments are dropped and quoted strings kept
// whole, so text a sender controls, like an SPF mail-from, never reads as a
// result of its own.
function resultTokens(value: string): string[][] {
  const results: string[][] = [];
  let result: string[] = [];
  let token = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? "";
    if (quoted) {
      token += char;
      if (char === "\\") token += value[++index] ?? "";
      else if (char === '"') quoted = false;
    } else if (depth > 0) {
      if (char === "\\") index++;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    } else if (char === "(") {
      depth++;
    } else if (char === ";" || /\s/.test(char)) {
      if (token) result.push(token);
      token = "";
      if (char === ";") {
        results.push(result);
        result = [];
      }
    } else {
      quoted = char === '"';
      token += char;
    }
  }
  if (token) result.push(token);
  results.push(result);

  return results;
}

// A search clause that lists only allowed senders' mail, so mail from anyone
// else is never fetched and cannot crowd theirs out of the listing.
function senderQuery(allowed: ReadonlySet<string> | null): string {
  return isRestricted(allowed)
    ? ` {${[...allowed].map((id): string => `from:${id}`).join(" ")}}`
    : "";
}

// Reads one listed message into a turn, or null when it is not one to answer:
// gone or unparseable, sent by the mailbox itself, or from a sender off the
// allow list or one Gmail could not authenticate.
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
    // Deleted between the listing and the read.
    if (error instanceof GmailApiError && error.status === 404) return null;
    if (!(error instanceof GmailContentError)) throw error;
    logWarn("Gmail message skipped", { messageId: id, reason: error.reason });

    return null;
  }
  const from = email.email.from;
  const address = from?.address;
  if (!from || !address) return null;
  const sender = address.toLowerCase();
  if (sender === mailbox) return null;
  if (!isAllowedId(options.allowedUserIds, sender)) {
    logWarn("Gmail sender not in allow list", { sender: sender });

    return null;
  }
  // A From header is forgeable, so an allow list holds only for senders Gmail
  // authenticated.
  if (
    isRestricted(options.allowedUserIds) &&
    !isAuthenticatedSender(email, sender)
  ) {
    logWarn("Gmail sender not authenticated", { sender: sender });

    return null;
  }
  const threadId = email.message.threadId;
  const identity: ChannelIdentity = {
    channelId: mailbox,
    threadId: threadId,
    userId: sender,
    ...(from.name ? { userName: from.name } : {}),
  };
  // Replies go to the sender that was checked, never to a Reply-To.
  const source: GmailSource = {
    continuation: {
      ...extractGmailContinuation(email, mailbox),
      to: [{ address: address, ...(from.name ? { name: from.name } : {}) }],
    },
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

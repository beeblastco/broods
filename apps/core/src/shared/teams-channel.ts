/**
 * Microsoft Teams channel adapter, on the Bot Framework. The Chat SDK adapter
 * is the transport that reads the activity and posts the reply; the inbound
 * token is checked with the Teams SDK's JWT validator, set up for Bot Framework
 * connector tokens only, since the Chat SDK only reaches it through a full
 * `Chat` instance.
 */

import { TeamsAdapter } from "@chat-adapter/teams";
// The validator is not re-exported from the package root.
import { JwtValidator } from "@microsoft/teams.apps/dist/middleware/index.js";
import { ConsoleLogger, type Attachment, type Message } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIdentity,
  ChannelParseResult,
  InboundMessage,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { TEAMS_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// Only the Bot Framework connector signs what a Teams bot receives. The SDK's
// inbound validator also takes Entra tokens, which carry no serviceUrl and
// which any tenant can mint for a multi-tenant app id.
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";
const BEARER_PREFIX = "Bearer ";
// Validators cache Microsoft's signing keys, so one is kept per bot. Adapters
// are rebuilt per request and would otherwise refetch the keys every time.
const TOKEN_VALIDATOR_CACHE_MAX = 100;
const tokenValidators = new Map<string, JwtValidator>();

// The fields of a Bot Framework activity this adapter reads.
interface TeamsActivity {
  channelData?: {
    channel?: { id?: string };
    team?: { id?: string };
    tenant?: { id?: string };
  };
  conversation?: { id?: string; tenantId?: string };
  entities?: {
    mentioned?: { id?: string };
    text?: string;
    type?: string;
  }[];
  from?: { aadObjectId?: string; id?: string; name?: string };
  id?: string;
  recipient?: { id?: string };
  serviceUrl?: string;
  text?: string;
  type?: string;
}

export interface TeamsChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiUrl?: string;
  appId: string;
  appPassword: string;
  appTenantId?: string;
  appType?: "MultiTenant" | "SingleTenant";
  userName?: string;
}

export interface TeamsSource {
  conversationId: string;
  messageId: string;
  threadId: string;
  userId?: string;
  userName?: string;
}

/**
 * Builds the Teams adapter from one agent's `config.channels.teams`.
 * `integrations.ts` calls it per request; only the token validator is shared.
 */
export function createTeamsChannel(
  options: TeamsChannelOptions,
): ChannelAdapter {
  const tenantId =
    options.appType === "MultiTenant" ? undefined : options.appTenantId;
  const transport = new TeamsAdapter({
    apiUrl: options.apiUrl,
    appId: options.appId,
    appPassword: options.appPassword,
    appTenantId: tenantId,
    appType: options.appType,
    logger: new ConsoleLogger("error").child("teams"),
    userName: options.userName,
  });

  return {
    name: "teams",

    rehydrateAttachment: function (attachment) {
      return withGuardedRead(transport.rehydrateAttachment(attachment));
    },

    canHandle: function (req) {
      return req.method === "POST" && "authorization" in req.headers;
    },

    // The token must be signed by the Bot Framework, name this app as its
    // audience, and carry the serviceUrl the activity claims, which is where
    // attachments are read from with the bot's own credentials.
    authenticate: async function (req): Promise<boolean> {
      const header = req.headers.authorization;
      const body = parseChannelWebhookBody<TeamsActivity>("teams", req.body);
      if (
        !header?.startsWith(BEARER_PREFIX) ||
        body.kind === "ignore" ||
        !body.payload.serviceUrl
      ) {
        return false;
      }
      const claims = await tokenValidator(options.appId).validateAccessToken(
        header.slice(BEARER_PREFIX.length),
        { validateServiceUrl: { expectedServiceUrl: body.payload.serviceUrl } },
      );
      if (!claims) {
        logWarn("Teams webhook token verification failed");

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
      const body = parseChannelWebhookBody<TeamsActivity>("teams", req.body);
      if (body.kind === "ignore") {
        return body;
      }
      const activity = body.payload;
      if (activity.type !== "message" || !activity.conversation?.id) {
        return { kind: "ignore", reason: `activity:${activity.type}` };
      }
      if (activity.from?.id && activity.from.id === activity.recipient?.id) {
        return { kind: "ignore", reason: "own message" };
      }
      const identity = teamsIdentity(activity, activity.conversation.id);
      if (
        !isAllowedId(options.allowedChannelIds, identity.channelId) ||
        !isAllowedId(options.allowedUserIds, identity.userId)
      ) {
        logWarn("Teams message not in allow list", {
          channelId: identity.channelId,
          userId: identity.userId,
        });

        return { kind: "ignore", reason: "not allowed" };
      }
      const parsed = transport.parseMessage({
        ...activity,
        text: withoutBotMention(activity),
      });
      if (!parsed.text && parsed.attachments.length === 0) {
        return { kind: "ignore", reason: "empty message" };
      }

      return {
        kind: "message",
        message: toInboundMessage(activity.conversation.id, parsed, identity),
      };
    },

    actions: function (msg): ChannelActions {
      const source = toTeamsSource(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
        },
        sendTyping: function (): Promise<void> {
          return transport.startTyping(source.threadId);
        },
        // Bot reactions are not generally available in Teams, so an accepted
        // message shows typing only.
        reactToMessage: async function (): Promise<void> {
          return;
        },
      };
    },
  };
}

/**
 * Who sent the activity and where. A channel thread is `19:...;messageid=...`
 * and the channel is the part before it; a chat is its own conversation. The
 * Entra object id names a person the same way in every chat, so it is the user
 * id when Teams sends one.
 */
function teamsIdentity(
  activity: TeamsActivity,
  conversationId: string,
): ChannelIdentity & { channelId: string } {
  const userId = activity.from?.aadObjectId ?? activity.from?.id;
  const userName = activity.from?.name;
  const workspaceRef =
    activity.channelData?.team?.id ??
    activity.channelData?.tenant?.id ??
    activity.conversation?.tenantId;

  return {
    channelId:
      activity.channelData?.channel?.id ?? conversationId.split(";")[0]!,
    ...(workspaceRef ? { workspaceRef: workspaceRef } : {}),
    ...(userId ? { userId: userId } : {}),
    ...(userName ? { userName: userName } : {}),
  };
}

// The turn one verified message becomes. Replies go to the conversation the
// message arrived in, which for a channel is the thread.
function toInboundMessage(
  conversationId: string,
  parsed: Message,
  identity: ChannelIdentity,
): InboundMessage {
  const source: TeamsSource = {
    conversationId: conversationId,
    messageId: parsed.id,
    threadId: parsed.threadId,
    ...(identity.userId ? { userId: identity.userId } : {}),
    ...(identity.userName ? { userName: identity.userName } : {}),
  };

  return {
    eventId: `${TEAMS_INTEGRATION_PREFIX}${conversationId}:${parsed.id}`,
    conversationKey: `${TEAMS_INTEGRATION_PREFIX}${conversationId}`,
    channelName: "teams",
    content: parsed.text,
    ...(parsed.attachments.length > 0
      ? { attachments: parsed.attachments.map(withGuardedRead) }
      : {}),
    identity: identity,
    source: { ...source },
  };
}

function toTeamsSource(source: Record<string, unknown>): TeamsSource {
  if (
    typeof source.conversationId !== "string" ||
    typeof source.messageId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Teams source payload");
  }

  return {
    conversationId: source.conversationId,
    messageId: source.messageId,
    threadId: source.threadId,
    ...(typeof source.userId === "string" ? { userId: source.userId } : {}),
    ...(typeof source.userName === "string"
      ? { userName: source.userName }
      : {}),
  };
}

// One validator per bot, oldest dropped past the cap.
function tokenValidator(appId: string): JwtValidator {
  const cached = tokenValidators.get(appId);
  if (cached) {
    return cached;
  }
  const validator = new JwtValidator({
    clientId: appId,
    jwksUriOptions: { type: "uri", uri: BOT_FRAMEWORK_KEYS_URL },
    validateIssuer: { allowedIssuer: BOT_FRAMEWORK_ISSUER },
  });
  tokenValidators.set(appId, validator);
  if (tokenValidators.size > TOKEN_VALIDATOR_CACHE_MAX) {
    const oldest = tokenValidators.keys().next().value;
    if (oldest !== undefined) {
      tokenValidators.delete(oldest);
    }
  }

  return validator;
}

// The SDK reads an attachment off the connector with the bot token, and any
// other URL with a bare fetch. Dropping that reader sends the URL through
// core's guarded read, which refuses private and metadata addresses.
function withGuardedRead(attachment: Attachment): Attachment {
  if (attachment.fetchMetadata?.auth === "bot") {
    return attachment;
  }
  const { fetchData: _unguarded, ...guarded } = attachment;

  return guarded;
}

// In a channel or group chat the message opens with `<at>Bot</at>`, which is
// the address, not the request. Mentions of anyone else stay in the text.
function withoutBotMention(activity: TeamsActivity): string {
  const botId = activity.recipient?.id;

  return (activity.entities ?? [])
    .reduce(
      (text, entity): string =>
        entity.type === "mention" &&
        entity.text &&
        botId &&
        entity.mentioned?.id === botId
          ? text.replace(entity.text, "")
          : text,
      activity.text ?? "",
    )
    .trim();
}

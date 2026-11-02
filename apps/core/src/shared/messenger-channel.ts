import {
  MessengerAdapter,
  type MessengerMessagingEvent,
} from "@chat-adapter/messenger";
import { ConsoleLogger } from "chat";
import type { ChannelAdapter } from "./channels.ts";
import { createMetaChannel, type MetaSource } from "./meta-channel.ts";
import { MESSENGER_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// The Send API caps text at 2000 characters; the margin covers what the SDK's markdown adds.
const MESSENGER_TEXT_LIMIT = 1900;

// A Page access token belongs to one Page for life, so its id is looked up once.
const pageIds = new Map<string, Promise<string>>();

export interface MessengerChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiVersion?: string;
  appSecret: string;
  pageAccessToken: string;
  userName?: string;
  verifyToken: string;
}

export type MessengerSource = MetaSource;

// The SDK learns the Page on `initialize()`, which core never calls: there is no Chat.
class BroodsMessengerAdapter extends MessengerAdapter {
  async pageId(): Promise<string> {
    const page = await this.graphApiFetch<{ id: string }>(
      "me",
      "GET",
      undefined,
      {
        fields: "id",
      },
    );

    return page.id;
  }
}

export function createMessengerChannel(
  options: MessengerChannelOptions,
): ChannelAdapter {
  const transport = new BroodsMessengerAdapter({
    apiVersion: options.apiVersion,
    appSecret: options.appSecret,
    logger: new ConsoleLogger("error").child("messenger"),
    pageAccessToken: options.pageAccessToken,
    userName: options.userName,
    verifyToken: options.verifyToken,
  });

  return createMetaChannel<MessengerMessagingEvent>({
    allowedChannelIds: options.allowedChannelIds,
    allowedUserIds: options.allowedUserIds,
    appSecret: options.appSecret,
    name: "messenger",
    object: "page",
    ownerId: function (): Promise<string> {
      const known = pageIds.get(options.pageAccessToken);
      if (known) return known;
      const lookup = transport.pageId();
      pageIds.set(options.pageAccessToken, lookup);
      lookup.catch((): void => {
        pageIds.delete(options.pageAccessToken);
      });

      return lookup;
    },
    postsAttachments: false,
    prefix: MESSENGER_INTEGRATION_PREFIX,
    textLimit: { max: MESSENGER_TEXT_LIMIT, unit: "chars" },
    transport: transport,
    verifyToken: options.verifyToken,
  });
}

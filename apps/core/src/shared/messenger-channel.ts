/**
 * Facebook Messenger channel adapter, on the Messenger Platform Send API. The
 * Chat SDK adapter reads the message, posts the reply and names the Page its
 * token belongs to; the Meta webhook handshake, signature check and event walk
 * are shared with Instagram in `meta-channel.ts`.
 */

import {
  MessengerAdapter,
  type MessengerMessagingEvent,
} from "@chat-adapter/messenger";
import { ConsoleLogger } from "chat";
import type { ChannelAdapter } from "./channels.ts";
import { createMetaChannel, type MetaSource } from "./meta-channel.ts";
import { MESSENGER_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// The Send API caps a text message at 2000 characters; the margin covers what
// the SDK's markdown rendering adds back.
const MESSENGER_TEXT_LIMIT = 1900;

// Page id per Page access token. A token belongs to one Page for life, and
// core runs one replica, so each is looked up once per pod.
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

// The config names no Page, so ask Graph whose token this is, as the SDK does
// on `initialize()`. Core never initializes the adapter, since there is no Chat.
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

/**
 * Builds the Messenger adapter from one agent's `config.channels.messenger`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
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

  // No sendFiles or sendImages: the SDK's Messenger postMessage sends text
  // and templates only, so `send-files` falls back to download links.
  return createMetaChannel<MessengerMessagingEvent>({
    allowedChannelIds: options.allowedChannelIds,
    allowedUserIds: options.allowedUserIds,
    appSecret: options.appSecret,
    name: "messenger",
    object: "page",
    ownerId: function (): Promise<string> {
      const known = pageIds.get(options.pageAccessToken);
      if (known) return known;
      // A failed lookup is not remembered, so Meta's retry asks again.
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

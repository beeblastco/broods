/**
 * Facebook Messenger channel adapter, on the Messenger Platform Send API. The
 * Chat SDK adapter reads the message and posts the reply; the Meta webhook
 * handshake, signature check and event walk are shared with Instagram in
 * `meta-channel.ts`.
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

/**
 * Builds the Messenger adapter from one agent's `config.channels.messenger`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
export function createMessengerChannel(
  options: MessengerChannelOptions,
): ChannelAdapter {
  const transport = new MessengerAdapter({
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
    postsAttachments: false,
    prefix: MESSENGER_INTEGRATION_PREFIX,
    textLimit: { max: MESSENGER_TEXT_LIMIT, unit: "chars" },
    transport: transport,
    verifyToken: options.verifyToken,
  });
}

/**
 * Instagram DM channel adapter, on the Instagram API with Instagram Login. The
 * Chat SDK adapter reads the message and posts the reply, media included; the
 * Meta webhook handshake, signature check and event walk are shared with
 * Messenger in `meta-channel.ts`.
 */

import {
  InstagramAdapter,
  type InstagramMessagingEvent,
} from "@chat-adapter/instagram";
import { ConsoleLogger } from "chat";
import type { ChannelAdapter } from "./channels.ts";
import { createMetaChannel, type MetaSource } from "./meta-channel.ts";
import { INSTAGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// Instagram caps a text message at 1000 UTF-8 bytes; the margin covers what
// the SDK's plain-text rendering can add back.
const INSTAGRAM_TEXT_LIMIT_BYTES = 950;

export interface InstagramChannelOptions {
  accessToken: string;
  accountId: string;
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiVersion?: string;
  appSecret: string;
  userName?: string;
  verifyToken: string;
}

export type InstagramSource = MetaSource;

/**
 * Builds the Instagram adapter from one agent's `config.channels.instagram`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
export function createInstagramChannel(
  options: InstagramChannelOptions,
): ChannelAdapter {
  const transport = new InstagramAdapter({
    accessToken: options.accessToken,
    accountId: options.accountId,
    apiVersion: options.apiVersion,
    appSecret: options.appSecret,
    logger: new ConsoleLogger("error").child("instagram"),
    userName: options.userName,
    verifyToken: options.verifyToken,
  });

  return createMetaChannel<InstagramMessagingEvent>({
    allowedChannelIds: options.allowedChannelIds,
    allowedUserIds: options.allowedUserIds,
    appSecret: options.appSecret,
    // One Meta app can serve several Instagram accounts under one app secret.
    entryId: options.accountId,
    name: "instagram",
    object: "instagram",
    postsAttachments: true,
    prefix: INSTAGRAM_INTEGRATION_PREFIX,
    textLimit: { max: INSTAGRAM_TEXT_LIMIT_BYTES, unit: "bytes" },
    transport: transport,
    verifyToken: options.verifyToken,
  });
}

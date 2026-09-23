---
title: Zalo
---

# Zalo

The Zalo channel answers private chats and groups through the official Zalo Bot API.

## Setup

1. Create a bot on the Zalo Bot Platform and copy its token. Pick a webhook secret of 8 to 256 characters.
2. Store both:

   ```bash
   broods env set ZALO_BOT_TOKEN
   broods env set ZALO_WEBHOOK_SECRET
   ```

3. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineZaloConnection, env } from "broods";

   export const zalo = defineZaloConnection({
     botToken: env("ZALO_BOT_TOKEN"),
     webhookSecret: env("ZALO_WEBHOOK_SECRET"),
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [zalo],
   });
   ```

   A bot that takes direct messages needs `allowedChannelIds: ["*"]`, because a person's chat id does not exist until they write. Declare groups with `defineZaloChannel` instead when you know their ids.

4. Run `broods dev` or `broods deploy` and register the printed URL:

   ```bash
   curl "https://bot-api.zaloplatforms.com/bot$ZALO_BOT_TOKEN/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "<webhook URL>",
       "secret_token": "<ZALO_WEBHOOK_SECRET>"
     }'
   ```

   The `packages/demos/channel-zalo` demo has a `register` command for this.

Zalo stores one webhook per bot. Registering a stage URL moves all of that bot's traffic to that stage. Give each developer their own bot to run stages side by side.

## Configuration

| Field               | Required | Description                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `botToken`          | yes      | bot token from the Zalo Bot Platform                                    |
| `webhookSecret`     | yes      | sent by Zalo in `X-Bot-Api-Secret-Token`. 8 to 256 characters           |
| `allowedChannelIds` | no       | extra chat ids, or `["*"]` for every chat                               |
| `allowedUserIds`    | no       | Zalo user ids allowed to trigger the agent, in private chats and groups |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                    |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)       |

## Group chats

Group support is an [experiment on the Zalo Bot Platform](https://bot.zapps.me/docs/build-bot-interaction-with-group/) and may not be available for every bot. Check that the Bot Creator shows Invite Bot to Group before debugging your Broods config.

Zalo decides which group messages reach the bot. A member must either pick the bot from the `@` mention picker, or reply to a message the bot sent. Broods runs the agent for both. Typing the bot's name as plain text does nothing.

```ts
export const standup = defineZaloChannel({
  name: "standup",
  connection: zalo,
  chatId: "1234567890",
});
```

Each chat is its own conversation, keyed by chat id, so a group and a private chat with the same person never share history.

`chatId` also accepts a list, which deploys one record per id, such as `internal-7788`:

```ts
export const internal = defineZaloChannel({
  name: "internal",
  connection: zalo,
  chatId: ["7788", "7789", "7790"],
  denyTools: ["web_search"],
});
```

See [Channel records](channel-records.md) for how lists expand.

## What works

- Text in private chats and groups. Replies are split into 2000-character chunks, the Zalo text limit.
- Inbound pictures, stickers and voice notes. Zalo hosts each one, so the agent gets a link, not the bytes. Pictures and stickers arrive as images, voice notes as audio. A caption arrives as the message text.
- The model must accept that input. A picture sent to a text-only model fails the run with the provider's error. `.aac` is the only audio format Zalo uses, so a voice note with any other URL is passed along as a plain link.
- Outbound images through `sendPhoto`. Zalo fetches the picture itself, so it must be a public `http(s)` URL. Local paths, `data:` URLs and private links are rejected. Captions are cut at 2000 characters. Workspace files go out as durable media links.
- Outbound stickers by Zalo sticker id or name.
- Typing indicators.

What does not:

- No inbound documents or video. Zalo sends those as `message.unsupported.received`, which is ignored.
- No document sending. `send-files` posts links as text instead.
- No reactions.
- Bot-originated messages, undeclared chats and senders outside `allowedUserIds` are ignored.

See [Channels](index.md) for commands, channel tools and attachment limits.

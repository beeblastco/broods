---
title: Telegram
---

# Telegram

A Telegram bot puts your agent in private chats, groups and forum topics.

## Setup

1. Create a bot with [BotFather](https://t.me/BotFather) and copy its token.
2. Pick a random webhook secret and store both values:

   ```bash
   broods env set TELEGRAM_BOT_TOKEN
   broods env set TELEGRAM_WEBHOOK_SECRET
   ```

3. Define the connection and the chats it answers in:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineTelegramChannel,
     defineTelegramConnection,
     env,
   } from "broods";

   export const telegram = defineTelegramConnection({
     botToken: env("TELEGRAM_BOT_TOKEN"),
     webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
     botUsername: "my_bot",
   });

   export const ops = defineTelegramChannel({
     name: "ops",
     connection: telegram,
     chatId: "-1001234567",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [telegram],
   });
   ```

4. Run `broods dev` or `broods deploy`. The CLI prints the webhook URL:

   ```text
   Channel telegram (telegram): https://gateway.broods.app/v1/webhooks/acct_.../telegram
   ```

   A non-production stage prints its own URL, `.../v1/webhooks/acct_.../dev/stage_.../telegram`, so its traffic stays separate.

5. Register the URL with Telegram, passing the same secret:

   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=<webhook URL>" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

   Telegram keeps one webhook per bot, so registering a stage URL moves the bot's traffic to that stage.

A direct-message bot cannot know chat ids in advance, because a person's chat only exists once they write. Set `allowedChannelIds: ["*"]` and gate people with `allowedUserIds` instead of declaring channels.

## Configuration

| Field               | Required | Description                                                           |
| ------------------- | -------- | --------------------------------------------------------------------- |
| `botToken`          | yes      | token from BotFather                                                  |
| `webhookSecret`     | yes      | secret Telegram sends with each webhook                               |
| `botUsername`       | no       | the bot's @username. Set it so the agent answers only when addressed  |
| `reactionEmoji`     | no       | reaction on accepted messages. Default `👀`                           |
| `apiUrl`            | no       | Bot API base URL. Must be public `https`                              |
| `allowedChannelIds` | no       | extra chat ids, or `["*"]` for every chat                             |
| `allowedUserIds`    | no       | Telegram user ids allowed to trigger the agent. Everyone when omitted |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                  |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)     |

`apiUrl` is checked when saved. The bot token travels in the URL path, so plain `http`, private-network hosts and redirects are refused.

## When the agent answers

With `botUsername` set, a group message runs the agent only when it:

- mentions `@my_bot`,
- is a slash command, or
- replies to one of the agent's messages.

Other messages in an allowed chat are stored as context, so a later mention still sees what the chat said. A private chat always runs the agent.

Without `botUsername`, Broods cannot recognize a mention and answers every message. Set it as soon as the bot shares a group with people who are not talking to it.

Messages from other bots never trigger a run, so two bots in one group cannot mention each other into a loop.

A bare `/command` counts as addressing the agent, since Telegram appends `@name` only when a group has several bots. In such a group, use `/command@my_bot` so only this bot answers.

## Replies arrive framed

A Telegram reply shows the quoted message, but the agent reads a flat history. So a reply reaches the agent with the quoted text framed above it:

```text
<replying-to from="Tracy">
here is the template
</replying-to>

and with margin?
```

Quoted text over 500 characters is cut. A reply to a message with no text, such as a bare photo or sticker, arrives unframed.

## Replies and media

- Private chats stream the answer as a live draft, then persist the final message. Groups get one final reply.
- Replies stay in the current forum topic.
- `ask_questions` renders as an inline keyboard with one button per option.
- The agent can send images, documents and stickers by file id or URL. Telegram fetches URLs itself.

See [Channels](index.md) for commands, channel tools and attachment limits.

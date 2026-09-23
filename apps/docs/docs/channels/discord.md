---
title: Discord
---

# Discord

A Discord bot puts your agent in guild channels and threads. Slash commands arrive on a webhook. Regular messages arrive over a Gateway socket that Broods holds for you.

## Setup

1. Create an application in the [Discord developer portal](https://discord.com/developers/applications). Add a bot and copy the Bot Token, the Application Public Key and the bot's user id.
2. Under Bot, Privileged Gateway Intents, turn on Message Content Intent. Without it the bot hears nothing but slash commands.
3. Invite the bot to your guild with permission to read and send messages in the channels it should answer in.
4. Store the secrets:

   ```bash
   broods env set DISCORD_BOT_TOKEN
   broods env set DISCORD_PUBLIC_KEY
   broods env set DISCORD_BOT_USER_ID
   ```

5. Define the connection and channels:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineDiscordChannel,
     defineDiscordConnection,
     env,
   } from "broods";

   export const discord = defineDiscordConnection({
     botToken: env("DISCORD_BOT_TOKEN"),
     publicKey: env("DISCORD_PUBLIC_KEY"),
     botUserId: env("DISCORD_BOT_USER_ID"),
   });

   export const support = defineDiscordChannel({
     name: "support",
     connection: discord,
     channelId: "1042000000000000000",
     guildId: "1099000000000000000",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [discord],
   });
   ```

6. Run `broods dev` or `broods deploy`. Set the printed webhook URL as the Interactions Endpoint URL in the developer portal, and register the slash commands `/new`, `/clear`, `/compact` and `/help`. The [`channel-discord` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/channel-discord) has a `register` command for this.

Declaring a `botToken` is enough to get regular messages. The hosted Discord forwarder reads your connection and opens the socket. There is nothing else to configure.

## Configuration

| Field               | Required | Description                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `botToken`          | yes      | Discord bot token                                                           |
| `publicKey`         | yes      | application public key, used to verify interactions                         |
| `botUserId`         | no       | the bot's user id. Set it so the agent answers only when mentioned          |
| `mentionRoleIds`    | no       | role ids that also count as addressing the agent, such as an on-call role   |
| `apiUrl`            | no       | API base URL, such as `https://discord.com/api/v10`. Must be public `https` |
| `allowedChannelIds` | no       | extra channel ids, or `["*"]` for every channel                             |
| `allowedUserIds`    | no       | Discord user ids allowed to trigger the agent. Everyone when omitted        |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                        |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)           |

## When the agent answers

With `botUserId` set, the agent runs only for messages that mention it by user id or by a role in `mentionRoleIds`. Other messages in an allowed channel are stored as context, so a later mention still sees them.

Without `botUserId`, Broods cannot recognize a mention and answers every message. Set it as soon as the bot shares a channel with people who are not talking to it.

The model sees each message prefixed with the sender, such as `ada: ship the fix`. The bot's own mention is stripped and other mentions become readable names. `@bot /new` still parses as a command.

## Threads

| Where the message is | Conversation key                    |
| -------------------- | ----------------------------------- |
| Channel              | `discord:{guild}:{channel}`         |
| Thread               | `discord:{guild}:{parent}:{thread}` |

A thread is its own conversation, scoped under its parent channel. `/new` inside a thread clears that thread only. An allow list or channel record that names the parent channel covers its threads.

## Gateway forwarder

Discord only POSTs slash commands and button presses to a webhook. Regular messages come only over a Gateway WebSocket. On the hosted platform, the Discord forwarder holds one socket per bot token and posts each `MESSAGE_CREATE` to your webhook.

If the forwarder logs close code 4014, Message Content Intent is off in the developer portal. Nothing on the Broods side fixes that.

Discord resets a bot token after 1000 identifies in 24 hours. The forwarder caps reconnects to stay under that, so an occasional delayed reconnect is expected.

A self-hosted deployment without the forwarder can post the events itself. The payload is in [Channels internals](../internals/channels.md).

## Replies and media

- Replies are sent as one final message. Discord has no native streaming here.
- The agent can send pictures and documents, uploaded in one multipart message.
- Delayed replies, such as background job results, are sent with the bot token, so the bot needs Send Messages in that channel.
- `ask_questions` renders as numbered text.

See [Channels](index.md) for commands, channel tools and attachment limits.

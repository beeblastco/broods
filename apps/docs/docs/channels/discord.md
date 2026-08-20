# Discord

Discord integration allows your agent to interact with users via Discord bots.

Broods uses [`@chat-adapter/discord`](https://www.npmjs.com/package/@chat-adapter/discord) for Discord API calls, signature verification, message formatting, command parsing, typing indicators, and reactions. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Slash Commands](https://chat-sdk.dev/docs/slash-commands) for the adapter capabilities.

## Configuration

Define a Discord connection with `defineDiscordConnection`, name the channels it answers in with `defineDiscordChannel`, and attach the connection to an agent:

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
  apiUrl: "https://discord.com/api/v10",
});

export const support = defineDiscordChannel({
  name: "support",
  connection: discord,
  channelId: "1042PRODENG",
  guildId: "1099SERVER",
});

export const myAgent = defineAgent({
  name: "my-agent",
  connections: [discord],
});
```

- `botToken`: Discord Bot Token.
- `publicKey`: Discord Application Public Key.
- `botUserId` (optional, recommended): the bot's own Discord user id. Set it to answer only when the agent is mentioned — see below.
- `mentionRoleIds` (optional): role ids that also count as addressing the agent, e.g. an on-call role.
- `channels` (optional): `["*"]` to answer in every channel instead of only the declared ones.
- `allowedUserIds` (optional): Discord user ids allowed to trigger the agent. Everyone, when omitted.
- `apiUrl` (optional): Discord API base URL. This maps to `DiscordAdapterConfig["apiUrl"]`.

Discord interaction webhooks are verified through the Chat SDK Discord adapter. Slash command interactions route `/new`, `/clear`, and `/help` into Broods command handlers. Gateway-forwarded `MESSAGE_CREATE` events route message text into the agent as normal chat input — see [Mentions and the gateway forwarder](#mentions-and-the-gateway-forwarder) for what puts them there.

Discord replies are delivered through `@chat-adapter/discord` final-message methods.

## Mentions and the gateway forwarder

Discord POSTs interactions — slash commands, buttons — to your app's
interactions endpoint over plain HTTP. Regular messages never reach an
interactions endpoint; they arrive only over a Gateway WebSocket. That is a
Discord routing rule, not something configuration changes.

So `botToken` alone gets you `/new` and `/help` and nothing else. Mentions need
something holding a socket and posting each `MESSAGE_CREATE` to your channel
webhook. On Broods that is the `discord-forwarder` deployment: it reads Discord
connections from the config plane, opens one socket per bot token, and forwards
events as

```json
{ "type": "GATEWAY_MESSAGE_CREATE", "data": { "...": "MESSAGE_CREATE" } }
```

with the bot token in an `x-discord-gateway-token` header. Nothing to configure
per agent — declaring a `botToken` is what enrolls the connection.

Two things the bot itself needs, both in the Discord developer portal:

- **Message Content Intent**, under Bot > Privileged Gateway Intents. Without it
  Discord rejects the connection outright (close code 4014) and the forwarder
  logs that by name rather than retrying.
- The bot in the guild, with permission to read the channels it should answer in.

Self-hosting without the forwarder deployment works the same way: post the
payload above to the webhook URL `broods deploy` printed. Send Discord's
`MESSAGE_CREATE` unmodified — `author.bot` is absent for human authors and
Broods reads an absent flag as human. The one field to add is `thread`
(`{ "id": ..., "parent_id": ... }`) when the message is inside a thread, since
Discord sets `channel_id` to the thread and says nothing about its parent. See
[Threads](#threads).

## Being tagged

With `botUserId` set, the agent answers only messages that mention it — by user
id, or by a role listed in `mentionRoleIds`. Every other message in an allowed
guild is stored as channel context and costs nothing: a later mention still sees
what the channel said. This matches Slack, where only `app_mention` runs the
agent.

Without `botUserId` a mention cannot be recognised, so the agent keeps answering
every message rather than going silent. Set it as soon as the bot shares a
channel with people who are not talking to it.

Messages reach the model prefixed with the sender (`ada: ship the fix`) so the
agent knows who is talking. The bot's own mention is stripped, other members'
mentions become readable names, and a command keeps its bare text so `@bot /new`
still parses.

## Threads

A message in a Discord thread keys its conversation to that thread, with the
parent channel as its channel scope:

| Where the message is | Conversation key                    |
| -------------------- | ----------------------------------- |
| Channel              | `discord:{guild}:{channel}`         |
| Thread               | `discord:{guild}:{parent}:{thread}` |

Slash commands resolve the same way, so `/new` typed inside a thread clears that
thread and not the channel around it.

A forwarded event is keyed off its `thread` object, so a forwarder that omits it
puts the conversation under the thread id as if it were a channel — which
disagrees with `/new` typed in that same thread, and fails an allow list that
names the parent channel.

# Discord

Discord integration allows your agent to interact with users via Discord bots.

Broods uses [`@chat-adapter/discord`](https://www.npmjs.com/package/@chat-adapter/discord) for Discord API calls, signature verification, message formatting, command parsing, typing indicators, and reactions. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Slash Commands](https://chat-sdk.dev/docs/slash-commands) for the adapter capabilities.

## Configuration

Define a Discord channel with `defineDiscordConnection` and attach it to an agent:

```ts title="broods/index.ts"
import { defineAgent, defineDiscordConnection, env } from "broods";

export const discord = defineDiscordConnection({
  botToken: env("DISCORD_BOT_TOKEN"),
  publicKey: env("DISCORD_PUBLIC_KEY"),
  botUserId: env("DISCORD_BOT_USER_ID"),
  allowedGuildIds: ["guild-id-1"],
  apiUrl: "https://discord.com/api/v10",
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
- `allowedGuildIds` (optional): An array of strings representing allowed guild IDs.
- `apiUrl` (optional): Discord API base URL. This maps to `DiscordAdapterConfig["apiUrl"]`.

Discord interaction webhooks are verified through the Chat SDK Discord adapter. Slash command interactions route `/new`, `/clear`, and `/help` into Broods command handlers. Gateway-forwarded `MESSAGE_CREATE` events route message text into the agent as normal chat input.

Discord replies are delivered through `@chat-adapter/discord` final-message methods.

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

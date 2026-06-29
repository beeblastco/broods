# Discord

Discord integration allows your agent to interact with users via Discord bots.

Broods uses [`@chat-adapter/discord`](https://www.npmjs.com/package/@chat-adapter/discord) for Discord API calls, signature verification, message formatting, command parsing, typing indicators, and reactions. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Slash Commands](https://chat-sdk.dev/docs/slash-commands) for the adapter capabilities.

## Configuration

Define a Discord channel with `defineDiscordChannel` and attach it to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineDiscordChannel,
  env,
} from "broods";

export const discord = defineDiscordChannel({
  botToken: env.DISCORD_BOT_TOKEN,
  publicKey: env.DISCORD_PUBLIC_KEY,
  allowedGuildIds: ["guild-id-1"],
  apiUrl: "https://discord.com/api/v10",
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    channels: [discord],
  },
});
```

- `botToken`: Discord Bot Token.
- `publicKey`: Discord Application Public Key.
- `allowedGuildIds` (optional): An array of strings representing allowed guild IDs.
- `apiUrl` (optional): Discord API base URL. This maps to `DiscordAdapterConfig["apiUrl"]`.

Discord interaction webhooks are verified through the Chat SDK Discord adapter. Slash command interactions route `/new`, `/clear`, and `/help` into Broods command handlers. Gateway-forwarded `MESSAGE_CREATE` events route message text into the agent as normal chat input.

Discord replies are delivered through `@chat-adapter/discord` final-message methods.

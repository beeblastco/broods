# Discord

Discord integration allows your agent to interact with users via Discord bots.

## Configuration

Define a Discord channel with `defineDiscordChannel` and attach it to an agent:

```ts title="filthypanty/index.ts"
import {
  defineAgent,
  defineDiscordChannel,
  env,
} from "filthy-panty";

export const discord = defineDiscordChannel({
  botToken: env.DISCORD_BOT_TOKEN,
  publicKey: env.DISCORD_PUBLIC_KEY,
  allowedGuildIds: ["guild-id-1"],
  streaming: { mode: "edit" },
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
- `streaming` (optional): Live reply streaming over the interaction webhook (edits the deferred reply, rotating into follow-ups past the 2000-char limit). Supports `edit`, `progress`, `chunk`, or `off` (default). See [Reply Streaming](index.md#reply-streaming).

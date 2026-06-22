# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

## Configuration

Define a Telegram channel with `defineTelegramChannel` and attach it to an agent:

```ts title="filthypanty/index.ts"
import {
  defineAgent,
  defineTelegramChannel,
  env,
} from "filthy-panty";

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [123456789, 987654321],
  reactionEmoji: "👀",
  streaming: { mode: "edit" },
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    channels: [telegram],
  },
});
```

After `filthy-panty dev` or `filthy-panty deploy`, the CLI prints the webhook URL to register with Telegram:

```text
Channel telegram (telegram): https://app.beeblast.co/webhooks/acct_.../agent_.../telegram
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `allowedChatIds`: An array of numeric chat IDs allowed to talk to the agent.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `streaming` (optional): Live reply streaming. Telegram supports all modes — `edit` (edit one message in place), `progress` (tool-activity preview then final answer), `chunk` (one message per paragraph), or `off` (default). See [Reply Streaming](index.md#reply-streaming).

# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

Broods uses [`@chat-adapter/telegram`](https://www.npmjs.com/package/@chat-adapter/telegram) for Telegram message parsing, MarkdownV2 formatting, streaming, typing indicators, reactions, and Bot API calls. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Streaming](https://chat-sdk.dev/docs/streaming) for the adapter capabilities.

## Configuration

Define a Telegram connection with `defineTelegramConnection`, name the chats it answers in with `defineTelegramChannel`, and attach the connection to an agent:

```ts title="broods/index.ts"
import { defineAgent, defineTelegramChannel, defineTelegramConnection, env } from "broods";

export const telegram = defineTelegramConnection({
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  reactionEmoji: "👀",
  apiUrl: "https://api.telegram.org",
});

export const ops = defineTelegramChannel({
  name: "ops",
  connection: telegram,
  chatId: "123456789",
});

export const myAgent = defineAgent({
  name: "my-agent",
  connections: [telegram],
});
```

A direct-message bot cannot know its chat ids up front, because a person's chat does not exist until they write. Those connections set `allowedChannelIds: ["*"]` and gate people with `allowedUserIds` instead.

After `broods dev` or `broods deploy`, the CLI prints the webhook URL to register with Telegram:

```text
Channel telegram (telegram): https://gateway.broods.app/webhooks/acct_.../telegram
```

A stage that is not production prints its own URL instead, carrying the stage's
endpoint id so its traffic stays separate from production's:

```text
Channel telegram (telegram): https://gateway.broods.app/webhooks/acct_.../dev/stage_.../telegram
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `channels` (optional): `["*"]` to answer in every chat instead of only the declared ones.
- `allowedUserIds` (optional): Telegram user ids allowed to trigger the agent. Everyone, when omitted.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `apiUrl` (optional): Telegram Bot API base URL. This maps to `TelegramAdapterConfig["apiUrl"]`.

Telegram private chats stream through Chat SDK rich draft previews and persist the final response. Group chats receive one final reply. MarkdownV2 formatting is delegated to Chat SDK.

Channel tools support images and Telegram sticker IDs or URLs. They preserve the current forum topic.

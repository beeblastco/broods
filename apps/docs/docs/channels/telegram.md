# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

Broods uses [`@chat-adapter/telegram`](https://www.npmjs.com/package/@chat-adapter/telegram) for Telegram message parsing, MarkdownV2 formatting, streaming, typing indicators, reactions, and Bot API calls. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Streaming](https://chat-sdk.dev/docs/streaming) for the adapter capabilities.

## Configuration

Define a Telegram channel with `defineTelegramChannel` and attach it to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineTelegramChannel,
  env,
} from "broods";

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [123456789, 987654321],
  reactionEmoji: "👀",
  apiUrl: "https://api.telegram.org",
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    channels: [telegram],
  },
});
```

After `broods dev` or `broods deploy`, the CLI prints the webhook URL to register with Telegram:

```text
Channel telegram (telegram): https://gateway.broods.app/webhooks/acct_.../agent_.../telegram
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `allowedChatIds`: An array of numeric chat IDs allowed to talk to the agent.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `apiUrl` (optional): Telegram Bot API base URL. This maps to `TelegramAdapterConfig["apiUrl"]`.

Telegram private chats stream through Chat SDK rich draft previews and persist the final response. Group chats receive one final reply. MarkdownV2 formatting is delegated to Chat SDK.

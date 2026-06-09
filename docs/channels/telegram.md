# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

## Configuration

To enable Telegram, include the following in your agent configuration:

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-bot-token",
      "webhookSecret": "your-webhook-secret",
      "allowedChatIds": ["chat-id-1", "chat-id-2"],
      "reactionEmoji": "👀",
      "streaming": { "mode": "edit" }
    }
  }
}
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `allowedChatIds`: An array of strings representing allowed chat IDs.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `streaming` (optional): Live reply streaming. Telegram supports all modes — `edit` (edit one message in place), `progress` (tool-activity preview then final answer), `chunk` (one message per paragraph), or `off` (default). See [Reply Streaming](index.md#reply-streaming).

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
      "reactionEmoji": "👀" 
    }
  }
}
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `allowedChatIds`: An array of strings representing allowed chat IDs.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".

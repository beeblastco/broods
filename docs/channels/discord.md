# Discord

Discord integration allows your agent to interact with users via Discord bots.

## Configuration

To enable Discord, include the following in your agent configuration:

```json
{
  "channels": {
    "discord": {
      "botToken": "your-bot-token",
      "publicKey": "your-public-key",
      "allowedGuildIds": ["guild-id-1"],
      "streaming": { "mode": "edit" }
    }
  }
}
```

- `botToken`: Discord Bot Token.
- `publicKey`: Discord Application Public Key.
- `allowedGuildIds` (optional): An array of strings representing allowed guild IDs.
- `streaming` (optional): Live reply streaming over the interaction webhook (edits the deferred reply, rotating into follow-ups past the 2000-char limit). Supports `edit`, `progress`, `chunk`, or `off` (default). See [Reply Streaming](index.md#reply-streaming).

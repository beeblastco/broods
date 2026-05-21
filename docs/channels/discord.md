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
      "allowedGuildIds": ["guild-id-1"]
    }
  }
}
```

- `botToken`: Discord Bot Token.
- `publicKey`: Discord Application Public Key.
- `allowedGuildIds` (optional): An array of strings representing allowed guild IDs.

# Slack

Slack integration allows your agent to interact with users via Slack.

## Configuration

To enable Slack, include the following in your agent configuration:

```json
{
  "channels": {
    "slack": {
      "botToken": "your-bot-token",
      "signingSecret": "your-signing-secret",
      "allowedChannelIds": ["channel-id-1"]
    }
  }
}
```

- `botToken`: Slack Bot User OAuth Token.
- `signingSecret`: Used to verify Slack requests.
- `allowedChannelIds` (optional): An array of strings representing allowed channel IDs.

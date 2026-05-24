# GitHub

GitHub integration allows your agent to react to GitHub events.

## Configuration

To enable GitHub, include the following in your agent configuration:

```json
{
  "channels": {
    "github": {
      "webhookSecret": "your-webhook-secret",
      "appId": "your-app-id",
      "privateKey": "your-private-key",
      "allowedRepos": ["repo-1", "repo-2"]
    }
  }
}
```

- `webhookSecret`: GitHub Webhook Secret.
- `appId`: GitHub App ID.
- `privateKey`: GitHub App Private Key.
- `allowedRepos` (optional): An array of strings representing allowed repository names.

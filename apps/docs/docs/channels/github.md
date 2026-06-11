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
      "allowedRepos": ["owner/repo-1", "owner/repo-2"]
    }
  }
}
```

- `webhookSecret`: GitHub Webhook Secret.
- `appId`: GitHub App ID.
- `privateKey`: GitHub App Private Key.
- `allowedRepos` (optional): An array of full repository names (`owner/repo`) the agent may respond in. Events are matched against the webhook's `repository.full_name`.

# GitHub

GitHub integration allows your agent to react to GitHub events.

## Configuration

Define a GitHub channel with `defineGitHubChannel` and attach it to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineGitHubChannel,
  env,
} from "broods";

export const github = defineGitHubChannel({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  allowedRepos: ["owner/repo-1", "owner/repo-2"],
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    channels: [github],
  },
});
```

- `webhookSecret`: GitHub Webhook Secret.
- `appId`: GitHub App ID.
- `privateKey`: GitHub App Private Key.
- `allowedRepos` (optional): An array of full repository names (`owner/repo`) the agent may respond in. Events are matched against the webhook's `repository.full_name`.

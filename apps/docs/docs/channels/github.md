# GitHub

GitHub integration allows your agent to react to GitHub events.

Broods uses [`@chat-adapter/github`](https://www.npmjs.com/package/@chat-adapter/github) for GitHub webhook verification, installation authentication, comment posting, reactions, thread IDs, Markdown formatting, and buffered response streaming. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Streaming](https://chat-sdk.dev/docs/streaming) for the adapter capabilities.

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
  apiUrl: "https://api.github.com",
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
- `apiUrl` (optional): GitHub API base URL, for example for GitHub Enterprise. This maps to `GitHubAdapterConfig["apiUrl"]`.

## Runtime Behavior

The GitHub channel accepts these webhook events:

- `issues`: `opened`, `edited`, and `reopened`
- `pull_request`: `opened`, `edited`, and `reopened`
- `issue_comment`: `created`, including pull request conversation comments
- `pull_request_review_comment`: `created`

The GitHub adapter streams by buffering the model text and posting one GitHub Markdown comment, which matches GitHub's API behavior.

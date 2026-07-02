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
- `userName` (optional): Bot username for @-mention detection (e.g. `"my-bot"` or `"my-bot[bot]"`). When set, the bot only responds to comments that mention `@userName`. Without this, the bot responds to all human comments.
- `botUserId` (optional): Bot's numeric GitHub user ID for self-message detection. Auto-detected from the GitHub API when omitted.
- `triggerOnIssueOpen` (optional): When `false`, the bot does not auto-trigger on new issues (`opened`, `edited`, `reopened`). Defaults to `true`. Set to `false` if you only want the bot to respond to comments (e.g. `@mention` gating via `userName`).
- `triggerOnPROpen` (optional): When `false`, the bot does not auto-trigger on new pull requests (`opened`, `edited`, `reopened`). Defaults to `true`. Set to `false` if you only want the bot to respond to comments.

## Runtime Behavior

The GitHub channel accepts these webhook events:

- `issues`: `opened`, `edited`, `reopened`, and `assigned`
- `pull_request`: `opened`, `edited`, `reopened`, and `assigned`
- `issue_comment`: `created`, including pull request conversation comments
- `pull_request_review_comment`: `created`

The `triggerOnIssueOpen` and `triggerOnPROpen` options only control `opened`, `edited`, and `reopened` actions. The `assigned` action works independently — when you assign the bot to an issue or PR, it always triggers regardless of those flags. This lets you set `triggerOnIssueOpen: false` and `triggerOnPROpen: false` while still being able to manually engage the bot by assigning it.

When a comment triggers the agent, Broods fetches the issue or pull request title, body, and prior comments from GitHub and adds them as one-turn context before the model answers. This lets an agent tagged midway through an issue understand the conversation above the tag, while the model still sees the triggering comment as the user message.

The GitHub adapter streams by buffering the model text and posting one GitHub Markdown comment, which matches GitHub's API behavior.

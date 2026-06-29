# Slack

Slack integration allows your agent to interact with users via Slack.

Broods uses [`@chat-adapter/slack`](https://www.npmjs.com/package/@chat-adapter/slack) for Slack request verification, streaming, Markdown conversion, reactions, and Web API calls. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Slack Primitives](https://chat-sdk.dev/docs/slack-primitives), [Markdown](https://chat-sdk.dev/docs/api/markdown), [Streaming](https://chat-sdk.dev/docs/streaming), and [Slash Commands](https://chat-sdk.dev/docs/slash-commands) for the adapter capabilities.

## Configuration

Define a Slack channel with `defineSlackChannel` and attach it to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineSlackChannel,
  env,
} from "broods";

export const slack = defineSlackChannel({
  botToken: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  allowedChannelIds: ["channel-id-1"],
  reactionEmoji: "eyes",
  apiUrl: "https://slack.com/api/",
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    channels: [slack],
  },
});
```

- `botToken`: Slack Bot User OAuth Token.
- `signingSecret`: Used to verify Slack requests.
- `allowedChannelIds` (optional): An array of strings representing allowed channel IDs.
- `reactionEmoji` (optional): Slack emoji name to add to accepted messages, defaults to `eyes`.
- `apiUrl` (optional): Slack Web API base URL, for example for GovSlack or a test proxy. This maps to `SlackAdapterConfig["apiUrl"]`.

Slack replies stream through Chat SDK's native Slack streaming API when the source event has thread and user context. Otherwise the agent sends one final reply through Chat SDK Slack primitives. Markdown and response-url text formatting are delegated to Chat SDK.

## Slack App Setup

Point Event Subscriptions and Slash Commands (`/new`, `/clear`, `/help`) at the generated Slack webhook URL.

Subscribe the bot to these event types:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Channel and group messages are answered in a thread. Direct messages and App Home messages keep one channel-scoped conversation.

# Slack

A Slack app is how the agent reaches channels, private groups, and DMs.

Broods uses [`@chat-adapter/slack`](https://www.npmjs.com/package/@chat-adapter/slack) for Slack request verification, streaming, Markdown conversion, reactions, and Web API calls. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Slack Primitives](https://chat-sdk.dev/docs/slack-primitives), [Markdown](https://chat-sdk.dev/docs/api/markdown), [Streaming](https://chat-sdk.dev/docs/streaming), and [Slash Commands](https://chat-sdk.dev/docs/slash-commands) for the adapter capabilities.

## Configuration

Define a Slack connection with `defineSlackConnection`, name the rooms it answers in with `defineSlackChannel`, and attach the connection to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineSlackChannel,
  defineSlackConnection,
  env,
} from "broods";

export const slack = defineSlackConnection({
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  reactionEmoji: "eyes",
  apiUrl: "https://slack.com/api/",
});

export const productEng = defineSlackChannel({
  name: "product-eng",
  connection: slack,
  channelId: "C042PRODENG",
});

export const myAgent = defineAgent({
  name: "my-agent",
  connections: [slack],
});
```

The agent answers in the rooms you declared and nowhere else. To answer in every room the app can see, set `allowedChannelIds: ["*"]` on the connection instead.

- `botToken`: Slack Bot User OAuth Token.
- `signingSecret`: The secret Broods verifies Slack requests against.
- `channels` (optional): `["*"]` to answer in every room instead of only the declared ones.
- `allowedUserIds` (optional): Slack user ids allowed to trigger the agent. Everyone, when omitted.
- `reactionEmoji` (optional): Slack emoji name to add to accepted messages, defaults to `eyes`.
- `apiUrl` (optional): Slack Web API base URL, for example for GovSlack or a test proxy. This maps to `SlackAdapterConfig["apiUrl"]`.

Slack replies stream through Chat SDK's native Slack streaming API when the source event has thread and user context. Otherwise the agent sends one final reply through Chat SDK Slack primitives. Chat SDK does the Markdown and response-url text formatting.

Channel tools support image blocks and custom emoji or URL stickers. Event replies preserve the current Slack thread. Slash-command replies use the Slack response URL.

## Slack app setup

Point Event Subscriptions and Slash Commands (`/new`, `/clear`, `/compact`, `/help`) at the generated Slack webhook URL.

Subscribe the bot to these event types:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

The agent answers channel and group messages in a thread. Direct messages and App Home messages keep one channel-scoped conversation.

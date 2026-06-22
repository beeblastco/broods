# Slack

Slack integration allows your agent to interact with users via Slack.

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
  streaming: { mode: "edit" },
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
- `streaming` (optional): Live reply streaming via `chat.update`. Supports `edit`, `progress`, `chunk`, or `off` (default). See [Reply Streaming](index.md#reply-streaming).

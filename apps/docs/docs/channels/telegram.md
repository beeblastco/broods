# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

Broods uses [`@chat-adapter/telegram`](https://www.npmjs.com/package/@chat-adapter/telegram) for Telegram message parsing, MarkdownV2 formatting, streaming, typing indicators, reactions, and Bot API calls. See Chat SDK [Platform Adapters](https://chat-sdk.dev/docs/platform-adapters), [Markdown](https://chat-sdk.dev/docs/api/markdown), and [Streaming](https://chat-sdk.dev/docs/streaming) for the adapter capabilities.

## Configuration

Define a Telegram connection with `defineTelegramConnection`, name the chats it answers in with `defineTelegramChannel`, and attach the connection to an agent:

```ts title="broods/index.ts"
import {
  defineAgent,
  defineTelegramChannel,
  defineTelegramConnection,
  env,
} from "broods";

export const telegram = defineTelegramConnection({
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  botUsername: "my_bot",
  reactionEmoji: "👀",
  apiUrl: "https://api.telegram.org",
});

export const ops = defineTelegramChannel({
  name: "ops",
  connection: telegram,
  chatId: "123456789",
});

export const myAgent = defineAgent({
  name: "my-agent",
  connections: [telegram],
});
```

A direct-message bot cannot know its chat ids up front, because a person's chat does not exist until they write. Those connections set `allowedChannelIds: ["*"]` and gate people with `allowedUserIds` instead.

After `broods dev` or `broods deploy`, the CLI prints the webhook URL to register with Telegram:

```text
Channel telegram (telegram): https://gateway.broods.app/webhooks/acct_.../telegram
```

A stage that is not production prints its own URL instead, carrying the stage's
endpoint id so its traffic stays separate from production's:

```text
Channel telegram (telegram): https://gateway.broods.app/webhooks/acct_.../dev/stage_.../telegram
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `botUsername` (optional, recommended): the bot's own @username. Set it to answer only when the agent is addressed — see below.
- `channels` (optional): `["*"]` to answer in every chat instead of only the declared ones.
- `allowedUserIds` (optional): Telegram user ids allowed to trigger the agent. Everyone, when omitted.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `apiUrl` (optional): Telegram Bot API base URL. This maps to `TelegramAdapterConfig["apiUrl"]`.

## Being tagged

With `botUsername` set, a group message runs the agent only when it addresses
the agent: an `@name` mention, a slash command, or a reply to one of the agent's
own messages. Every other message in an allowed chat is stored as channel
context and costs nothing, so a later mention still sees what the chat said.
This matches Discord, where `botUserId` does the same job, and Slack, where only
`app_mention` runs the agent.

A private chat always runs the agent. There is nobody else in the room to
address, so no tag is needed.

Another bot never triggers a run, whether or not it tags the agent. Two bots
sharing a group therefore cannot mention each other into a loop.

Without `botUsername` a mention cannot be recognised, so the agent keeps
answering every message rather than going silent. Set it as soon as the bot
shares a group with people who are not talking to it.

A bare `/command` counts as addressing the agent, because Telegram only appends
`@name` to a command when a group holds more than one bot. In a group with
several bots, use `/command@name` so only the intended one answers.

## Replies arrive framed

Telegram draws a reply as a quote of the message it answers, but the
conversation an agent reads is a flat list in time order, so that quote is not
in it. A reply therefore arrives with the answered message framed above it:

```text
<replying-to from="Tracy">
here is the template
</replying-to>

and with margin?
```

Without this the agent reads only `and with margin?` and has to guess what "it"
means, the same way a person would after scrolling past the quote. The frame
matches the one a scheduled run gets, rather than a markdown blockquote a group
member could type by hand to forge one. Quoted text longer than 500 characters
is cut short, and a reply to a message with no text of its own (a bare photo, a
sticker) arrives unframed.

Telegram private chats stream through Chat SDK rich draft previews and persist the final response. Group chats receive one final reply. MarkdownV2 formatting is delegated to Chat SDK.

Channel tools support images and Telegram sticker IDs or URLs. They preserve the current forum topic.

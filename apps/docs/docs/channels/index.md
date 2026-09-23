---
title: Channels
---

# Channels

A channel puts your agent in a chat app: Slack, Telegram, Discord, GitHub, Matrix, Pancake or Zalo. Messages that arrive there become agent turns, and the answer goes back to the same place.

Three pieces are involved:

- A **connection** is one app install and holds its credentials, such as a Slack bot token.
- A **channel** names one room the connection answers in, such as `#product-eng`.
- A [channel record](channel-records.md) is what a channel becomes after deploy. It can also route that room to a different agent and add rules for it.

## Minimal example

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
});

export const productEng = defineSlackChannel({
  name: "product-eng",
  connection: slack,
  channelId: "C042PRODENG",
});

export const support = defineAgent({
  name: "support",
  // model, provider, ...
  connections: [slack],
});
```

The agent lists the connection. The channel points at the connection. Nothing points back at a channel, so a channel can name its own connection's agent without a circular reference.

Run `broods dev` or `broods deploy`. The CLI syncs the referenced secrets, generates `api.channels`, and prints the webhook URL to register with the provider.

An agent can hold several connections of different providers. One connection belongs to one agent.

## Supported channels

| Provider                | Reaches                                | Required connection fields                   | Commands |
| ----------------------- | -------------------------------------- | -------------------------------------------- | -------- |
| [Telegram](telegram.md) | private chats, groups, forum topics    | `botToken`, `webhookSecret`                  | yes      |
| [Slack](slack.md)       | channels, private groups, DMs          | `botToken`, `signingSecret`                  | yes      |
| [Discord](discord.md)   | guild channels and threads             | `botToken`, `publicKey`                      | yes      |
| [GitHub](github.md)     | issues, pull requests, comment threads | `webhookSecret`, `appId`, `privateKey`       | no       |
| [Matrix](matrix.md)     | rooms, including encrypted ones        | `apiUrl`, `botToken`                         | yes      |
| [Pancake](pancake.md)   | Pancake inbox messages and comments    | `pageId`, `pageAccessToken`, `webhookSecret` | no       |
| [Zalo](zalo.md)         | private chats and groups               | `botToken`, `webhookSecret`                  | yes      |

Store every secret with `broods env set NAME` and reference it with `env("NAME")`. Never inline a token.

## Webhook URL

There is one webhook URL per account and provider. It never names an agent. The account's agent whose credentials verify the request receives it.

| Stage       | URL                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| Production  | `{BROODS_BASE_URL}/v1/webhooks/{accountId}/{channel}`                  |
| Other stage | `{BROODS_BASE_URL}/v1/webhooks/{accountId}/dev/{endpointId}/{channel}` |

`broods dev` and `broods deploy` print the right one for the stage:

```text
Channel telegram (telegram): https://gateway.broods.app/v1/webhooks/acct_.../telegram
```

The stage URL reaches only the stage it names. Use it when two stages share one bot, otherwise both stages compete for the same traffic. Providers that store one webhook per bot, such as Telegram and Zalo, move all traffic to whichever URL you registered last.

## Where the agent listens

A connection answers in the rooms declared as channels against it and nowhere else. Messages from an undeclared room are dropped silently.

| Setting on the connection   | Effect                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| a `define*Channel` per room | answers in those rooms, with that room's rules                       |
| `allowedChannelIds: ["id"]` | adds rooms with no rules of their own                                |
| `allowedChannelIds: ["*"]`  | answers in every room the app can see                                |
| `allowedUserIds: ["id"]`    | only these senders trigger the agent. Omitted or `["*"]` is everyone |

A connection that declares no channel and no `allowedChannelIds` fails `broods dev`, so it cannot go quiet in production. Direct-message bots cannot know chat ids in advance, so they set `allowedChannelIds: ["*"]` and gate people with `allowedUserIds`.

## Chat commands

Telegram, Slack, Discord, Matrix and Zalo route these commands to Broods instead of the agent. GitHub and Pancake pass slash text to the agent as normal input.

| Command                                   | Effect                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| `/new`, `/clear`                          | clear the conversation. Refused while a turn is running         |
| `/compact [instructions]`                 | summarize the history now, whatever `session.compaction` says   |
| `/help`                                   | list commands                                                   |
| `/steer <text>`                           | join the running turn at its next step. Starts a turn when idle |
| `/queue <text>`                           | run the text as its own turn after the current one              |
| `/queue steer\|followup\|collect\|reject` | set the default mode for this conversation                      |
| `/stop`, `/cancel`                        | stop the running turn after its current step                    |

An ordinary message sent while the agent is busy steers the running turn. See [Conversations](../guides/conversations.md).

## Channel tools

On a channel turn the agent gets these tools automatically. Do not add them to `config.tools`. Hide any of them per room with `denyTools` on a [channel record](channel-records.md).

| Tool             | Use                                                         |
| ---------------- | ----------------------------------------------------------- |
| `send-update`    | post a progress note before the turn ends. Always available |
| `send-message`   | message another conversation, which runs it as a follow-up  |
| `send-images`    | send pictures from workspace files (`file_paths`) or `urls` |
| `send-files`     | send workspace documents such as PDFs and spreadsheets      |
| `send-sticker`   | send a sticker                                              |
| `send-reactions` | react to a message                                          |

Tools other than `send-update` appear only where the provider supports them. The final reply is still delivered when the turn ends.

`send-files` and the `file_paths` argument of `send-images` need an attached workspace. A file leaves as a durable `/v1/media/{ticket}` link, and a file in a bare sandbox has no such link. An agent with sandboxes but no workspaces gets no `send-files`, and its `send-images` takes `urls` only.

| Channel  | Pictures             | Documents            | Batching                |
| -------- | -------------------- | -------------------- | ----------------------- |
| Telegram | provider fetches URL | provider fetches URL | albums of 2 to 10       |
| Slack    | image blocks         | uploaded             | one message, one upload |
| Discord  | uploaded             | uploaded             | one multipart message   |
| Matrix   | uploaded             | uploaded             | one per message         |
| Pancake  | uploaded             | uploaded             | one per message         |
| Zalo     | provider fetches URL | sent as links        | one per message         |
| GitHub   | links in text        | links in text        | text only               |

Where a provider has no document endpoint, `send-files` posts the links as text and tells the model so. If a provider rejects pictures, `send-images` falls back to sending them as documents or links. A caption rides the first message only.

## Inbound attachments

Media sent to the agent is read while the turn runs.

| Channel  | What arrives                                                               |
| -------- | -------------------------------------------------------------------------- |
| Telegram | photos, video, audio, voice notes, documents, video notes, static stickers |
| Slack    | every file on a message, including voice clips                             |
| Discord  | uploads, voice messages, stickers                                          |
| Matrix   | images, video, audio, files, including encrypted ones                      |
| Pancake  | photos and videos                                                          |
| Zalo     | photos, stickers, voice notes                                              |
| GitHub   | none. A pasted image stays a markdown URL in the text                      |

Limits: 6 MB per picture, 25 MB for anything else, 10 attachments per message. The media type comes from the bytes, not the provider's label. An attachment that cannot be read becomes a line of text saying so, and the rest of the message still arrives.

Pictures reach the model as pictures. A PDF, voice note or video goes over natively only when the model provider accepts that type. Otherwise the agent gets it as a workspace file to open with `read` or `bash`. Each message with attachments also carries a short note listing what arrived and where it was stored.

With a workspace attached, each file is saved under `media/` in the default workspace. Without one, nothing is stored. The bytes reach the model on that turn, and later turns re-read the file through the provider, so the provider's retention decides how long it works. A Telegram file id lasts indefinitely, a Discord link expires within a day. Attach a workspace when media must outlive the provider, or when the agent must open files rather than look at them.

### Voice transcription

Audio the model cannot hear is transcribed on the way in, with the account's own provider credentials. No configuration is needed.

| Provider       | Default model                                     |
| -------------- | ------------------------------------------------- |
| OpenAI         | `whisper-1`                                       |
| Groq           | `whisper-large-v3-turbo`                          |
| Mistral        | `voxtral-mini-latest`                             |
| Google, Vertex | none. The recording is sent to the model directly |

Set `model.transcriptionModelId` to use another model on the same provider. The defaults accept ogg/opus, which Telegram, Discord and Zalo voice notes use. Cheaper models such as `gpt-4o-mini-transcribe` refuse ogg.

A failed transcription never drops the message. The note says why: a busy provider, a refused format, or no speech-to-text on the account.

## Shared behavior

- Typing and reactions. An accepted message triggers a typing indicator and a reaction where the provider supports them. Telegram and Slack reactions are configurable with `reactionEmoji`. GitHub reacts with eyes. Pancake and Zalo do neither.
- Tool approval. Tools with `needsApproval` are denied on channel turns with `Tool approval is only supported through the direct API.` Keep approval-gated tools off channel agents.
- Errors. If a turn fails, the room receives `Error: <message>`.
- Deferred replies. When a turn finishes later, such as a background sandbox job, the result is pushed back into the same chat.
- Trace links. Replies omit the dashboard trace link. Set `trace: "enabled"` on the connection to include it. Tracing itself is unaffected.
- Credentials. A run only sees its own channel's credentials.

Runnable examples live in `packages/demos/channel-*` and `packages/demos/multi-channel`. For how a webhook turns into a run inside the platform, see [Channels internals](../internals/channels.md).

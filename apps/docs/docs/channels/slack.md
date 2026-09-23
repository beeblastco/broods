---
title: Slack
---

# Slack

A Slack app puts your agent in channels, private groups and DMs.

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps). Install it to your workspace and copy the Bot User OAuth Token and the Signing Secret.
2. Store both:

   ```bash
   broods env set SLACK_BOT_TOKEN
   broods env set SLACK_SIGNING_SECRET
   ```

3. Define the connection and the channels it answers in:

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

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [slack],
   });
   ```

4. Run `broods dev` or `broods deploy` and copy the printed webhook URL.
5. In the Slack app settings, point Event Subscriptions and the slash commands `/new`, `/clear`, `/compact` and `/help` at that URL. Subscribe the bot to these events:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

The agent answers in the declared channels only. Set `allowedChannelIds: ["*"]` on the connection to answer in every room the app can see.

## Configuration

| Field               | Required | Description                                                            |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| `botToken`          | yes      | Bot User OAuth Token                                                   |
| `signingSecret`     | yes      | secret Broods verifies Slack requests against                          |
| `reactionEmoji`     | no       | emoji name added to accepted messages. Default `eyes`                  |
| `apiUrl`            | no       | Web API base URL, for GovSlack or a test proxy. Must be public `https` |
| `allowedChannelIds` | no       | extra channel ids, or `["*"]` for every room                           |
| `allowedUserIds`    | no       | Slack user ids allowed to trigger the agent. Everyone when omitted     |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                   |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)      |

`apiUrl` is checked when saved, because the bot token is sent to it.

## When the agent answers

Only `app_mention` runs the agent in a channel. Other messages are kept as context for the next mention.

Channel and group messages get a threaded reply. DMs and App Home messages share one conversation per channel. On a [channel record](channel-records.md), `replyIn: "source"` answers in place instead of opening a thread.

## Replies and media

- Replies stream live when the event has thread and user context. Otherwise the agent sends one final reply.
- Event replies stay in the current thread. Slash command replies use the command's response URL.
- The agent can send image blocks, uploaded files, and custom emoji or URL stickers.
- `ask_questions` renders as numbered text. Reply with an option number, its label, or free text when allowed.

See [Channels](index.md) for commands, channel tools and attachment limits.

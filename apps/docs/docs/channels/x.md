---
title: X
---

# X

The X channel answers direct messages sent to an X account, through the X Activity API. Every conversation is one person messaging the account. Public mentions are not answered.

## Access tokens expire

X OAuth 2.0 user tokens last about two hours. Broods has no store yet for the rotating refresh token X hands back, so the channel takes a plain access token and replies fail with `401` once it expires. Set a fresh token to resume. Incoming DMs are still verified and received in the meantime.

## Setup

1. In the [X developer portal](https://developer.x.com), create a Project and App. Under **Keys and tokens**, copy the **API Key Secret**. It is the consumer secret that answers the CRC check and signs every delivery.
2. Under **User authentication settings**, turn on OAuth 2.0 with the scopes `dm.read`, `dm.write`, `users.read` and `tweet.read`. Complete the OAuth 2.0 flow as the bot account and keep its access token.
3. Find the bot account's numeric user id, for example with `GET https://api.x.com/2/users/me` and that token.
4. Store the secrets:

   ```bash
   broods env set X_CONSUMER_SECRET
   broods env set X_USER_ACCESS_TOKEN
   ```

5. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineXConnection, env } from "broods";

   export const x = defineXConnection({
     consumerSecret: env("X_CONSUMER_SECRET"),
     userAccessToken: env("X_USER_ACCESS_TOKEN"),
     userId: "2244994945",
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [x],
   });
   ```

   A person's DM does not exist until they write, so the account needs `allowedChannelIds: ["*"]`. Gate people with `allowedUserIds` instead.

6. Run `broods dev` or `broods deploy`. In the [X developer console](https://console.x.com), register the printed URL `/v1/webhooks/{accountId}/x` as the app's webhook. X sends a CRC challenge right away and every hour after, and Broods answers it with the consumer secret.
7. Create an activity subscription for `dm.received` on the bot's user id, pointing at that webhook. The bot account must have authorized the app first.

One X app has one webhook, and it carries events for every account subscribed to it. Deliveries for another account than `userId` are ignored. The CRC challenge is unsigned, so when two agents in one Broods account hold different X apps, give each its own stage URL.

## Configuration

| Field               | Required | Description                                                                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `consumerSecret`    | yes      | the app's API Key Secret. Answers the CRC challenge and checks `x-twitter-webhooks-signature`                                            |
| `userAccessToken`   | yes      | OAuth 2.0 user token for the bot account, with `dm.write`. Expires in about two hours, see [Access tokens expire](#access-tokens-expire) |
| `userId`            | yes      | numeric id of the bot account. Tells the account's own DMs from the ones it answers                                                      |
| `userName`          | no       | the bot's handle                                                                                                                         |
| `apiBaseUrl`        | no       | X API base URL. Public `https` only. Defaults to `api.x.com`                                                                             |
| `allowedChannelIds` | no       | sender user ids, or `["*"]` for everyone                                                                                                 |
| `allowedUserIds`    | no       | numeric X user ids allowed to trigger the agent                                                                                          |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                                                                                     |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                                                                        |

Rules for one person go on a channel:

```ts
export const vip = defineXChannel({
  name: "vip",
  connection: x,
  userId: ["783214"],
  instructions: "This is a priority customer.",
});
```

## What works

- Text DMs in both directions. Markdown is flattened to plain text, since X renders none.
- `/new`, `/compact` and the other chat commands.

What does not:

- Public mentions and replies. Only `dm.received` runs the agent.
- No inbound media. A DM with only a picture is ignored.
- No outbound pictures or documents. There is no `send-images`, and `send-files` posts links as text.
- No typing indicator and no reactions. X has neither for DMs.
- No streaming. The reply goes out once the turn ends.
- Managed token refresh. See [Access tokens expire](#access-tokens-expire).
- A delivery with several DMs runs the first one and logs the rest.

See [Channels](index.md) for commands, channel tools and attachment limits.

---
title: Messenger
---

# Messenger

The Messenger channel answers direct messages to a Facebook Page, through the Messenger Platform Send API.

## Setup

1. At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app with the use case **Engage with customers on Messenger from Meta**. Copy the **App Secret** from **App settings > Basic**.
2. You need a Facebook Page. People message the Page to reach the agent.
3. In the app, open **Use cases > Messenger > Customize > Messenger API Settings**. Under **Generate access tokens**, add your Page and generate a Page access token.
4. Pick a random verify token. You type it into Meta in step 7.
5. Store the values:

   ```bash
   broods env set FACEBOOK_APP_SECRET
   broods env set FACEBOOK_PAGE_ACCESS_TOKEN
   broods env set FACEBOOK_VERIFY_TOKEN
   ```

6. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineMessengerConnection, env } from "broods";

   export const messenger = defineMessengerConnection({
     appSecret: env("FACEBOOK_APP_SECRET"),
     pageAccessToken: env("FACEBOOK_PAGE_ACCESS_TOKEN"),
     verifyToken: env("FACEBOOK_VERIFY_TOKEN"),
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [messenger],
   });
   ```

   Every Messenger conversation is one person, and their id does not exist until they write, so a Page that takes new customers needs `allowedChannelIds: ["*"]`.

7. Run `broods dev` or `broods deploy`. Under **Configure webhooks**, click **Add Callback URL**, enter the printed URL, `/v1/webhooks/{accountId}/messenger`, and the verify token, then **Verify and Save**. Meta sends a GET handshake, and Broods answers it with the challenge once the verify token matches.
8. Under the Page's webhook subscriptions, enable `messages` and `messaging_postbacks`.

Meta keeps one callback URL per app. Pointing it at a stage URL moves all of that app's traffic to that stage.

Several Pages can share one app: each agent answers only the messages sent to the Page its access token belongs to.

## Configuration

| Field               | Required | Where it comes from                                                  |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `appSecret`         | yes      | App settings > Basic. Checks `X-Hub-Signature-256` on every delivery |
| `pageAccessToken`   | yes      | Messenger API Settings > Generate access tokens                      |
| `verifyToken`       | yes      | a value you choose and type into the webhook settings                |
| `apiVersion`        | no       | Graph API version such as `v21.0`. Defaults to the SDK's             |
| `userName`          | no       | name the Chat SDK uses for the Page                                  |
| `allowedChannelIds` | no       | people (PSIDs) to answer, or `["*"]` for everyone                    |
| `allowedUserIds`    | no       | PSIDs allowed to trigger the agent                                   |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                 |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)    |

A person's id on Messenger is page-scoped (a PSID). Give one person their own rules with a channel:

```ts
export const vip = defineMessengerChannel({
  name: "vip",
  connection: messenger,
  psid: "6543210987654321",
  instructions: "This is a key account. Offer a call.",
});
```

## What works

- Text in and out. Replies go out in pieces of at most 1900 characters, under the 2000-character Send API limit, so a long one arrives as several messages.
- Buttons and the Get Started button. A tap arrives as the button title.
- Inbound pictures, video, audio and files. Meta hosts them and the agent reads the link.
- Typing indicators.
- `/new`, `/compact` and the other [chat commands](index.md#chat-commands).

What does not:

- No sending pictures or files. `send-files` posts links as text instead.
- No reactions. A Page cannot react to a message.
- No streaming. The reply goes out whole when the turn ends.
- Echoes of the Page's own messages, reactions, reads and deliveries are ignored.
- Meta allows free-form replies only within 24 hours of the person's last message.

See [Channels](index.md) for commands, channel tools and attachment limits.

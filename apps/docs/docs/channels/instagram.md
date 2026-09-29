---
title: Instagram
---

# Instagram

The Instagram channel answers direct messages to an Instagram professional account, through the Instagram API with Instagram Login. No Facebook Page is needed.

## Setup

1. The account must be a Business or Creator account.
2. At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app and add the **Instagram** product with **API setup with Instagram login**. Copy the **Instagram app secret**.
3. Add the account, grant `instagram_business_basic` and `instagram_business_manage_messages`, and generate an access token. Note the account's numeric id, shown next to the token.
4. Pick a random verify token. You type it into Meta in step 7.
5. Store the values:

   ```bash
   broods env set INSTAGRAM_ACCESS_TOKEN
   broods env set INSTAGRAM_APP_SECRET
   broods env set INSTAGRAM_VERIFY_TOKEN
   ```

6. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineInstagramConnection, env } from "broods";

   export const instagram = defineInstagramConnection({
     accessToken: env("INSTAGRAM_ACCESS_TOKEN"),
     accountId: "17841400000000000",
     appSecret: env("INSTAGRAM_APP_SECRET"),
     verifyToken: env("INSTAGRAM_VERIFY_TOKEN"),
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [instagram],
   });
   ```

   Every Instagram DM is one person, and their id does not exist until they write, so an account that takes new customers needs `allowedChannelIds: ["*"]`.

7. Run `broods dev` or `broods deploy`. Under **Configure webhooks**, enter the printed URL, `/v1/webhooks/{accountId}/instagram`, and the verify token, then **Verify and save**. Meta sends a GET handshake, and Broods answers it with the challenge once the verify token matches.
8. Subscribe the `messages` and `messaging_postbacks` webhook fields.

Several accounts can share one app: each agent answers only the messages sent to its own `accountId`.

Production apps that message accounts they do not own need Meta's Advanced Access for `instagram_business_manage_messages`.

## Configuration

| Field               | Required | Where it comes from                                                           |
| ------------------- | -------- | ----------------------------------------------------------------------------- |
| `accessToken`       | yes      | the token generated for the account in API setup                              |
| `accountId`         | yes      | the account's numeric id. Deliveries for the app's other accounts are ignored |
| `appSecret`         | yes      | Instagram app secret. Checks `X-Hub-Signature-256` on every delivery          |
| `verifyToken`       | yes      | a value you choose and type into the webhook settings                         |
| `apiVersion`        | no       | Graph API version such as `v26.0`. Defaults to the SDK's                      |
| `userName`          | no       | name the Chat SDK uses for the account                                        |
| `allowedChannelIds` | no       | people (IGSIDs) to answer, or `["*"]` for everyone                            |
| `allowedUserIds`    | no       | IGSIDs allowed to trigger the agent                                           |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                          |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)             |

A person's id on Instagram is scoped to the account (an IGSID). Give one person their own rules with a channel:

```ts
export const vip = defineInstagramChannel({
  name: "vip",
  connection: instagram,
  igsid: "1234567890123456",
  instructions: "This is a key account. Offer a call.",
});
```

## What works

- Text in and out. Replies go out in pieces of at most 950 bytes, under Instagram's 1000-byte limit, so a long one arrives as several messages.
- Inbound pictures, video, audio, story replies and story mentions. Meta hosts them and the agent reads the link.
- Outbound pictures, video, audio and PDFs. Workspace files are uploaded, public `https` URLs are sent as links for Instagram to fetch.
- Quick replies and postbacks. A tap arrives as its title.
- Typing indicators.
- `/new`, `/compact` and the other [chat commands](index.md#chat-commands).

What does not:

- No reactions.
- No streaming. The reply goes out whole when the turn ends.
- Echoes, deleted and unsupported messages, reactions and reads are ignored.
- Instagram allows free-form replies only within 24 hours of the person's last message.

See [Channels](index.md) for commands, channel tools and attachment limits.

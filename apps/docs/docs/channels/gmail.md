---
title: Gmail
---

# Gmail

The Gmail channel runs the agent when mail reaches one inbox, and answers in the same thread. Replies are drafts a person reviews and sends from Gmail, unless `autoSend` is on.

Gmail cannot call a webhook directly. A Gmail watch publishes inbox changes to a Pub/Sub topic, and a push subscription on that topic posts to the Broods webhook. Broods starts the watch when the channel is deployed and renews it every day, because a watch lapses after seven days.

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com), create or pick a project and enable the **Gmail API** and the **Cloud Pub/Sub API**.
2. Under **Google Auth Platform**, set up the consent screen. Choose **Internal** when the mailbox is in your Google Workspace: an External app in testing loses its refresh token after seven days. Add the scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.compose`.
3. Create an OAuth client of type **Web application** with `https://developers.google.com/oauthplayground` as a redirect URI. In the [OAuth Playground](https://developers.google.com/oauthplayground), open the settings, tick **Use your own OAuth credentials**, authorize both scopes signed in as the mailbox, and exchange the code for a refresh token.
4. Create the topic and let Gmail publish to it:

   ```bash
   gcloud pubsub topics create gmail
   gcloud pubsub topics add-iam-policy-binding gmail \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

5. Create a service account for the push subscription to sign as, for example `gmail-push@my-project.iam.gserviceaccount.com`. It needs no roles.
6. Store the secrets:

   ```bash
   broods env set GMAIL_CLIENT_SECRET
   broods env set GMAIL_REFRESH_TOKEN
   ```

7. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineGmailConnection, env } from "broods";

   export const gmail = defineGmailConnection({
     mailbox: "agent@example.com",
     clientId: "1234.apps.googleusercontent.com",
     clientSecret: env("GMAIL_CLIENT_SECRET"),
     refreshToken: env("GMAIL_REFRESH_TOKEN"),
     topicName: "projects/my-project/topics/gmail",
     subscription: "projects/my-project/subscriptions/gmail-push",
     serviceAccountEmail: "gmail-push@my-project.iam.gserviceaccount.com",
     allowedChannelIds: ["*"],
     allowedUserIds: ["boss@example.com"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [gmail],
   });
   ```

8. Run `broods dev` or `broods deploy` to get the webhook URL, `/v1/webhooks/{accountId}/gmail`.
9. Create the push subscription with that URL, authenticated as the service account from step 5:

   ```bash
   gcloud pubsub subscriptions create gmail-push --topic=gmail \
     --push-endpoint=<webhook URL> \
     --push-auth-service-account=gmail-push@my-project.iam.gserviceaccount.com
   ```

The push token's audience defaults to the push endpoint, which is what Broods checks. Set `audience` when the subscription names another one.

## Configuration

| Field                 | Required | Description                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------ |
| `mailbox`             | yes      | the address the refresh token was granted for                                        |
| `clientId`            | yes      | the OAuth client id                                                                  |
| `clientSecret`        | yes      | the OAuth client secret                                                              |
| `refreshToken`        | yes      | the mailbox's refresh token, with `gmail.readonly` and `gmail.compose`               |
| `topicName`           | yes      | `projects/{project}/topics/{name}`, where the watch publishes                        |
| `subscription`        | yes      | `projects/{project}/subscriptions/{name}`, the push subscription                     |
| `serviceAccountEmail` | yes      | the service account the push subscription signs as                                   |
| `audience`            | no       | the push token audience, when it is not the webhook URL                              |
| `autoSend`            | no       | `true` sends replies instead of leaving drafts. Needs a list of senders, not `["*"]` |
| `allowedChannelIds`   | no       | the mailbox, or `["*"]`                                                              |
| `allowedUserIds`      | yes      | sender addresses allowed to trigger the agent, or `["*"]` for anyone                 |
| `trace`               | no       | `"enabled"` adds the dashboard trace link to replies                                 |
| `partition`           | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                    |

Rules for the mailbox go on a channel:

```ts
export const inbox = defineGmailChannel({
  name: "inbox",
  connection: gmail,
  mailbox: "agent@example.com",
});
```

## What works

- New inbox mail from anyone on `allowedUserIds`. Mail the mailbox sent itself is skipped. A `From` header is easy to forge, so with a list other than `["*"]` a sender also needs Gmail to have authenticated their domain: DMARC passing for it, or a DKIM signature from it. Mail from a domain with neither, including your own Workspace domain until DKIM is set up for it, is skipped.
- Each Gmail thread is its own conversation, so a reply in the thread continues it.
- The agent reads the sender, subject, date and plain-text body, with long bodies cut at 20,000 characters.
- Replies go into the thread as drafts, or as sent mail with `autoSend: true`. Each reply the agent posts is its own draft. A reply goes to the sender the allow list checked, never to a `Reply-To` address.
- With a list of senders, the inbox search only asks Gmail for their mail, so mail from anyone else is never read.

What does not:

- No attachments in either direction. The agent is told how many arrived.
- No typing indicator, reactions or chat commands.
- A push reads mail from ten minutes before Gmail published it. A push that Pub/Sub redelivers more than a day late reads only the last day. One push reads at most 20 new messages; a larger burst logs a warning and the rest are left unread.
- One mailbox holds one watch, on one topic. Stages that share a mailbox share that topic, with one push subscription per stage's webhook URL. A mailbox removed from every agent keeps publishing until its watch lapses, within seven days.

Email is untrusted input: anyone who can reach the mailbox can write to the agent. Keep `allowedUserIds` narrow, and leave `autoSend` off unless replies need no review. Broods refuses `autoSend` with `["*"]`, since the agent would then answer anyone automatically.

See [Channels](index.md) for channel tools and records.

---
title: Google Chat
---

# Google Chat

The Google Chat channel answers direct messages and @-mentions in spaces, through a Chat app on an HTTP endpoint. Replies post as the app's service account.

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com), create or pick a project and enable the **Google Chat API**.
2. Under **IAM & Admin > Service Accounts**, create a service account, then **Keys > Add key > JSON**. Keep the downloaded file.
3. Store the key file's contents:

   ```bash
   broods env set GCHAT_SERVICE_ACCOUNT_KEY < service-account.json
   ```

4. Define the connection. Pick the audience you will choose in step 6:

   ```ts title="broods/index.ts"
   import { defineAgent, defineGoogleChatConnection, env } from "broods";

   export const gchat = defineGoogleChatConnection({
     credentials: env("GCHAT_SERVICE_ACCOUNT_KEY"),
     googleChatProjectNumber: "123456789012",
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [gchat],
   });
   ```

5. Run `broods dev` or `broods deploy` to get the webhook URL, `/v1/webhooks/{accountId}/gchat`.
6. Open the [Chat API configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat). Fill in the app name, avatar and description, turn on **Receive 1:1 messages** and **Join spaces and group conversations**, and under **Connection settings** pick **HTTP endpoint URL** and paste the webhook URL. Under **Authentication audience**:
   - **Project number**: set `googleChatProjectNumber` to the project number from the console dashboard.
   - **HTTP endpoint URL**: set `endpointUrl` to the webhook URL.
7. Set **Visibility** to the people or groups who may add the app, and save.

An app built as a Google Workspace add-on signs its requests as its own add-on service account. Set `workspaceAddOnServiceAccountEmail` to `service-{projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, with `endpointUrl` as the audience.

Google Chat stores one endpoint per app. Give each developer their own app to run stages side by side.

## Configuration

| Field                               | Required | Description                                                                         |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `credentials`                       | yes      | the service-account key JSON                                                        |
| `googleChatProjectNumber`           | yes\*    | audience when the app authenticates with **Project number**                         |
| `endpointUrl`                       | yes\*    | audience when the app authenticates with **HTTP endpoint URL**. Public `https` only |
| `workspaceAddOnServiceAccountEmail` | no       | the add-on identity, for an app built as a Workspace add-on                         |
| `userName`                          | no       | the app's display name                                                              |
| `allowedChannelIds`                 | no       | space names such as `spaces/AAAA1234`, or `["*"]` for every space                   |
| `allowedUserIds`                    | no       | user resource names such as `users/1234567890`                                      |
| `trace`                             | no       | `"enabled"` adds the dashboard trace link to replies                                |
| `partition`                         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                   |

\*One of `googleChatProjectNumber` and `endpointUrl` is required. Every event must carry a token Google signed for that audience, or it is refused.

Rules for one space go on a channel:

```ts
export const eng = defineGoogleChatChannel({
  name: "eng",
  connection: gchat,
  spaceName: "spaces/AAAA1234",
});
```

The space name is in the space's URL, after `/room/` as `spaces/<id>`.

## What works

- Direct messages, and messages that @-mention the app in a space. The mention is removed from the text the agent reads. Other space messages never reach the app.
- A space reply goes into the thread of the message. Each thread is its own conversation, and each direct-message space is one conversation.
- Text replies, formatted for Google Chat.
- Inbound attachments, read through the Chat API.
- `/new`, `/compact` and the other chat commands.

What does not:

- No typing indicator and no reactions. Google Chat has no typing API, and an app reacts only with a user's credentials.
- No outbound files. `send-files` posts links as text.
- No cards, buttons or streaming. The reply goes out once the turn ends.
- No Pub/Sub delivery, so the app cannot read every message in a space.

See [Channels](index.md) for commands, channel tools and attachment limits.

---
title: WhatsApp
---

# WhatsApp

The WhatsApp channel answers customers who message your business number, through the WhatsApp Business Cloud API. Every chat is one person talking to the number.

## Setup

1. In [Meta for Developers](https://developers.facebook.com/apps), create a Business app and add the **WhatsApp** product.
2. Under **WhatsApp > API Setup**, copy the **Phone number ID** of the number the agent answers on. It is an id, not the phone number.
3. In [Business Settings](https://business.facebook.com/settings), create a system user, give it the app and the WhatsApp account, and generate a token with `whatsapp_business_messaging`. The temporary token on the API Setup page expires within a day.
4. Under **App settings > Basic**, copy the **App secret**. Meta signs every delivery with it.
5. Pick a verify token, any random string. Meta sends it back once when you register the webhook.
6. Store the secrets:

   ```bash
   broods env set WHATSAPP_ACCESS_TOKEN
   broods env set WHATSAPP_APP_SECRET
   broods env set WHATSAPP_VERIFY_TOKEN
   ```

7. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineWhatsAppConnection, env } from "broods";

   export const whatsapp = defineWhatsAppConnection({
     accessToken: env("WHATSAPP_ACCESS_TOKEN"),
     appSecret: env("WHATSAPP_APP_SECRET"),
     phoneNumberId: "123456789012345",
     verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [whatsapp],
   });
   ```

   A customer's chat does not exist until they write, so a business number needs `allowedChannelIds: ["*"]`. Gate people with `allowedUserIds` instead.

8. Run `broods dev` or `broods deploy`. Under **WhatsApp > Configuration**, set the **Callback URL** to the printed URL, `/v1/webhooks/{accountId}/whatsapp`, and the **Verify token** to your verify token. Click **Verify and save**, then subscribe to the `messages` webhook field.

Meta stores one callback URL per app. Registering a stage URL moves all of the app's numbers to that stage. Several agents can share one app, each with its own `phoneNumberId`: each gets only its own number's messages. Messages for a number no agent owns are ignored.

## Configuration

| Field               | Required | Description                                                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `accessToken`       | yes      | system user token with `whatsapp_business_messaging`                                                       |
| `appSecret`         | yes      | checks the `X-Hub-Signature-256` header on every delivery                                                  |
| `phoneNumberId`     | yes      | the number the agent answers on                                                                            |
| `verifyToken`       | yes      | answers Meta's `hub.challenge` handshake when you register the webhook                                     |
| `apiVersion`        | no       | Graph API version, such as `v25.0`                                                                         |
| `apiUrl`            | no       | Graph API base URL. Public `https` only. Defaults to `graph.facebook.com`                                  |
| `allowedChannelIds` | no       | customer WhatsApp ids, or `["*"]` for everyone                                                             |
| `allowedUserIds`    | no       | WhatsApp ids allowed to trigger the agent. A WhatsApp id is the number, digits only, with the country code |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                                                       |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                                          |

Rules for one customer go on a channel:

```ts
export const vip = defineWhatsAppChannel({
  name: "vip",
  connection: whatsapp,
  waId: ["15551234567", "15557654321"],
  instructions: "These are priority customers.",
});
```

## What works

- Text in both directions. Markdown is converted to WhatsApp formatting, and long replies are split at 4096 characters.
- Inbound pictures, documents, audio, voice notes, video and stickers. Broods reads them through the Graph API with the access token. A caption arrives as the message text.
- Taps on reply buttons and list rows arrive as the button's label.
- A delivery Meta batches runs every message for the agent's number, each as its own turn, in order.
- Outbound pictures and documents. Workspace files are uploaded, and a public `https` URL is passed to Meta as a link.
- Typing indicator. It also marks the customer's message as read.
- Reactions, only when the agent calls `send-reactions`. An accepted message gets no automatic reaction.
- `/new`, `/compact` and the other chat commands.

What does not:

- Replies must fall inside WhatsApp's 24-hour customer service window. A deferred reply or a `send-message` to a customer who wrote more than 24 hours ago is refused by Meta. Template messages are not supported.
- No streaming. The reply goes out once the turn ends.
- Group chats. The Cloud API has none.

See [Channels](index.md) for commands, channel tools and attachment limits.

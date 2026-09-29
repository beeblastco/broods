---
title: Twilio SMS
---

# Twilio SMS

The Twilio channel answers text messages sent to a Twilio number, over SMS and MMS. Every conversation is one person texting one number.

## Setup

1. In the [Twilio Console](https://console.twilio.com), buy or pick a number with SMS enabled. Copy your **Account SID** and **Auth Token** from the account dashboard.
2. Store both:

   ```bash
   broods env set TWILIO_ACCOUNT_SID
   broods env set TWILIO_AUTH_TOKEN
   ```

3. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineTwilioConnection, env } from "broods";

   export const sms = defineTwilioConnection({
     accountSid: env("TWILIO_ACCOUNT_SID"),
     authToken: env("TWILIO_AUTH_TOKEN"),
     phoneNumber: "+15550001111",
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [sms],
   });
   ```

   A person's conversation does not exist until they text, so a number needs `allowedChannelIds: ["*"]`. Gate people with `allowedUserIds` instead.

4. Run `broods dev` or `broods deploy`. In the Console, open **Phone Numbers > Active numbers**, pick the number, and under **Messaging configuration** set **A message comes in** to **Webhook**, the printed URL `/v1/webhooks/{accountId}/twilio`, and **HTTP POST**. For a Messaging Service, set the same URL under the service's **Integration** step instead.

Enter the URL exactly as printed, with no trailing slash. Twilio signs the full URL it calls, and Broods rebuilds that URL from its public address and the request path to check the signature. When Twilio calls a different address, such as your own proxy in front of Broods, put that exact URL in `webhookUrl`.

Twilio stores one webhook per number. Pointing a number at a stage URL moves all of its messages to that stage.

## Configuration

| Field                 | Required | Description                                                                                                      |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `accountSid`          | yes      | the `AC...` account SID                                                                                          |
| `authToken`           | yes      | signs every webhook (`X-Twilio-Signature`) and authenticates replies                                             |
| `phoneNumber`         | no       | E.164 number, such as `+15550001111`. Messages to any other number on the same URL are ignored                   |
| `messagingServiceSid` | no       | `MG...` sid. Replies go through the service instead of from the number the person texted                         |
| `webhookUrl`          | no       | the URL Twilio calls, when it is not the Broods webhook URL. Public `https` only                                 |
| `statusCallbackUrl`   | no       | where Twilio posts delivery status for each reply. Public `https` only. Receipts sent to the webhook are ignored |
| `apiUrl`              | no       | Twilio API base URL. Public `https` only. Defaults to `api.twilio.com`                                           |
| `allowedChannelIds`   | no       | sender numbers, or `["*"]` for everyone                                                                          |
| `allowedUserIds`      | no       | sender numbers allowed to trigger the agent, in E.164                                                            |
| `trace`               | no       | `"enabled"` adds the dashboard trace link to replies                                                             |
| `partition`           | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                                                |

Rules for one sender go on a channel:

```ts
export const vip = defineTwilioChannel({
  name: "vip",
  connection: sms,
  from: ["+15551234567", "+15557654321"],
  instructions: "These are priority customers.",
});
```

## What works

- Text in both directions. Replies longer than 1600 characters, the Twilio limit, go out as several messages. SMS has no formatting, so Markdown arrives as typed, asterisks included. Ask the agent for plain text in its instructions.
- Inbound MMS pictures, audio and video. Broods downloads them from Twilio with the account credentials. The message text arrives with them.
- Outbound pictures over MMS. Twilio fetches each picture itself, so it must be a public URL. Workspace files go out as durable media links.
- `/new`, `/compact` and the other chat commands.

What does not:

- No typing indicator and no reactions. SMS has neither.
- No documents. `send-files` posts links as text.
- MMS works on US and Canadian numbers only. Elsewhere Twilio refuses pictures and `send-images` falls back to links.
- No streaming. The reply goes out once the turn ends.
- Voice calls and WhatsApp through Twilio are not handled.

See [Channels](index.md) for commands, channel tools and attachment limits.

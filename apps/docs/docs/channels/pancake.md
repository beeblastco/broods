---
title: Pancake
---

# Pancake

Pancake is a customer service inbox. The Pancake channel answers inbox messages, which Pancake calls `INBOX`, and post or page comments, which it calls `COMMENT`.

## Setup

1. In Pancake, create a page access token for your page and note the page id. Pick a random webhook secret.
2. Store the values:

   ```bash
   broods env set PANCAKE_PAGE_ID
   broods env set PANCAKE_PAGE_ACCESS_TOKEN
   broods env set PANCAKE_WEBHOOK_SECRET
   ```

3. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, definePancakeConnection, env } from "broods";

   export const pancake = definePancakeConnection({
     pageId: env("PANCAKE_PAGE_ID"),
     pageAccessToken: env("PANCAKE_PAGE_ACCESS_TOKEN"),
     webhookSecret: env("PANCAKE_WEBHOOK_SECRET"),
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [pancake],
   });
   ```

   Customer conversations are not known in advance, so a Pancake connection usually sets `allowedChannelIds: ["*"]`. Use `definePancakeChannel` with a `conversationId` to give one conversation its own rules.

4. Run `broods dev` or `broods deploy`. Register the printed webhook URL in Pancake with the secret as a query parameter:

   ```text
   https://gateway.broods.app/v1/webhooks/<accountId>/pancake?secret=<webhookSecret>
   ```

   Pancake does not sign webhooks, so the secret rides on the URL. A request without a matching `secret` gets `401`.

## Configuration

| Field               | Required | Description                                                       |
| ------------------- | -------- | ----------------------------------------------------------------- |
| `pageId`            | yes      | Pancake page id                                                   |
| `pageAccessToken`   | yes      | page access token for API calls                                   |
| `webhookSecret`     | yes      | random value checked on every webhook request                     |
| `senderId`          | no       | Pancake staff user the replies appear to come from                |
| `allowedChannelIds` | no       | extra conversation ids, or `["*"]` for every conversation         |
| `allowedUserIds`    | no       | customer ids allowed to trigger the agent. Everyone when omitted  |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies              |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md) |

Pancake has no chat commands. Slash text reaches the agent as ordinary input. Inbound photos and videos arrive as attachments. Pancake gets no reactions.

## Human handoff

To let staff take over a conversation, tag it in Pancake and drop tagged messages in an `onMessageReceived` [code hook](../guides/hooks.md). Every inbound message carries the conversation's tag ids on `event.source.tagIds`.

```ts title="broods/index.ts"
export const myAgent = defineAgent({
  name: "my-agent",
  connections: [pancake],
  hooks: {
    onMessageReceived: (ctx, event) => {
      if (event.channel !== "pancake") return undefined;
      const handoffTagIds = ["order-tag", "pending-tag"];
      const tagIds = event.source.tagIds ?? [];

      return tagIds.some((tagId) => handoffTagIds.includes(tagId))
        ? { drop: true }
        : undefined;
    },
  },
});
```

Narrowing on `event.channel` gives `event.source` the Pancake type. Remove the tag in Pancake and the next customer message runs the agent again.

Hooks run in an isolated sandbox with no imports and no closure variables, so write the tag ids inline rather than reading them from a variable or env.

See [Channels](index.md) for channel tools and shared behavior.

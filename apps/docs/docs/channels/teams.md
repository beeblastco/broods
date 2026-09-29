---
title: Microsoft Teams
---

# Microsoft Teams

The Teams channel answers personal chats, group chats and team channels through a bot registered in Azure Bot Service.

## Setup

1. In the [Azure portal](https://portal.azure.com), create an **Azure Bot**. Pick **Single Tenant** for your own organization, or **Multi Tenant** for a bot other organizations install. Let it create a new app registration.
2. On the bot's **Configuration** page, copy the **Microsoft App ID** and, for a single-tenant bot, the **App Tenant ID**.
3. Open the app registration from **Manage Password**, add a client secret under **Certificates & secrets**, and copy its value.
4. Store the secret:

   ```bash
   broods env set TEAMS_APP_PASSWORD
   ```

5. Define the connection:

   ```ts title="broods/index.ts"
   import { defineAgent, defineTeamsConnection, env } from "broods";

   export const teams = defineTeamsConnection({
     appId: "00000000-0000-0000-0000-000000000000",
     appPassword: env("TEAMS_APP_PASSWORD"),
     appTenantId: "11111111-1111-1111-1111-111111111111",
     allowedChannelIds: ["*"],
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [teams],
   });
   ```

6. Run `broods dev` or `broods deploy`. On the bot's **Configuration** page, set the **Messaging endpoint** to the printed URL, `/v1/webhooks/{accountId}/teams`.
7. Under **Channels**, add **Microsoft Teams**.
8. In the [Teams Developer Portal](https://dev.teams.microsoft.com/apps), create an app, add a bot feature with your App ID, choose the scopes it works in (personal, team, group chat), and install it.

Azure stores one messaging endpoint per bot. Give each developer their own bot to run stages side by side.

## Configuration

| Field               | Required | Description                                                                  |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `appId`             | yes      | Microsoft App ID. Inbound tokens must name it as their audience              |
| `appPassword`       | yes      | client secret of the app registration                                        |
| `appTenantId`       | yes\*    | directory (tenant) id. \*Not needed when `appType` is `"MultiTenant"`        |
| `appType`           | no       | `"SingleTenant"` (default) or `"MultiTenant"`                                |
| `apiUrl`            | no       | Bot Framework service URL for replies. Defaults to `smba.trafficmanager.net` |
| `userName`          | no       | the bot's display name                                                       |
| `allowedChannelIds` | no       | channel ids or chat conversation ids, or `["*"]` for everywhere              |
| `allowedUserIds`    | no       | Entra object ids of people allowed to trigger the agent                      |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                         |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)            |

Every activity must carry a Bot Framework token signed by Microsoft for `appId`, and the token's service URL must match the activity's. Certificate and managed-identity sign-in are not supported. Only the public Microsoft cloud is supported.

Rules for one channel go on a channel:

```ts
export const support = defineTeamsChannel({
  name: "support",
  connection: teams,
  channelId: "19:abc123@thread.tacv2",
  teamId: "19:def456@thread.tacv2",
});
```

A channel id is in the channel's link, under **Get link to channel**.

## What works

- In a team channel or group chat, Teams delivers only messages that @mention the bot. The mention is removed from the text the agent reads. In a personal chat, every message reaches it.
- A channel reply goes into the thread of the message that mentioned the bot. Each thread is its own conversation.
- Text replies in Markdown.
- Inbound files and pictures. Files shared in a channel are read with the bot's credentials.
- Typing indicator.
- `/new`, `/compact` and the other chat commands.

What does not:

- No reactions.
- No outbound files. `send-files` posts links as text.
- No Adaptive Cards, buttons or streaming. The reply goes out once the turn ends.
- Only Teams. Web Chat, Direct Line and other Azure Bot channels are acknowledged and ignored.

See [Channels](index.md) for commands, channel tools and attachment limits.

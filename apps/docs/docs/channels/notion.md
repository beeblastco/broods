---
title: Notion
---

# Notion

The Notion channel answers comments on Notion pages that address the agent. The agent replies in the same discussion, as the integration.

## Setup

1. Open [Notion integrations](https://www.notion.so/profile/integrations) and create an internal integration for your workspace. Under **Capabilities**, turn on **Read content**, **Read comments** and **Insert comments**. Copy the **Internal Integration Secret**.
2. Share each page the agent should see with the integration: open the page, then **⋯ > Connections** and add it.
3. Store the secret:

   ```bash
   broods env set NOTION_TOKEN
   ```

4. Define the connection:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineNotionChannel,
     defineNotionConnection,
     env,
   } from "broods";

   export const notion = defineNotionConnection({
     token: env("NOTION_TOKEN"),
     userName: "acme-agent",
   });

   export const roadmap = defineNotionChannel({
     name: "roadmap",
     connection: notion,
     pageId: "1f2e3d4c00004000800000000000000a",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [notion],
   });
   ```

   `pageId` is the 32 hex digits at the end of the page URL. Hyphens are optional. Use `allowedChannelIds: ["*"]` on the connection to answer on every page shared with the integration.

5. Run `broods dev` or `broods deploy`. In the integration's **Webhooks** tab, create a subscription with the printed URL `/v1/webhooks/{accountId}/notion` and the **Comment created** event.
6. Notion sends a verification token to that URL once. A connection with no `verificationToken` yet writes it to the agent's logs as a `WARN` line. Read it with `broods logs` or in the dashboard, paste it into the subscription's **Verify** dialog, then store it and redeploy:

   ```bash
   broods env set NOTION_VERIFICATION_TOKEN
   ```

   ```ts
   export const notion = defineNotionConnection({
     token: env("NOTION_TOKEN"),
     verificationToken: env("NOTION_VERIFICATION_TOKEN"),
     userName: "acme-agent",
   });
   ```

Notion signs every event with the verification token. Until it is set, the connection takes the handshake and refuses everything else. Notion locks the URL once a subscription is verified. To move it, delete the subscription, remove `verificationToken`, and repeat steps 5 and 6.

## Configuration

| Field               | Required | Description                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `token`             | yes      | the integration secret. Reads the comment each event names and posts replies                       |
| `verificationToken` | yes      | the key Notion signs events with (`X-Notion-Signature`). Set it after the handshake in step 6      |
| `userName`          | no       | plain-text name that addresses the agent, as `@userName`. Defaults to `notion-bot`                 |
| `mentionMode`       | no       | `mention` (default) answers `@userName`, `all-comments` every comment, `keyword` any of `keywords` |
| `keywords`          | no       | words that address the agent when `mentionMode` is `keyword`                                       |
| `apiBaseUrl`        | no       | Notion API base URL. Public `https` only. Defaults to `https://api.notion.com/v1`                  |
| `allowedChannelIds` | no       | page ids, or `["*"]` for every page shared with the integration                                    |
| `allowedUserIds`    | no       | Notion user ids allowed to trigger the agent. Everyone when omitted                                |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                                               |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                                  |

Notion's comment box cannot @-mention an integration, so people type `@acme-agent` as plain text.

## What works

- A new comment that addresses the agent runs it. Comments written by an integration, the agent's own replies included, do not.
- Each discussion is its own conversation, and the reply joins it.
- Files attached to the comment reach the agent.

What does not:

- No reactions and no typing indicator. Notion's API has neither for comments.
- No streaming. The answer is posted as one comment once the turn ends. A long answer is split over several comments in the discussion.
- No outbound files. Pictures and documents travel as links in the text.
- Edits and deletions of comments are ignored.
- The agent sees the comment only, not the page it sits on.
- Slash text is passed to the agent as input, as on GitHub.

See [Channels](index.md) for channel tools and shared behavior.

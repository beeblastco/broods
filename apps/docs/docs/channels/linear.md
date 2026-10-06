---
title: Linear
---

# Linear

The Linear channel answers comments on Linear issues that mention the agent. The agent comments back as a Linear member, through that member's personal API key.

## Setup

1. Pick the Linear member the agent comments as. A dedicated member, such as `acme-agent`, keeps its comments apart from a person's own. Signed in as that member, open **Settings > Account > Security & access** and create a personal API key.
2. As a workspace admin, open **Settings > API > Webhooks** and create a webhook. Leave the URL for step 5. Under data change events, select **Comments**. Copy the signing secret.
3. Store both:

   ```bash
   broods env set LINEAR_API_KEY
   broods env set LINEAR_WEBHOOK_SECRET
   ```

4. Define the connection and the teams it answers in:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineLinearChannel,
     defineLinearConnection,
     env,
   } from "broods";

   export const linear = defineLinearConnection({
     apiKey: env("LINEAR_API_KEY"),
     webhookSecret: env("LINEAR_WEBHOOK_SECRET"),
     userName: "acme-agent",
   });

   export const engineering = defineLinearChannel({
     name: "engineering",
     connection: linear,
     team: "ENG",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [linear],
   });
   ```

   `userName` is the member's display name, the name after `@` in a mention and at the end of its profile URL. Use `allowedChannelIds: ["*"]` on the connection to answer on every team.

5. Run `broods dev` or `broods deploy` and paste the printed URL `/v1/webhooks/{accountId}/linear` into the webhook from step 2.

## Configuration

| Field               | Required | Description                                                                         |
| ------------------- | -------- | ----------------------------------------------------------------------------------- |
| `apiKey`            | yes      | personal API key of the member the agent comments as                                |
| `webhookSecret`     | yes      | the webhook's signing secret. Checks `Linear-Signature` on every delivery           |
| `userName`          | yes      | the member's display name. `@userName` addresses the agent                          |
| `apiUrl`            | no       | GraphQL endpoint. Public `https` only. Defaults to `https://api.linear.app/graphql` |
| `allowedChannelIds` | no       | team keys, such as `ENG`, or `["*"]` for every team                                 |
| `allowedUserIds`    | no       | Linear user ids (UUIDs) allowed to trigger the agent. Everyone when omitted         |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                                |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                   |

A delivery signed more than a minute before it arrives is refused, so a captured webhook cannot be replayed.

## What works

- A new comment on an issue that mentions `@userName` runs the agent. Other comments, edits, and the agent's own comments do not.
- The agent sees the issue identifier, title and URL with the comment.
- The reply nests under the comment's thread. Each root comment is its own conversation.
- The agent reacts with 👀 to the comment that called it, and `send-reactions` works on it.

What does not:

- No agent sessions. Linear's agent mode needs an OAuth app installed with `actor=app`, and its tokens expire after a day or a month. Refreshing them needs state kept between requests, which the channel does not have, so only personal API keys are supported.
- No typing indicator. Linear shows one only inside agent sessions.
- No streaming. The answer is posted as one comment once the turn ends, because every edit of a comment would come back to Broods as another webhook.
- No inbound or outbound files. Pictures and documents travel as links in the text.
- Comments on project updates and documents are ignored. Only issue comments reach the agent.
- Slash text is passed to the agent as input, as on GitHub.

See [Channels](index.md) for channel tools and shared behavior.

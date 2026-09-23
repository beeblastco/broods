---
title: GitHub
---

# GitHub

A GitHub App puts your agent in issues, pull requests and their comment threads.

## Setup

1. Create a GitHub App under your org or account settings. Give it read and write access to Issues and Pull requests, and subscribe it to the events listed below. Generate a private key and pick a webhook secret.
2. Store the credentials:

   ```bash
   broods env set GITHUB_APP_ID
   broods env set GITHUB_PRIVATE_KEY
   broods env set GITHUB_WEBHOOK_SECRET
   ```

3. Define the connection and the repositories it answers in:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineGitHubChannel,
     defineGitHubConnection,
     env,
   } from "broods";

   export const github = defineGitHubConnection({
     webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
     appId: env("GITHUB_APP_ID"),
     privateKey: env("GITHUB_PRIVATE_KEY"),
     botUserName: "my-bot[bot]",
   });

   export const platform = defineGitHubChannel({
     name: "platform",
     connection: github,
     repo: "owner/repo",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [github],
   });
   ```

4. Run `broods dev` or `broods deploy` and set the printed URL as the App's webhook URL.
5. Install the App on the repositories it should see.

The App's install list already limits which repositories reach the agent, so `allowedChannelIds: ["*"]` on the connection is a common choice here.

## Configuration

| Field                | Required | Description                                                                         |
| -------------------- | -------- | ----------------------------------------------------------------------------------- |
| `webhookSecret`      | yes      | GitHub App webhook secret                                                           |
| `appId`              | yes      | GitHub App ID                                                                       |
| `privateKey`         | yes      | GitHub App private key                                                              |
| `botUserName`        | no       | bot login for mention detection, such as `my-bot` or `my-bot[bot]`                  |
| `botUserId`          | no       | bot's numeric user id, used to ignore its own comments. Looked up when omitted      |
| `triggerOnIssueOpen` | no       | `false` stops auto-runs on issues opened, edited or reopened. Default `true`        |
| `triggerOnPROpen`    | no       | `false` stops auto-runs on pull requests opened, edited or reopened. Default `true` |
| `apiUrl`             | no       | API base URL, for GitHub Enterprise. Must be public `https`                         |
| `allowedChannelIds`  | no       | extra repositories as `owner/repo`, or `["*"]` for every installed repository       |
| `allowedUserIds`     | no       | GitHub logins allowed to trigger the agent. Everyone when omitted                   |
| `trace`              | no       | `"enabled"` adds the dashboard trace link to replies                                |
| `partition`          | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                   |

## Events

| Event                         | Actions                                    |
| ----------------------------- | ------------------------------------------ |
| `issues`                      | `opened`, `edited`, `reopened`, `assigned` |
| `pull_request`                | `opened`, `edited`, `reopened`, `assigned` |
| `issue_comment`               | `created`, including pull request comments |
| `pull_request_review_comment` | `created`                                  |

With `botUserName` set, a comment runs the agent only when it mentions `@botUserName`. Without it, every human comment runs the agent.

`triggerOnIssueOpen` and `triggerOnPROpen` only cover `opened`, `edited` and `reopened`. Assigning the bot always triggers it. So you can turn both off and still call the bot in by assigning it.

## Context and replies

When a comment triggers the agent, Broods fetches the issue or pull request title, body and earlier comments and adds them as context for that turn. An agent tagged halfway through a thread sees what came before. The triggering comment is still the user message.

The answer is posted as one Markdown comment once the model finishes. GitHub has no live message editing, so there is no streaming. Slash text is passed to the agent as input, and the agent cannot send files or pictures except as links.

Each issue or pull request is its own conversation. With a `partition` of `{ by: "conversation" }`, closing the issue or pull request deletes its workspace folder. See [Workspaces](../guides/workspaces.md).

See [Channels](index.md) for channel tools and shared behavior.

---
title: Support
description: Where to get help with Broods and how fast to expect an answer.
---

# Support

| Need                                             | Go to                                                                                                                | Response                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A question, or help getting an agent running     | [Discord](https://discord.gg/F48633Uca)                                                                              | Usually the same day, weekdays        |
| A bug or a feature request                       | [GitHub issues](https://github.com/beeblastco/broods/issues)                                                         | Triaged within 5 business days        |
| A security vulnerability                         | [GitHub private vulnerability reporting](https://github.com/beeblastco/broods/security). Do not open a public issue. | First response within 5 business days |
| Billing, account access, data export or deletion | [business@beeblast.co](mailto:business@beeblast.co)                                                                  | Within 5 business days                |

## By area

| Area                           | Read first                                                       | Include when you ask                                 |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| Agents, models and runs        | [Agents](/guides/agents)                                         | Agent name, stage, the time of the run               |
| Tools and MCP servers          | [Tools](/guides/tools)                                           | The tool name and the error from the Traces tab      |
| Sandboxes and workspaces       | [Sandboxes](/guides/sandboxes), [Workspaces](/guides/workspaces) | The sandbox provider and the instance id             |
| Channels                       | [Channels](/channels)                                            | The channel type and when the message was sent       |
| CLI, SDK and deploying         | [CLI reference](/reference/cli), [Deploying](/guides/deploying)  | `broods --version` and the full command output       |
| HTTP API                       | [API reference](/reference/http-api)                             | The route, the status code and the `error.code`      |
| Plans, limits and invoices     | Usage and billing in the dashboard                               | Your organization name. Email, not Discord           |
| Security and data              | [Security](/guides/security), [Privacy Policy](/privacy)         | Nothing secret. Use private reporting for a weakness |
| Running Broods on your own box | [Self-hosting](/internals/self-hosting)                          | Your version and how the stack is deployed           |

## Before you ask

- The [quickstart](/quickstart) answers most first-day questions.
- `broods logs --stage <stage>` and the Traces tab in the dashboard show what an agent did and why a run failed.
- Never paste API keys, account secrets or deploy keys.

## Status

Incidents are announced in Discord. There is no separate status page yet.

Legal pages: [Terms of Service](/terms) and [Privacy Policy](/privacy).

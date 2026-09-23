---
slug: /
title: Broods docs
sidebar_label: Overview
---

# Broods

Broods runs AI agents for you. You describe an agent in TypeScript, with its model, its tools, where it runs code, and which chat apps it answers in. `broods deploy` puts it in the cloud. You then call it from your app, a terminal, Slack, Telegram, or a schedule.

```ts title="broods/index.ts"
import { defineAgent, env } from "broods";

export const support = defineAgent({
  name: "support",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  agent: { system: "You answer customer questions about our product." },
  publicAccess: true,
});
```

```bash
broods dev                       # sync to your development stage, watch for changes
broods run support "Hi there"    # chat with it in the terminal
```

## What you get

- Agents with any AI SDK model provider, streaming, structured output, and reasoning.
- Sandboxes where the agent runs `bash`, Python and Node. They run on Broods-hosted Firecracker VMs, AWS Lambda MicroVMs, Daytona, E2B, Vercel, or your own computer.
- Workspaces with persistent files and memory. They survive between runs and several agents can share one.
- Channels for Telegram, Slack, Discord, GitHub, Matrix, Pancake and Zalo, with one webhook per account.
- Tools from your model provider or any MCP server, including servers Broods hosts for you.
- Skills, subagents, cron jobs, code hooks, lifecycle webhooks, and policies.
- A typed SDK, a raw HTTP and WebSocket API, a CLI, and a dashboard for logs, traces and config.

## Start here

| If you want to                                  | Read                                        |
| ----------------------------------------------- | ------------------------------------------- |
| Deploy your first agent in five minutes         | [Quickstart](quickstart.md)                 |
| Understand projects, stages, agents and keys    | [Concepts](concepts.md)                     |
| Configure an agent's model, prompt and behavior | [Agents](guides/agents.md)                  |
| Let the agent run code or keep files            | [Sandboxes](guides/sandboxes/index.md)      |
| Put the agent in Slack, Telegram or Discord     | [Channels](channels/index.md)               |
| Call the agent from your app                    | [SDK reference](reference/sdk.md)           |
| Call it from another language                   | [HTTP API](reference/http-api.md)           |
| Look up a CLI command                           | [CLI reference](reference/cli.md)           |
| Look up every config field                      | [Configuration](reference/configuration.md) |
| Self-host or contribute to Broods               | [Internals](internals/index.md)             |

Runnable examples for most features live in [`packages/demos`](https://github.com/beeblastco/broods/tree/dev/packages/demos).

## Get help

Ask on [Discord](https://discord.gg/F48633Uca) or open an issue on [GitHub](https://github.com/beeblastco/broods).

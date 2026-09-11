---
id: home
title: Broods Developer Docs
slug: /
---

# Welcome to Broods

Broods is a serverless AI agent platform. Define agents, workspaces, sandboxes, skills, and channels as typed TypeScript resources, sync them to the cloud with a CLI, and invoke them over a typed SDK or raw HTTP.

## Quick start

- [Getting Started](getting-started.md). Install the CLI, define your first agent, and run it in 5 minutes.
- [Resource Configuration](resources.md). Full reference for `defineAgent`, `defineSandbox`, channels, skills, MCP servers, and cron jobs.
- [SDK & Runtime API](sdk.md). Typed SDK usage, curl equivalents, and WebSocket streaming.
- [API Reference](/api-reference). Interactive OpenAPI docs for all endpoints.

## Feature panels

- [Workspace & Sandbox](workspace/index.md). Persistent files, compute backends, and permission modes.
- [Skills](skills.md). Account-scoped instruction bundles and the runtime skill panel.
- [External Tools](tools.md). Provider-defined tools and MCP servers.
- [Sub Agents](sub-agents.md). Parallel child agents with parent continuation.
- [Channels](channels/index.md). Telegram, Discord, Slack, GitHub, Pancake, and Zalo.
- [Cron Jobs](crons.md). Scheduled agent runs.
- [Lifecycle Webhooks](webhook.md). Runtime event delivery.

## Architecture and operations

- [Architecture](architecture.md). The request path from gateway to sandbox, and where each record is stored.
- [Data Security](data-security.md). What is stored, what is encrypted, and who can read it.
- [Deployment](deployment.md). Self-hosted infrastructure setup.
- [CI/CD](ci-cd.md). GitHub Actions deployment and integration.

## Need help?

- [Discord](https://discord.gg/beeblast) for questions and bug reports.
- [GitHub](https://github.com/beeblastco/broods) for source code and issues.

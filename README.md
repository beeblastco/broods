# filthy-panty

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun)](https://bun.sh/)
[![SST](https://img.shields.io/badge/infra-SST%20v4-e27152)](https://sst.dev/)
[![Vercel AI SDK](https://img.shields.io/badge/AI%20SDK-Vercel-000000)](https://sdk.vercel.ai/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> An open, experimental serverless multi-account AI chatbot and agent harness on AWS Lambda.

`filthy-panty` is the reference implementation behind [BeeBlast](https://github.com/beeblastco) — a low-overhead, multi-tenant agent platform designed to let small teams ship production-grade AI agents without standing up Kubernetes, queues, or bespoke streaming infrastructure. It runs on Bun + AWS Lambda, persists state in DynamoDB and S3, and streams responses via SSE through Lambda Function URLs.

If you want to self-host a multi-agent backend, integrate AI into Telegram/Discord/Slack/GitHub, or learn how to build an agent harness on top of the Vercel AI SDK — this repo is for you.

---

## Features

- **Serverless by default** — two Lambda Function URLs, no API Gateway, no always-on containers.
- **Multi-tenant accounts** — each account has its own encrypted config, hashed API secret, and isolated runtime data.
- **Bring-your-own model** — Google, OpenAI, Bedrock, Vercel AI Gateway, and custom providers configured per account.
- **Multi-channel integrations** — Telegram, Discord, Slack, GitHub, Facebook Messenger (Pancake), and Zalo out of the box.
- **Workspaces & sandboxes** — S3-backed workspace files plus pluggable execution sandboxes (Lambda, E2B, Daytona, Kubernetes, Vercel).
- **Skills system** — account-scoped instruction bundles loaded on demand during a turn.
- **Subagents** — dispatch parallel one-shot child agents and inject their results back into the parent conversation.
- **Streaming-first** — SSE for sync direct API callers and a NATS JetStream path for WebSocket gateways.
- **Async + cron** — long-running requests, status polling, and EventBridge-scheduled jobs.

---

## Architecture

The deployed system exposes two public Lambda Function URLs (plus a testing-only `mock-webhook-subscribe` URL):

- `account-manage` — account creation, secret rotation, and CRUD for account-owned agents, skills, sandboxes, and workspaces.
- `harness-processing` — streams agent responses, runs the model/tool loop, and serves account-scoped channel webhooks.

```mermaid
flowchart LR
  Admin["Account owner / admin"] -->|"create + configure account"| Manage["account-manage<br/>Function URL"]
  Client["Direct API client"] -->|"Bearer account secret<br/>POST / or /async"| Harness["harness-processing<br/>Function URL"]
  Status["Status poller"] -->|"Bearer account secret<br/>GET /status/{eventId}"| Harness
  Provider["Telegram / GitHub / Slack / Discord"] -->|"/webhooks/{accountId}/{agentId}/{channel}"| Harness

  Manage --> Accounts["DynamoDB<br/>AccountConfig"]
  Manage --> Agents["DynamoDB<br/>AgentConfig"]
  Manage --> Skills["S3<br/>Skills"]
  Harness --> Accounts
  Harness --> Agents
  Harness --> Skills
  Harness --> Conversations["DynamoDB<br/>Conversations / ProcessedEvents / AsyncAgentResult / AsyncToolResult"]
  Harness --> Workspace["S3<br/>workspace files"]
  Harness --> Model["Configured model<br/>Vercel AI SDK"]
```

For the full architecture deep-dive — including account routing, the harness loop, subagent dispatch, and the NATS streaming gateway — see [`docs/architecture.md`](docs/architecture.md).

---

## Tech Stack

| Layer | Choice |
| --- | --- |
| Runtime | Bun on Lambda `provided.al2023` (ARM64 binaries) |
| Infra-as-code | [SST v4](https://sst.dev/) on Pulumi |
| Model SDK | [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` package) |
| Providers | Google, OpenAI, Bedrock, Vercel AI Gateway, custom |
| Persistence | DynamoDB (config + conversations; the production stage stores config domains in Convex) + S3 (files + skills) |
| Streaming | SSE via Lambda Function URL (`RESPONSE_STREAM` invoke mode); NATS JetStream for WebSocket fan-out |
| Docs | Docusaurus |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) `>= 1.3`
- An AWS account with credentials configured (`AWS_PROFILE`)
- [SST](https://sst.dev/) — installed automatically via `bun install`

### 1. Clone & install

```bash
git clone https://github.com/beeblastco/filthy-panty.git
cd filthy-panty
bun install
cp .env.example .env
```

### 2. Set SST secrets

```bash
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
```

### 3. Deploy

```bash
bun run deploy
```

Note the two Function URLs from the deploy output (`accountServiceUrl`, `agentServiceUrl`), then follow [`docs/getting-started.md`](docs/getting-started.md) to create your first account and agent.

### Run the examples

The [`examples/`](examples/) directory has runnable scripts for every major feature — streaming, async, tool approval, subagents, skills, sandboxes, multi-workspace setups, and more. Each script creates a temporary account, runs a smoke test, and cleans up.

```bash
bun examples/stream.ts        # SSE with tools
bun examples/async.ts         # Async with polling
bun examples/subagent.ts      # Subagent dispatch
bun examples/skills.ts        # Skill CRUD
```

---

## Documentation

Full documentation lives in [`docs/`](docs/) and is published via Docusaurus.

- **Core** — [Getting Started](docs/getting-started.md) · [Architecture](docs/architecture.md) · [Data Security](docs/data-security.md)
- **Features** — [Workspace](docs/workspace/index.md) · [Sandbox](docs/workspace/sandbox/index.md) · [Skills](docs/skills.md) · [Tools](docs/tools.md) · [Channels](docs/channels/index.md) · [Subagents](docs/sub-agents.md) · [Webhooks](docs/webhook.md) · [Cron Jobs](docs/cron-jobs.md)
- **Development** — [Extending](docs/extending.md) · [Deployment](docs/deployment.md) · [CI/CD](docs/ci-cd.md)
- **API Reference** — [OpenAPI spec](docs/api-reference/openapi.yaml) (served interactively on the docs site)

Preview the docs locally:

```bash
bun run docs
```

---

## Project Layout

```text
functions/
  account-manage/         # Account + agent + skill CRUD Lambda
  harness-processing/     # Streaming agent loop + channel webhooks Lambda
    tools/                # Built-in tools (googleSearch, tavily, etc.)
    integrations.ts       # Request normalization + channel routing
    harness.ts            # Model/tool execution loop
    session.ts            # Conversation state + prompt assembly
  _shared/                # Code shared between Lambdas (runtime, channels, accounts)
examples/                 # Runnable example scripts
docs/                     # Docusaurus documentation site
scripts/                  # Build, deploy, and operational scripts
sst.config.ts             # Single source of truth for infra
```

A more detailed map (with the routing contract between each module) lives in [`AGENTS.md`](AGENTS.md).

---

## Contributing

Contributions are very welcome! Whether you want to fix a bug, add a new channel, build a new tool, or improve the docs — open an issue first so we can align on the approach, then send a PR.

### Development workflow

```bash
bun install              # install deps
bun run check            # typecheck
bun run test             # unit tests (max-concurrency 1)
bun run build            # build all Lambda binaries
```

CI runs `check`, `test`, and `build` on every PR via [`.github/workflows/ci.yaml`](.github/workflows/ci.yaml). Pushes to `dev` deploy the `dev` stage and pushes to `main` deploy the `production` stage; PR branches never deploy.

### Conventions

- Bun + TypeScript, ESM, no transpile step.
- File header comments use a block-docstring style — see [`AGENTS.md`](AGENTS.md) for the full style guide.
- Channel-specific logic belongs in `functions/_shared/<channel>-channel.ts`; commands belong in `functions/_shared/commands.ts`.
- Shared code only goes in `functions/_shared/` when it's actually shared between Lambdas.
- Don't deploy to anyone else's stage — `dev` is the default.

### Reporting issues

- **Bugs / feature requests** — open a [GitHub issue](https://github.com/beeblastco/filthy-panty/issues).
- **Security vulnerabilities** — please email the maintainers privately rather than filing a public issue.

---

## Roadmap

Active plans live under [`docs/plans/`](docs/plans/). Recent and upcoming work includes:

- BeeBlast CLI and TypeScript SDK
- Expanded provider matrix (more first-class AI Gateway recipes)

Contributions to any of these are very welcome.

---

## Community

- [GitHub Discussions](https://github.com/beeblastco/filthy-panty/discussions) — questions, ideas, show-and-tell
- [Discord](https://discord.gg/beeblast) — chat with maintainers and other contributors
- [Issues](https://github.com/beeblastco/filthy-panty/issues) — bugs and feature requests

---

## License

[MIT](LICENSE.md) © beeblastco

This project is free for both personal and commercial use. If you build something cool on top of it, we'd love to hear about it.

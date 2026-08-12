# broods

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE.md)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun)](https://bun.sh/)
[![SST](https://img.shields.io/badge/infra-SST%20v4-e27152)](https://sst.dev/)

A serverless, multi-account AI agent harness built on Bun and AWS data-plane services. Configure agents, connect them to Telegram, Discord, Slack, GitHub, and more, and run them with your own model keys.

This is the open-source engine behind [Broods](https://github.com/beeblastco). The entire stack is self-hostable — you own your data, your AWS account, and your API keys.

---

## What It Is

- **Container agent runtime** — One Bun container handles account management, streaming agent execution, webhooks, async work, and cron runs behind the gateway.
- **Multi-tenant** — Each account has its own encrypted config, hashed API secret, and isolated data.
- **Bring your own model** — Google, OpenAI, AWS Bedrock, Vercel AI Gateway, or custom providers via the Vercel AI SDK.
- **Multi-channel** — Telegram, Discord, Slack, GitHub, Facebook Messenger (Pancake), and Zalo webhooks are built in.
- **Extensible** — Skills, subagents, workspaces, sandboxes, cron jobs, async tools, and custom uploaded tools.

---

## Quick Start

The fastest way to get running is the managed service via the Broods CLI and SDK:

```bash
# 1. Install the CLI (requires Bun)
bun add -g broods

# 2. Initialize your project
mkdir my-agents && cd my-agents
bunx broods init

# 3. Log in and set your model key
bunx broods login
bunx broods env set OPENAI_API_KEY

# 4. Sync to the cloud and run your first agent
bunx broods dev
bunx broods run my-agent "Hello!"
```

Check what a command will act on, and switch organization or stage:

```bash
bunx broods status                              # login, org, plan, project, stage
bunx broods org list                            # organizations you can select
bunx broods org use my-team                     # switch org, repoint BROODS_API_KEY
bunx broods stage create staging --from development   # clone a stage to work on
bunx broods stage use staging
```

See the [Getting Started guide](apps/docs/docs/getting-started.md) for the full walkthrough,
and the [CLI reference](apps/docs/docs/cli.md) for every command.

For self-hosted deployments, see the [Deployment guide](apps/docs/docs/deployment.md).

---

## Demos

After deploying, try the runnable demos in `packages/demos/`:

```bash
bun run --filter broods build   # once, from repo root
cp packages/demos/.env.example packages/demos/.env.local
cd packages/demos/basic-stream && bun run start
cd packages/demos/basic-async && bun run start
```

See `packages/demos/README.md` for the full list of demos and setup steps.

---

## Documentation

- [Getting Started](apps/docs/docs/getting-started.md) — Install the CLI, define your first agent, and run it in 5 minutes
- [Resource Configuration](apps/docs/docs/resources.md) — Full reference for `defineAgent`, `defineSandbox`, channels, skills, tools, and cron jobs
- [SDK & Runtime API](apps/docs/docs/sdk.md) — Typed SDK usage, curl equivalents, and WebSocket streaming
- [Architecture](apps/docs/docs/architecture.md) — How the platform works
- [Deployment](apps/docs/docs/deployment.md) — SST, secrets, and CI/CD
- [API Reference](apps/docs/docs/api-reference/openapi.yaml) — OpenAPI spec

Preview the docs locally:

```bash
bun run docs
```

---

## Contributing

Contributions are welcome. Open an issue first to align on the approach, then send a PR.
This checkout uses the Bun canary channel selected by `.bun-version`; run
`bun upgrade --canary` before the commands below until Bun 1.4 is stable.

```bash
bun install      # install all workspaces
bun run check    # typecheck core + convex + SDK + demos
bun run test     # core unit tests
bun run build    # build the core Bun container binary
```

CI runs on every PR via `.github/workflows/ci.yaml`.

---

## Community

- [Discord](https://discord.gg/beeblast) — Chat with contributors
- [GitHub Issues](https://github.com/beeblastco/broods/issues) — Bugs and feature requests

---

## License

Core server and application code is licensed under [FSL-1.1-Apache-2.0](LICENSE.md).
The `broods` npm package in `packages/broods` is licensed separately under MIT.

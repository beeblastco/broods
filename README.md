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

## Quick Start (Managed Service)

The fastest way to run agents is through the Broods CLI and SDK:

```bash
# 1. Install the CLI (requires Bun)
bun add -g broods

# 2. Initialize your project
mkdir my-agents && cd my-agents
broods init

# 3. Log in and set your model key
broods login
broods env set OPENAI_API_KEY

# 4. Sync to the cloud and run your first agent
broods dev
broods run my-agent "Hello!"
```

See the [Getting Started guide](apps/docs/docs/getting-started.md) for the full walkthrough.

## Quick Start (Self-Hosted)

```bash
# 1. Clone and install
bun install
cp apps/core/.env.example apps/core/.env
# Edit apps/core/.env and set AWS_ACCOUNT_ID, PROJECT_NAME, PROJECT_OWNER_EMAIL

# 2. Set required secrets
cd apps/core
bunx sst secret set AdminAccountSecret <random-value>
bunx sst secret set AccountConfigEncryptionSecret <random-value>

# 3. Deploy
bun run deploy
```

For self-hosted deployments, point `BROODS_HOST` or `BROODS_BASE_URL` at your gateway/core container URL.

---

## Project Layout

```text
apps/
  core/         # SST-provisioned AWS data plane + Bun container runtime
  dashboard/    # Next.js dashboard
  docs/         # Docusaurus docs
packages/
  convex/       # Shared Convex backend
  broods/ # CLI + TypeScript SDK
  demos/        # Runnable demo scripts
```

---

## Demos

After deploying, try the runnable scripts in `packages/demos/`:

```bash
cp packages/demos/.env.example packages/demos/.env
bun run demo stream.ts
bun run demo async.ts
```

See `packages/demos/` for the full list.

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

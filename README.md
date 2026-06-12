# filthy-panty

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE.md)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun)](https://bun.sh/)
[![SST](https://img.shields.io/badge/infra-SST%20v4-e27152)](https://sst.dev/)

A serverless, multi-account AI agent harness built on AWS Lambda and Bun. Configure agents, connect them to Telegram, Discord, Slack, GitHub, and more, and run them with your own model keys.

This is the open-source engine behind [BeeBlast](https://github.com/beeblastco). The entire stack is self-hostable — you own your data, your AWS account, and your API keys.

---

## What It Is

- **Serverless agent runtime** — Two Lambda Function URLs handle everything: one for account management, one for streaming agent execution.
- **Multi-tenant** — Each account has its own encrypted config, hashed API secret, and isolated data.
- **Bring your own model** — Google, OpenAI, AWS Bedrock, Vercel AI Gateway, or custom providers via the Vercel AI SDK.
- **Multi-channel** — Telegram, Discord, Slack, GitHub, Facebook Messenger (Pancake), and Zalo webhooks are built in.
- **Extensible** — Skills, subagents, workspaces, sandboxes, cron jobs, async tools, and custom uploaded tools.

---

## Quick Start

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

Note the `accountServiceUrl` and `agentServiceUrl` from the deploy output when you deploy locally or on your own cloud. If you're using the BeeBlast hosted version, these are already set for you, then follow the [Getting Started guide](apps/docs/docs/getting-started.md) to create your first account and agent.

---

## Project Layout

```text
apps/
  core/         # SST app — Lambdas, account management, agent loop
  dashboard/    # Next.js dashboard
  docs/         # Docusaurus docs
packages/
  convex/       # Shared Convex backend
  filthy-panty/ # CLI + TypeScript SDK
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

- [Getting Started](apps/docs/docs/getting-started.md) — Create an account and send your first request
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
bun run build    # build Lambda binaries
```

CI runs on every PR via `.github/workflows/ci.yaml`.

---

## Community

- [Discord](https://discord.gg/beeblast) — Chat with contributors
- [GitHub Issues](https://github.com/beeblastco/filthy-panty/issues) — Bugs and feature requests

---

## License

[FSL-1.1-Apache-2.0](LICENSE.md)

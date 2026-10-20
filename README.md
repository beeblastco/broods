# broods

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE.md)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun)](https://bun.sh/)
[![SST](https://img.shields.io/badge/infra-SST%20v4-e27152)](https://sst.dev/)

Broods runs agents in a Bun container behind a gateway, with Convex for configuration and persistence. Connect agents to Telegram, Discord, Slack, Matrix, GitHub, and other channels, and run them with your own model keys.

This is the source-available engine behind [Broods](https://github.com/beeblastco). The whole stack is self-hostable, so the data, the AWS account, and the API keys stay yours.

> [!WARNING]
> **Pre-release.**
>
> Broods has not cut a 1.0 release. The HTTP API, CLI flags and SDK can change without a major version bump. Pin an exact version and read the release notes before upgrading.

---

## What it is

- **Container agent runtime.** One Bun container handles account management, streaming agent execution, webhooks, async work, and cron runs behind the gateway.
- **Multi-tenant.** Each account has its own encrypted config, hashed API secret, and isolated data.
- **Bring your own model.** Google, OpenAI, AWS Bedrock, Vercel AI Gateway, or custom providers via the Vercel AI SDK.
- **Multi-channel.** Telegram, Discord, Slack, Matrix, GitHub, Linear, Pancake, Zalo, WhatsApp, Microsoft Teams, Google Chat, Twilio SMS, Facebook Messenger and Instagram DMs are built in.
- **Extensible.** Skills, subagents, workspaces, sandboxes, cron jobs, async tools, and custom uploaded tools.

---

## Quick start

The fastest way to get running is the managed service via the Broods CLI and SDK:

```bash
# 1. Install the CLI (Bun 1.2+ or Node 22.15+)
bun add -g broods   # or: npm install -g broods

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

Check what a command will act on, and switch organization or stage:

```bash
broods whoami                              # login, org, plan, project, stage
broods org list                            # organizations you can select
broods org use my-team                     # switch org, repoint BROODS_API_KEY
broods stage create staging --from development   # clone a stage to work on
broods stage use staging
```

See the [Quickstart](apps/docs/docs/quickstart.md) for the full walkthrough,
and the [CLI reference](apps/docs/docs/reference/cli.md) for every command.

For self-hosted deployments, see the [Self-hosting guide](apps/docs/docs/internals/self-hosting.md).

---

## Demos

After deploying, try the runnable demos in `packages/demos/`:

```bash
bun run --filter broods build   # once, from repo root
cp packages/demos/.env.example packages/demos/basic-stream/.env.local
cd packages/demos/basic-stream && bun run start
```

Bun reads `.env.local` from the folder a demo runs in, so each demo needs its own copy.

See `packages/demos/README.md` for the full list of demos and setup steps.

---

## Documentation

The docs have two parts. User docs are for building agents on Broods. Internals are for working on Broods itself.

- [Quickstart](apps/docs/docs/quickstart.md). Deploy an agent, chat with it, and call it from code in five minutes.
- [Concepts](apps/docs/docs/concepts.md). Projects, stages, resources, runs and credentials.
- [Configuration](apps/docs/docs/reference/configuration.md). Every `define*` helper and its fields.
- [SDK](apps/docs/docs/reference/sdk.md) and [HTTP API](apps/docs/docs/reference/http-api.md). Calling agents from code.
- [Internals](apps/docs/docs/internals/index.md). Architecture, self-hosting, operations and CI/CD.
- [API Reference](apps/docs/docs/api-reference/openapi.yaml). OpenAPI spec.

Preview the docs locally:

```bash
bun run docs
```

---

## Contributing

Open an issue to agree on the approach before sending a PR.

CI and the container images pin Bun to the version in `.bun-version`. Use that version locally. `bun upgrade` installs the latest release on your current channel and may run ahead of the pin. To leave the canary channel, use `bun upgrade --stable`.

```bash
bun install      # install all workspaces
bun run check    # lint, format check, and typecheck every workspace
bun run test     # every workspace's unit tests, scripts and benchmark gates
bun run build    # build the core Bun container binary
```

CI runs on every PR via `.github/workflows/ci.yaml`.

---

## Community

- Chat with contributors on [Discord](https://discord.gg/beeblast).
- File bugs and feature requests in [GitHub Issues](https://github.com/beeblastco/broods/issues).

---

## License

Core server and application code is licensed under [FSL-1.1-Apache-2.0](LICENSE.md): source-available now, and each release becomes Apache 2.0 two years after it ships.
The `broods` npm package in `packages/broods` is licensed separately under MIT.

# filthy-panty

Current testing and demo URL:

- [harness processing endpoint](https://neqw2f4jkhicsoyybmb5lckebm0fsrgb.lambda-url.eu-central-1.on.aws/)
- [account management endpoint](https://rhsxsjumb7vyrwhtwlyatfa5b40zltie.lambda-url.eu-central-1.on.aws/)

Experimental serverless multi-account AI chatbot and agent harness on AWS Lambda.

The deployed architecture uses two public Lambda Function URLs:

- `account-manage`: creates accounts, rotates account API secrets, manages account-owned agents and skills, and deletes account-scoped runtime data when an account is deleted.
- `harness-processing`: handles account-authenticated direct API traffic, async work, status polling, and account-scoped Telegram, GitHub, Slack, and Discord webhooks.

The design goal is simple infrastructure for low-volume multi-tenant usage: Bun on Lambda, SST for infra, DynamoDB for account/agent/conversation/status state, S3 for workspace-backed memory/files/tasks and skill bundles, and the Vercel AI SDK for the agent loop. Agents can optionally dispatch subagents that run parallel one-shot tasks and inject results back into the parent conversation.

## Overview

- Runtime: Bun on Lambda `provided.al2023` with ARM64 binaries built by [`scripts/build.ts`](scripts/build.ts).
- Infra: SST v4.
- Model SDK: Vercel AI SDK `ai` with agent-configured Google, OpenAI, Bedrock, and Gateway providers.
- Persistence: DynamoDB + S3.
- Streaming: SSE for sync direct API callers only.
- Agent config: stored in DynamoDB with encrypted config payloads; account API secrets are hashed.
- Public entrypoints: `account-manage` and `harness-processing` Lambda Function URLs.

```mermaid
flowchart LR
  Admin["Account owner / admin"] -->|"create + configure account"| Manage["account-manage<br/>Function URL"]
  Client["Direct API client"] -->|"Bearer accountSecret<br/>POST / or /async"| Harness["harness-processing<br/>Function URL"]
  Status["Status poller"] -->|"Bearer accountSecret<br/>GET /status/{eventId}"| Harness
  Provider["Telegram / GitHub / Slack / Discord"] -->|"/webhooks/{accountId}/{agentId}/{channel}"| Harness

  Manage --> Accounts["DynamoDB<br/>AccountConfig"]
  Manage --> Agents["DynamoDB<br/>AgentConfig"]
  Manage --> Skills["S3<br/>Skills"]
  Harness --> Accounts
  Harness --> Agents
  Harness --> Skills["S3<br/>Skills"]
  Harness --> Conversations["DynamoDB<br/>Conversations / ProcessedEvents / AsyncAgentResult / AsyncToolResult"]
  Harness --> Memory["S3<br/>account-scoped MEMORY.md + filesystem + tasks"]
  Harness --> Model["Configured model<br/>Vercel AI SDK"]
```

## Docs

- [Getting started](docs/getting-started.md)
- [Architecture and workflows](docs/architecture.md)
- [Account management](docs/account-management.md)
- [Memory and session](docs/memory-and-session.md)
- [Sub agents](docs/sub-agents.md)
- [Data security](docs/data-security.md)
- [Direct API](docs/direct-api.md)
- [External tools](docs/tools.md)
- [Channels](docs/channels.md)
- [Operations](docs/operations.md)
- [Extending](docs/extending.md)

## Quick Start

See the [Getting Started guide](docs/getting-started.md) for a full walkthrough.

```bash
bun install
cp .env.example .env
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
bun run check
bun run build
bun run deploy
```

After deploy, follow the [Getting Started guide](docs/getting-started.md) to create an account, create an agent, and send your first request.

## Common Commands

```bash
bun run dev
bun run check
bun run test
bun run build
bun run deploy
```

Discord slash command syncing is still a manual utility:

```bash
bun run discord:sync
```

## Main Code Paths

- [`functions/_shared/accounts.ts`](functions/_shared/accounts.ts): account records, bearer auth, account secret hashing, and account metadata storage.
- [`functions/_shared/agents.ts`](functions/_shared/agents.ts): account-owned agent records and encrypted runtime config storage.
- [`functions/_shared/skills.ts`](functions/_shared/skills.ts): shared skill path, frontmatter, import URL validation, and S3 read/ownership primitives.
- [`functions/account-manage/handler.ts`](functions/account-manage/handler.ts): account CRUD, account secret rotation, and agent config APIs.
- [`functions/account-manage/skills.ts`](functions/account-manage/skills.ts): account skill CRUD, GitHub import handling, and S3 writes.
- [`functions/account-manage/cleanup.ts`](functions/account-manage/cleanup.ts): account deletion cleanup for runtime rows and S3 namespaces.
- [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts): account auth, direct API parsing, account webhook routing, and channel normalization.
- [`functions/harness-processing/handler.ts`](functions/harness-processing/handler.ts): SSE, async self-invocation, commands, leases, and reply orchestration.
- [`functions/harness-processing/session.ts`](functions/harness-processing/session.ts): conversation persistence, deduplication, leases, system context, context management, and workspace memory loading.
- [`functions/harness-processing/skills.ts`](functions/harness-processing/skills.ts): enabled skill metadata and `load_skill` prompt content loading.
- [`functions/harness-processing/async-agent-result.ts`](functions/harness-processing/async-agent-result.ts): async direct API and subagent status storage for `/status/{eventId}` polling.
- [`functions/harness-processing/async-tool-result.ts`](functions/harness-processing/async-tool-result.ts): async external tool result storage.
- [`functions/harness-processing/async-tools.ts`](functions/harness-processing/async-tools.ts): async external tool dispatch, result injection, and parent continuation support.
- [`functions/harness-processing/subagents.ts`](functions/harness-processing/subagents.ts): in-process subagent dispatch, child runs, result injection, and parent continuation.
- [`functions/harness-processing/harness.ts`](functions/harness-processing/harness.ts): configured model execution loop and inline tool orchestration.
- [`functions/harness-processing/tools/index.ts`](functions/harness-processing/tools/index.ts): static tool factory registry and agent-configured tool selection.

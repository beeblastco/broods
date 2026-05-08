# filthy-panty

Current testing and demo URL:

- [harness processing endpoint](https://neqw2f4jkhicsoyybmb5lckebm0fsrgb.lambda-url.eu-central-1.on.aws/)
- [account management endpoint](https://rhsxsjumb7vyrwhtwlyatfa5b40zltie.lambda-url.eu-central-1.on.aws/)

Experimental serverless multi-account AI chatbot and agent harness on AWS Lambda.

The deployed architecture uses two public Lambda Function URLs:

- `account-manage`: creates accounts, rotates account API secrets, manages account-owned agents and skills, and deletes account-scoped runtime data when an account is deleted.
- `harness-processing`: handles account-authenticated direct API traffic, async work, status polling, and account-scoped Telegram, GitHub, Slack, and Discord webhooks.

The design goal is simple infrastructure for low-volume multi-tenant usage: Bun on Lambda, SST for infra, DynamoDB for account/agent/conversation/status state, S3 for workspace-backed memory/files/tasks and skill bundles, and the Vercel AI SDK for the agent loop.

## Overview

- Runtime: Bun on Lambda `provided.al2023` with ARM64 binaries built by [`scripts/build.ts`](scripts/build.ts).
- Infra: SST v4.
- Model SDK: Vercel AI SDK `ai` with account-configured Google, OpenAI, Bedrock, and Gateway providers.
- Persistence: DynamoDB + S3.
- Streaming: SSE for sync direct API callers only.
- Agent config: stored in DynamoDB with encrypted config payloads; account API secrets are hashed.
- Public entrypoints: `account-manage` and `harness-processing` Lambda Function URLs.

```mermaid
flowchart LR
  Admin["Account owner / admin"] -->|"create + configure account"| Manage["account-manage<br/>Function URL"]
  Client["Direct API client"] -->|"Bearer accountSecret"| Harness["harness-processing<br/>Function URL"]
  Provider["Telegram / GitHub / Slack / Discord"] -->|"/webhooks/{accountId}/{agentId}/{channel}"| Harness

  Manage --> Accounts["DynamoDB<br/>AccountConfig"]
  Manage --> Agents["DynamoDB<br/>AgentConfig"]
  Manage --> Skills["S3<br/>Skills"]
  Harness --> Accounts
  Harness --> Agents
  Harness --> Conversations["DynamoDB<br/>Conversations / ProcessedEvents / AsyncResults"]
  Harness --> Memory["S3<br/>account-scoped MEMORY.md + filesystem + tasks"]
  Harness --> Model["Configured model<br/>Vercel AI SDK"]
```

## Docs

- [Architecture and workflows](docs/architecture.md)
- [Account management](docs/account-management.md)
- [Memory and session](docs/memory-and-session.md)
- [Data security](docs/data-security.md)
- [Direct API](docs/direct-api.md)
- [Operations](docs/operations.md)
- [Extending](docs/extending.md)

## Quick Start

```bash
bun install
cp .env.example .env
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
bun run check
bun run build
bun run deploy
```

After deploy, create an account through the `accountServiceUrl` output. The response returns an `accountSecret` once. Use that secret as `Authorization: Bearer <accountSecret>` for direct API calls and account self-management.

Create an account, then create an agent with runtime `config`. Direct and async calls include `agentId`. See [Account management](docs/account-management.md#agents) for the supported flow.

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
- [`functions/_shared/skills.ts`](functions/_shared/skills.ts): skill validation, GitHub import sanitization, and S3 skill storage.
- [`functions/account-manage/handler.ts`](functions/account-manage/handler.ts): account CRUD, account secret rotation, agent config APIs, and skill APIs.
- [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts): account auth, direct API parsing, account webhook routing, and channel normalization.
- [`functions/harness-processing/handler.ts`](functions/harness-processing/handler.ts): SSE, async self-invocation, commands, leases, and reply orchestration.
- [`functions/harness-processing/session.ts`](functions/harness-processing/session.ts): conversation persistence, deduplication, leases, prompt context, context management, and workspace memory loading.
- [`functions/harness-processing/status.ts`](functions/harness-processing/status.ts): async direct API status storage for `/status/{eventId}` polling.
- [`functions/harness-processing/harness.ts`](functions/harness-processing/harness.ts): configured model execution loop and inline tool orchestration.
- [`functions/harness-processing/tools/index.ts`](functions/harness-processing/tools/index.ts): static tool factory registry and account-configured tool selection.

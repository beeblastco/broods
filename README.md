# filthy-panty

Experimental serverless AI chatbot and agent harness on AWS Lambda. The deployed path is one public Lambda Function URL that handles sync and async direct API traffic plus optional Telegram, GitHub, Slack, and Discord webhooks.

The design goal is simple infrastructure for low-volume usage: Bun on Lambda, SST for infra, DynamoDB for conversation state and dedup, S3 for filesystem-backed tool state, and Vercel AI SDK for the agent loop.

## Overview

- Runtime: Bun on Lambda `provided.al2023` with ARM64 binaries built by [`scripts/build.ts`](scripts/build.ts).
- Infra: SST v4.
- Model SDK: Vercel AI SDK `ai` with `@ai-sdk/google`.
- Persistence: DynamoDB + S3.
- Streaming: SSE for sync direct API callers only.
- Public entrypoint: one `harness-processing` Lambda Function URL.

## Docs

- [Architecture and workflows](docs/architecture.md)
- [Direct API](docs/direct-api.md)
- [Operations](docs/operations.md)
- [Extending](docs/extending.md)

## Quick Start

```bash
bun install
cp .env.example .env
bunx sst secret set GoogleApiKey <value>
bun run check
bun run build
bun run deploy
```

Use `.env` for local SST inputs such as `AWS_PROFILE` and `SST_STAGE`. Use SST secrets for deployed runtime secrets. See [operations](docs/operations.md) for full setup, direct API secrets, integration flags, deployment, and CI notes.

## Common Commands

```bash
bun run dev
bun run check
bun run test
bun run build
bun run deploy
```

If Discord is enabled:

```bash
bun run discord:sync
```

## Main Code Paths

- [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts): request routing, auth, normalization, and direct API parsing.
- [`functions/harness-processing/handler.ts`](functions/harness-processing/handler.ts): SSE, async self-invocation, commands, leases, and reply orchestration.
- [`functions/harness-processing/session.ts`](functions/harness-processing/session.ts): conversation persistence, deduplication, leases, prompt context, and memory loading.
- [`functions/harness-processing/status.ts`](functions/harness-processing/status.ts): async direct API status storage for `/status/{eventId}` polling.
- [`functions/harness-processing/harness.ts`](functions/harness-processing/harness.ts): model execution loop and inline tool orchestration.
- [`functions/harness-processing/tools/index.ts`](functions/harness-processing/tools/index.ts): static inline tool registry.

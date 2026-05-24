# Storage Provider

Pluggable persistence layer.

## Folder Structure

```sh
storage/
├── types.ts          # StorageProvider interface (domain-shaped)
├── index.ts          # Factory: reads STORAGE_PROVIDER env
├── dedupe.ts         # DedupeStore (DDB-only)
├── accounts.ts       # Account types & helpers
├── agents.ts         # Agent types & helpers
├── agent-config.ts   # Config types & encryption
├── cron-jobs.ts      # CronJob types & helpers
├── dynamo/           # DynamoDB implementation
│   ├── index.ts
│   ├── client.ts
│   ├── accounts.ts
│   ├── agents.ts
│   └── cron-jobs.ts
├── convex/           # Convex implementation (private submodule)
└── ...               # Your other providers
```

## Why Separate?

- **Shared types** (`types.ts`, `accounts.ts`, etc.) → domain logic, not DB-specific
- **dynamo/** → DynamoDB CRUD (default for OSS)
- **convex/** → Convex CRUD (SaaS only, private submodule for security)
- **index.ts factory** → picks provider at runtime via `STORAGE_PROVIDER` env

Community builds skip the private submodule. SaaS deployments get both.

## Adding a New Adapter

1. Create `storage/mydb/` folder
2. Implement `AccountStore`, `AgentStore`, `CronJobStore` from `types.ts`
3. Export `mydbStorageProvider` from `storage/mydb/index.ts`
4. Add case in `storage/index.ts` factory

## What's NOT in StorageProvider

These persistence concerns stay outside the abstraction and run against
DynamoDB on every stage (including SaaS / production):

- **Conversations / messages** (`harness-processing/session.ts`)
- **Async agent results** (`harness-processing/async-agent-result.ts`)
- **Async tool results** (`harness-processing/async-tool-result.ts`)
- **Dedupe** (`storage/dedupe.ts` — `ProcessedEvents` table)
- **Account signup rate limits** (`account-manage/rate-limit.ts`)

Reasons:
- DDB-specific semantics (TTL + conditional writes) for dedupe and rate
  limits — Convex doesn't model these cleanly.
- Schema mismatch with cherry-coke's Convex side for conversations and
  async-results (different table shapes, missing indexes / GSIs).

When the SaaS team aligns Convex schema with filthy-panty's data shapes,
lift these into StorageProvider following the same pattern as accounts /
agents / cron-jobs.

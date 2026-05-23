# Storage Provider

Pluggable persistence layer. Same Lambda binary works with DynamoDB (OSS default) or Convex (SaaS).

## Folder Structure

```
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
└── convex/           # Convex implementation (private submodule)
    ├── index.ts
    ├── client.ts
    ├── accounts.ts
    ├── agents.ts
    └── cron-jobs.ts
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

That's it. Same interface, different implementation.

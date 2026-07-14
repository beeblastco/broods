# Storage

Convex is the sole persistence backend for account configuration and runtime state.

- `index.ts` exposes the domain-shaped `StorageProvider`.
- `provider.ts` implements account, agent, policy, tool, hook, cron, workspace, sandbox, deployment, and usage stores.
- `runtime.ts` calls the transactional conversation, claim, async-result, and sandbox-reservation functions.
- `client.ts` owns the deploy-key-authenticated `ConvexHttpClient` shared by the storage modules.
- The sandbox and usage modules keep their focused Convex calls beside the provider.
- `dedupe.ts` keeps the narrow event-claim interface used by channel adapters.

Core requires `CONVEX_URL` and `CONVEX_DEPLOY_KEY` on every stage. S3 remains the byte store for skills, tool bundles, and workspace files.

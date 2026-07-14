# Convex adapter

Convex is the sole persistence backend for account configuration and runtime state.

- `../storage.ts` exposes the narrow runtime-facing storage boundary and its test injection seam.
- `storage.ts` implements only the account, runtime-read, cron-run, cleanup, deployment, and usage operations that core still owns.
- `runtime.ts` calls the transactional conversation, claim, async-result, and sandbox-reservation functions.
- `client.ts` owns the deploy-key-authenticated `ConvexHttpClient` shared by these adapters.
- The sandbox and usage modules keep focused Convex calls beside the core storage adapter.
- `dedupe.ts` keeps the narrow event-claim interface used by channel adapters.

Domain records, validation, encryption codecs, redaction, and runtime config
projection live in `../domain/`; they are not persistence adapters.

Core requires `CONVEX_URL` and `CONVEX_DEPLOY_KEY` on every stage. S3 remains the byte store for skills, tool bundles, and workspace files.

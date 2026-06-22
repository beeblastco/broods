# broods-convex-adapter

Private Convex `StorageProvider` adapter for [broods](https://github.com/beeblastco/broods).

This repo is mounted as a git submodule at `functions/_shared/storage/convex/`
inside `broods`. Community / open-source builds skip submodule init and
run with the DynamoDB provider only. SaaS deployments init the submodule and
get the Convex provider that talks to the `convex-broods` deployment.

## Files

- `index.ts` — `convexStorageProvider` implementing the `StorageProvider`
  interface declared in the parent repo's `functions/_shared/storage/types.ts`.
- `client.ts` — `ConvexHttpClient` wrapper that reads `CONVEX_URL` and
  `CONVEX_DEPLOY_KEY` from the env.

## Imports

All relative imports (`../agent-config.ts`, `../types.ts`, etc.) resolve to
parent-repo files because this submodule is mounted *inside* the parent's
storage folder. Do not edit those import paths.

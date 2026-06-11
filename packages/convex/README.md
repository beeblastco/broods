# convex-filthy-cherry

Shared Convex backend used by two repositories:

- **cherry-coke** — deploys this folder as part of its Convex project (`convex/backend/` submodule). Single source of truth for the backend schema and internal queries/mutations.
- **filthy-panty** — consumes this folder as a vendored submodule (`vendor/convex-filthy-cherry/`). Filthy-panty does NOT deploy these functions; it only imports the generated `api` types and calls the functions remotely via `ConvexHttpClient` with a Convex deploy key.

## Tables

- `accounts` — tenant root. One row per cherry-coke org/workspace. Bearer-secret hash indexed for direct-API auth lookup.
- `agents` — per-account agent configurations (encrypted blob).
- `conversations` — per-account, per-agent conversation threads.
- `messages` — per-conversation message stream.
- `skills` — per-account skill metadata; blobs live in S3.
- `asyncResults` — per-account async-job status/result entries.

No prefixes; these are first-class tables in the merged schema.

## Functions

All functions are `internalQuery` / `internalMutation`. They are only callable by the Convex deploy key (used by filthy-panty Lambda) or by other internal Convex functions (used by cherry-coke server code).

Naming follows cherry-coke's CRUD rule: `create`, `update`, `list`, `remove`, `getById`, `get…`.

## Tenant isolation (defence in depth)

Every mutation validates the `accountId` argument against the row being touched. A leaked Convex deploy key cannot trivially cross-tenant.

## Workflow

1. Make a change here (PR against this repo).
2. Bump submodule SHA in cherry-coke → `bunx convex codegen` → commit regenerated `_generated/api.d.ts` back into this repo → re-bump submodule.
3. Bump submodule SHA in filthy-panty to pick up new types.

The two consumer repos must move lockstep on schema changes.

## Local development

This repo does not deploy on its own. Iterate inside cherry-coke after bumping the submodule.

## First push to GitHub

After creating the empty repo at `https://github.com/beeblastco/convex-filthy-cherry`:

```sh
git init
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/beeblastco/convex-filthy-cherry.git
git push -u origin main
```

Once pushed, swap the submodule URL in both consumers from the local file path to the GitHub URL:

```sh
# in cherry-coke worktree
git submodule set-url convex/backend https://github.com/beeblastco/convex-filthy-cherry.git

# in filthy-panty worktree
git submodule set-url vendor/convex-filthy-cherry https://github.com/beeblastco/convex-filthy-cherry.git
```

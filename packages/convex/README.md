# @filthy-panty/convex

Shared Convex backend for the filthy-panty monorepo, used by two workspaces:

- **`apps/dashboard`** — deploys this package as its Convex project (the
  dashboard Docker image build runs `convex deploy` from this directory) and
  calls the public functions through the generated `api`.
- **`apps/core`** — does NOT deploy these functions; its storage adapter at
  `apps/core/functions/_shared/storage/convex/` imports the generated
  `internal` types and calls the functions remotely via `ConvexHttpClient`
  with a Convex deploy key. Convex storage is active on the `production`
  stage only (`dev` uses DynamoDB).

## Tables

Dashboard domain: `users`, `orgs`, `orgMembers`, `projects`, `environments`,
`agentConfigs`, `canvasLayouts`, `agentDeployments`, `toolServices`,
`deployKeys`.

Agent-platform domain (shared with core): `accounts`, `agents`,
`sandboxConfigs`, `workspaceConfigs`, `environmentVariables`, `webhooks`,
`conversations`, `messages`, `skills`, `workspaceFiles`, `asyncResults`,
`crons`.

Sensitive config (agent configs, sandbox credentials) is stored as encrypted
blobs — core encrypts before writing; the dashboard never reads the plaintext.
Environment variables are the exception: their values can be revealed on demand
by the environment owner (`environmentVariables.reveal` / CLI `env get`), and
each reveal is recorded in the `environmentVariableReveals` audit table.

## Functions

Functions consumed by core are `internalQuery` / `internalMutation`, callable
only with the Convex deploy key or from other Convex functions. Dashboard-facing
functions authenticate the WorkOS user via `authKit.getAuthUser(ctx)`.

Naming follows the CRUD rule: `create`, `update`, `list`, `remove`, `getById`,
`get…`; internal-only variants end in `Internal`.

## Tenant isolation (defence in depth)

Every mutation validates the `accountId` argument against the row being
touched. A leaked Convex deploy key cannot trivially cross-tenant.

## Workflow

1. Change schema or functions here.
2. Run `bun run --filter @filthy-panty/convex codegen` (or `bunx convex codegen`
   from this directory) and commit the `_generated/` diff — it is committed on
   purpose so core and the dashboard typecheck without codegen.
3. Deploys happen through the dashboard image build (`convex deploy`); this
   package is never deployed standalone.

The convex CLI runs from this directory and reads `CONVEX_DEPLOYMENT` from the
local `.env.local`.

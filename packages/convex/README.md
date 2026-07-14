# @broods/convex

Shared Convex backend for the broods monorepo, used by two workspaces:

- **`apps/dashboard`** — deploys this package as its Convex project (the
  dashboard Docker image build runs `convex deploy` from this directory) and
  calls the public functions through the generated `api`.
- **`apps/core`** — does NOT deploy these functions; its Convex adapter at
  `apps/core/src/shared/convex/` imports the generated
  `internal` types and calls the functions remotely via `ConvexHttpClient`
  with a Convex deploy key. Convex is the sole runtime and configuration
  storage provider. Every stage must supply both `CONVEX_URL` and
  `CONVEX_DEPLOY_KEY`; startup or deployment fails when either is missing.

## Tables

Dashboard domain: `users`, `orgs`, `orgMembers`, `projects`, `environments`,
`agentConfigs`, `canvasLayouts`, `agentDeployments`, `toolServices`,
`deployKeys`.

Agent-platform domain (shared with core): `accounts`, `agents`,
`sandboxConfigs`, `workspaceConfigs`, `environmentVariables`, `webhooks`,
`conversations`, `messages`, `skills`, `workspaceFiles`, `asyncResults`,
`crons`. Core runtime coordination uses `runtimeConversationEvents`,
`runtimeClaims`, `runtimeAsyncAgentResults`, `runtimeAsyncToolResults`,
`runtimeAsyncToolGroups`, and `sandboxReservations`.

Sensitive config (agent configs, sandbox credentials) is stored as encrypted
blobs — core encrypts before writing; the dashboard never reads the plaintext.
Environment variables are the exception: their values can be revealed on demand
by the environment owner (`environmentVariables.reveal` / CLI `env get`), and
each reveal is recorded in the `environmentVariableReveals` audit table. Config
mutations write account-visible rows to `configAuditEvents`, which the dashboard
reads reactively.
Environment runtime API keys are also stored AES-GCM encrypted alongside their
authentication hash. Owners can recover them through the dashboard or CLI login
without rotating.

## Functions

Functions consumed by core are `internalQuery` / `internalMutation`, callable
only with the Convex deploy key or from other Convex functions. Dashboard-facing
functions authenticate the WorkOS user via `authKit.getAuthUser(ctx)`.

Naming follows the CRUD rule: `create`, `update`, `list`, `remove`, `getById`,
`get…`; internal-only variants end in `Internal`.

## Tenant isolation (defence in depth)

Every mutation validates the `accountId` argument against the row being
touched. A leaked Convex deploy key cannot trivially cross-tenant.

## AWS config plane (epic #85 phase 9)

Convex owns the account config plane's AWS resources directly (no core proxy):
skill bundles, tool bundles, and workspace files in S3, plus account cron
schedules in EventBridge Scheduler. `model/aws.ts` assumes `ConvexAwsRole`
(created by `apps/core/sst.config.ts`) from a minimal bootstrap IAM user whose
only permission is `sts:AssumeRole`. Node-only AWS code lives in `model/` and
the `"use node"` action files (`awsBundles.ts`, `awsSkills.ts`,
`awsWorkspaceFiles.ts`, `awsCrons.ts`, `skillsPublic.ts`,
`workspaceFilesPublic.ts`).

`configHttp.ts` serves the public config API on this deployment's
`.convex.site` host — account metadata and rotation (`GET/PATCH /v1/account`,
`POST /v1/account/rotate-secret`, `GET /accounts`,
`GET/PATCH /accounts/{accountId}`, and
`POST /accounts/{accountId}/rotate-secret`), `/v1/agents*`, `/v1/skills*`,
`/v1/tools*`, `/v1/hooks*`, `/v1/workspaces/{id}/files`, `/v1/crons*`, `/v1/workspaces*`,
`/v1/sandboxes*` (CRUD only; lifecycle verbs stay in core), and
`/v1/policies*` — replacing core's former routes; the gateway forwards those
paths here (`BROODS_CONFIG_URL`). Admin-gated account creation
(`POST /accounts`) and account delete (`DELETE /v1/account`,
`DELETE /accounts/{accountId}`) stay in core.
Cron execution stays in core: schedules invoke the configured target with
`{kind: "cron", accountId, cronId}` and core's harness runs the agent.
Sandbox config CRUD requires `ACCOUNT_CONFIG_ENCRYPTION_SECRET`.
`BROODS_ACCOUNT_MANAGE_URL` and `BROODS_SERVICE_AUTH_SECRET` are used to
terminate reserved sandbox instances before deleting a sandbox config.

Deployment environment variables:

- `AWS_REGION` — data-plane region (matches the core stage).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the bootstrap user's static
  key, minted out of band (`aws iam create-access-key`), never in git or
  Pulumi state.
- `CONVEX_AWS_ROLE_ARN` — the `ConvexAwsRole` ARN (sst output
  `convexAwsRoleArn`).
- `CONVEX_AWS_EXTERNAL_ID` — assume-role external id (default
  `broods-convex`).
- `SKILLS_BUCKET_NAME`, `TOOL_BUNDLES_BUCKET_NAME`, `FILESYSTEM_BUCKET_NAME` —
  the stage's S3 buckets (sst outputs).
- `CRON_SCHEDULER_TARGET_ARN` — what schedules invoke (sst output
  `cronSchedulerTargetArn`; the harness today, the gateway cron-run API
  destination after cutover).
- `CRON_SCHEDULER_ROLE_ARN` — the role schedules assume (sst output
  `cronSchedulerRoleArn`).
- `CRON_SCHEDULER_GROUP_NAME` — the stage's schedule group (sst output
  `cronScheduleGroupName`).
- `ACCOUNT_CONFIG_ENCRYPTION_SECRET` — AES-GCM secret for agent and sandbox config CRUD.
- `ADMIN_ACCOUNT_SECRET` — admin bearer secret accepted by account admin HTTP
  routes in `configHttp.ts`.
- `BROODS_ACCOUNT_MANAGE_URL` / `BROODS_SERVICE_AUTH_SECRET` — core
  account-manage URL and shared bearer secret used for sandbox delete cleanup.

## Workflow

1. Change schema or functions here.
2. Run `bun run --filter @broods/convex codegen` (or `bunx convex codegen`
   from this directory) and commit the `_generated/` diff — it is committed on
   purpose so core and the dashboard typecheck without codegen.
3. Deploys happen through the dashboard image build (`convex deploy`); this
   package is never deployed standalone.

The convex CLI runs from this directory and reads `CONVEX_DEPLOYMENT` from the
local `.env.local`.

# packages/convex

`@broods/convex` — shared Convex backend and config plane. dashboard deploy it, core read it in prod. paths here relative to `packages/convex/`.

before you touch schema or functions, read `README.md` and `_generated/ai/guidelines.md`. generated guidelines beat model training data for Convex API and pattern. trust them, not memory.

## Map

schema and wiring:

- `schema.ts` — every table. start here.
- `convex.config.ts`, `convex.json` — component and project config. `http.ts` — HTTP router.
- `migrations.ts` — `@convex-dev/migrations` entries for schema/data cutover.

HTTP surfaces, what gateway send here:

- `configHttp.ts` — **the config plane.** account metadata/rotate, and agent, skills, tools, workspace-files, cron, workspace, sandbox-config, policy CRUD. core do not own these routes. gateway route them here by `BROODS_CONFIG_URL`. `configHttpAuthFailures.ts` and `configAuditEvents.ts` cover auth failure and audit trail.
- `cliHttp.ts`, `cliAuthHttp.ts`, `cliOnboardingHttp.ts` — `broods` CLI surface. backed by `cliAuth.ts`, `cliSync.ts`, `cliTypes.ts`.
- `webhooks.ts` — inbound webhooks, WorkOS user events included.

domain functions:

- tenancy: `org.ts`, `orgMembers.ts`, `orgLifecycle.ts`, `project.ts`, `environment.ts`.
- agents: `agents.ts`, `agentConfig.ts`, `agentDeployments.ts`, `agentPolicies.ts`, plus `model/agentSync.ts`.
- runtime and conversation: `runtime.ts`, `runtimeIngress.ts`, `conversations.ts`, `messages.ts`, `asyncResults.ts`, `logs.ts`, `logsHelpers.ts`.
- sandbox: `sandboxConfigs.ts`, `sandboxInstances.ts`, `sandboxSnapshots.ts`, `sandboxAuditEvents.ts`, `sandboxPublic.ts`.
- workspace, skill, tool: `workspaceConfigs.ts`, `workspaceFiles.ts`, `workspaceFilesPublic.ts`, `skills.ts`, `skillsPublic.ts`, `toolService.ts`.
- env var and secret: `accountEnvVars.ts`, `environmentVariables.ts`, `deployKeys.ts`.
- AWS bridge: `awsBundles.ts`, `awsCrons.ts`, `awsSkills.ts`, `awsWorkspaceFiles.ts`. cron: `cron.ts`, `cronPublic.ts`, `crons.ts`.
- money: `stripe.ts`, `usage.ts`, `modelPricing.ts`. canvas: `canvas.ts`.

pure logic, `model/` — no Convex ctx, easy to unit test:

- codec and rules: `agentConfigCodec.ts`, `agentRules.ts`, `cronRules.ts`, `policyRules.ts`, `sandboxRules.ts`, `skillRules.ts`, `workspaceRules.ts`, `configValues.ts`, `environmentValues.ts`.
- secrets: `accountSecrets.ts`, `agentRuntimeSecrets.ts`. sync: `agentSync.ts`, `sandboxConfigSync.ts`, `apiCanvasSync.ts`.
- access: `projectScope.ts`, `ownership/org.ts`, `ownership/project.ts`, `ownership/environment.ts`.
- rest: `cascade.ts`, `auditEvents.ts`, `aws.ts`, `s3.ts`, `objects.ts`, `skills.ts`, `slackDirectory.ts`, `workspaceFs.ts`.

tests: `tests/` (Vitest, `vitest.config.ts`) and colocated `*.test.ts` — `org.test.ts`, `runtime.test.ts`, `runtimeIngress.test.ts`, `projectScope.test.ts`, `agentSync.test.ts`.

## Who Uses It

- `../../apps/dashboard` deploy this package as its Convex project, import functions through `@broods/convex/_generated/api`.
- `../../apps/core` do **not** deploy these functions. its storage adapter call internal functions remote through `ConvexHttpClient` with a Convex deploy key, and reach generated API by `require()` on purpose.

## Workflow

- Convex CLI run from this folder, read `CONVEX_DEPLOYMENT` from `.env.local`.
- do not run `bun convex dev` unless user ask. dev server usually already up.
- schema or function change = `bun run --filter @broods/convex codegen` from repo root, or `bunx convex codegen` here.
- commit `_generated/` diff. committed on purpose so core and dashboard typecheck with no local codegen.
- deploy happen through dashboard image build (`convex deploy`). no standalone deploy unless user ask.
- Convex skills sit in `.claude/skills/` — `convex`, `convex-migration-helper`, `convex-performance-audit`, `convex-create-component`, `convex-quickstart`, `convex-setup-auth`. mirrored in `.agents/skills/`. breaking schema change, backfill, table reshape = grab `convex-migration-helper` first.

## Secrets

agent config and sandbox credential encrypted before storage. dashboard must never read that plaintext. two holes on purpose, both owner-gated:

1. **env vars** — reveal by `environmentVariables.reveal` (dashboard eye-icon) or CLI `env get`. every reveal write an `environmentVariableReveals` audit row.
2. **environment runtime API key** (`fp_agent_…`) — AES-GCM encrypted on `agentDeployments` (`apiKeyCiphertext` / `Iv` / `Tag`), recovered by `agentDeployments.revealKeyForEnvironment` (dashboard streaming) or CLI `runtime-key` route (`broods login`), so owner reconnect without rotate. no audit row here, unlike env vars.

agent config and sandbox credential stay unreadable. keep it that way.

## Auth

WorkOS AuthKit do SSO with Google OAuth. `users` table sync from WorkOS webhooks:

- `auth.ts` — AuthKit instance, webhook handlers (`user.created`, `user.updated`, `user.deleted`). delete cascade in `workosUserDeletion.ts` and `workosUserDeletionCleanup.ts`.
- `auth.config.ts` — JWT provider config, validate WorkOS token.
- `user.ts` — public API: `getCurrent`, `updateProfile`, `requestAccountDeletion`.

every authenticated public function use `authKit.getAuthUser(ctx)`. public API that need a user must carry this block, comment included:

```typescript
// Check authenticated user
const user = await authKit.getAuthUser(ctx);
if (!user) {
  throw new Error("User not found or not authenticated");
}
```

## Style

comment key section only. no JSDoc on every function and type. function that need Convex ctx stay in top-level file. pure logic that can be tested alone go to `model/`.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

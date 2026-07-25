# apps/core

`@broods/core` — agent harness. one Bun container (Vercel AI SDK) serving whole runtime behind gateway. **off Lambda** (epic #85 phase 9). source in `src/`, not `functions/`. Convex persistence, AWS data plane (S3/STS/Scheduler), MicroVM tool-exec backend all stay. `sst.config.ts` provision AWS data plane + container IAM user, not the runtime process.

paths here relative to `apps/core/`.

## Flow

```
request in
  → src/server.ts                 one Bun.serve, route by path
  → src/harness/integrations.ts   normalize channel / webhook / direct payload
  → src/harness/handler.ts        orchestration only, stay thin
  → src/harness/session.ts        load + save conversation state
  → src/harness/harness.ts        model/tool loop
  → maybe channel reply           through that channel ChannelActions
```

## Map

entry and transport:

- `src/server.ts` — single entry. build transport-neutral `CoreRequest` per HTTP request, route **by path** through `routesToAccountManage`. never route by Host, gateway strip it. stream handler Web `Response` back, SSE included.
- `src/shared/http.ts` — the contract. `CoreHandler = (request: CoreRequest, ctx: RequestContext) => Promise<Response>`, plus `jsonResponse` / `textResponse` / `errorResponse`. work after response use `ctx.waitUntil(...)`. no Lambda `afterResponse` anymore.
- `src/shared/auth.ts`, `src/shared/runtime-keys.ts`, `src/shared/terminal-ticket.ts` — account auth, runtime key, terminal ticket.

two handlers, one process:

- `src/accounts/handler.ts` — admin-gated account create (`POST /accounts`), account delete (`DELETE /v1/account`, `DELETE /accounts/{accountId}`), sandbox lifecycle verbs. cleanup in `src/accounts/cleanup.ts`.
- `src/harness/handler.ts` — everything else. account-auth direct API, async request, status poll, account-scoped channel webhook, `/v1/cron-runs` service-token leaf. async fan-out in-process via `dispatchInProcessWorker`. background job callback use `PUBLIC_BASE_URL`, no Function-URL discovery.

not core routes. account metadata/rotate (`GET/PATCH /v1/account`, `POST /v1/account/rotate-secret`, `GET /accounts`, `GET/PATCH /accounts/{accountId}`, `POST /accounts/{accountId}/rotate-secret`) and agent, skills, tools, workspace-files, cron, workspace, sandbox-config, policy CRUD live in Convex config plane (`../../packages/convex/configHttp.ts`). gateway send those paths there via `BROODS_CONFIG_URL`. core keep only runtime paths: `POST /v1/agents/{id}` and scoped agent invocation, `src/shared/skills.ts`, tool bundle load, workspace mount/S3 read helpers, sandbox lifecycle verbs, harness `/v1/cron-runs` leaf, account-delete cleanup.

agent loop, `src/harness/`:

- `harness.ts` — the model/tool loop. `provider.ts` build model. `pruning.ts` and `compaction.ts` hold context down. `usage-metering.ts` count spend.
- `session.ts` — live persistence for conversation state.
- `ingress.ts` — queue/steer order for concurrent message. drain mutate ownership: emit owner-gated side effect **before** dispatch next ingress.
- `lifecycle.ts`, `policy.ts` — run lifecycle, OPA enforce. rego source of truth is `opa/broods_authz.rego`.
- `hook-dispatcher.ts`, `hook-runner.ts` — account hooks.
- `subagents.ts` — subagent run, exposed as `run-subagent` tool.
- `async-agent-result.ts`, `async-tool-result.ts`, `async-tools.ts` — async/status flow.
- `isolate/executor.ts`, `isolate/payload.ts` — V8 isolate plane, run custom tool code.
- `skills.ts` — load skill into run. bundle fetch live in `src/shared/skills.ts`.

tools, `src/harness/tools/`:

- `index.ts` — static factory registry + account-configured selector. register here or tool file never get bundled into binary.
- sandbox/filesystem: `bash.tool.ts`, `read.tool.ts`, `write.tool.ts`, `edit.tool.ts`, `glob.tool.ts`, `grep.tool.ts`. shared bits in `filesystem-utils.ts`.
- rest: `memory.tool.ts`, `load-skill.tool.ts`, `async-status.tool.ts`, `run-subagent.tool.ts`, `account-tool.tool.ts`, `provider-tool.ts`, `custom-tool-executor.ts`.

sandbox backends, `src/harness/sandbox/`:

- `index.ts` pick executor. `types.ts` is shared contract. backends: `microvm-executor.ts` (MicroVM tool-exec plane), `workdir-executor.ts`, `daytona-executor.ts`, `e2b-executor.ts`, `vercel-executor.ts`.
- `instance-store.ts`, `jobs.ts`, `s3-mount.ts`, `utils.ts` — instance bookkeeping, background job, S3 mount.

shared, `src/shared/` — only thing both handlers really use:

- channels: `channels.ts` define `ChannelAdapter` / `ChannelActions`. adapters `slack-channel.ts`, `discord-channel.ts`, `telegram-channel.ts`, `zalo-channel.ts`, `github-channel.ts`, `pancake-channel.ts`. `commands.ts` hold bot commands. `webhook.ts` verify inbound signature.
- Convex boundary: `storage.ts` is runtime-facing seam. adapters `convex/client.ts`, `convex/storage.ts`, `convex/runtime.ts`, `convex/usage.ts`, `convex/dedupe.ts`, `convex/sandbox-*.ts`.
- domain codecs, `src/shared/domain/`: `accounts.ts`, `agents.ts`, `agent-config.ts`, `agent-policy.ts`, `account-tools.ts`, `account-hooks.ts`, `cron.ts`, `sandbox-config.ts`, `workspace-config.ts`.
- plumbing: `env.ts`, `s3.ts`, `nats.ts`, `log.ts`, `otel.ts`, `telemetry.ts`, `cold-start.ts`, `object.ts` (the `isPlainObject` guard live here), `providers.ts`, `sandbox.ts`, `sandbox-sizes.ts`, `sandbox-cleanup.ts`, `workspaces.ts`.

around source:

- `tests/` — Bun tests, one file per surface (`harness.test.ts`, `integrations.test.ts`, `ingress.test.ts`, `tool-registry.test.ts`, `sandbox-executor.test.ts`, …). helpers in `tests/helpers/`.
- `scripts/build.ts` — compile to `dist/core-server`. `scripts/compaction-prompt.ts` generate `src/shared/.generated/compaction-prompt.ts`, see `COMPACTION.md`.
- `Dockerfile` — build `ghcr.io/beeblastco/broods-core`, run as k3s pods from infra repo (`../../../infra`).
- `sst.config.ts` — AWS data plane + container IAM user. only `dev` stage exist.
- `opa/broods_authz.rego` — policy source of truth.
- `.env.example` — new env read go here too.

## Depends On

- `../../packages/convex` (`@broods/convex`) — shared Convex backend. adapters in `src/shared/convex/` read it. every stage need `CONVEX_URL` and `CONVEX_DEPLOY_KEY`. storage adapter reach generated API with `require("@broods/convex/_generated/api")` **on purpose** — typed import drag every backend source into core stricter typecheck. keep it `require()`.
- `../../packages/broods` (`broods`) — CLI + SDK that call core through gateway. public API or config shape move = move its types/client.
- `../../packages/demos` — demos against deployed gateway or local `bun run serve`. keep in sync with config change.
- `../../apps/dashboard` — share the Convex backend.
- `../../apps/docs` — core behavior change = docs and diagram change.

## Commands

- `bun run serve` — run container from source, `src/server.ts`, port 3000.
- `bun run build` — compile binary to `dist/core-server`.
- `bun run test`, then `bun run check` — tests, lint, types.
- `sst` commands run from this folder. do not deploy unless ask. push `dev`, CI/CD do it.

## Rules

- whole runtime is one Bun container. no Lambda runtime. do not bring it back.
- cron off Lambda: EventBridge Scheduler → cron-runs event bus → API destination → gateway `/v1/cron-runs` (service-token auth) → `handleScheduledCron`.
- keep SSE path alive when you simplify. handler return streaming Web `Response`. do not replace unless that is the point of the change.
- **new tool:** make `src/harness/tools/<name>.tool.ts`, export default tool factory, logic go straight inside the tool `execute`, register factory in `src/harness/tools/index.ts`. option validation go in `normalizeToolsConfig` (`src/shared/domain/agent-config.ts`) only when tool take `config.tools.<name>` options.
- custom tool run inline in harness during streaming request. no queue-based tool execution, no external tool-Lambda wiring, unless architecture change on purpose. MicroVM sandbox backend that run untrusted bash/python is different plane, it stay.
- **new channel:** make `src/shared/<channel>-channel.ts` that implement `ChannelAdapter` from `src/shared/channels.ts`, then wire normalize path into `src/harness/integrations.ts`. reply send stay inside that channel `ChannelActions`. never hardcode channel logic into shared handler or agent loop. prefer channel SDK/adapter formatter. custom formatting only when provider have no SDK.
- **new bot command:** add entry to `commands` array in `src/shared/commands.ts` — aliases, description, execute. command get channel-agnostic `ChannelActions` from `CommandContext`. never import channel module from command.
- sandbox and workspace are separate account-scoped records, tables `sandboxConfig` / `workspaceConfig`. agent config point at them by id: `sandbox: "<id>"` + `workspaces: [{name, workspaceId}]`. referenced sandbox expose Claude-Code-style tools — `bash` always, `read`/`write`/`edit`/`glob`/`grep` when workspace attached too. approval follow sandbox `permissionMode` (`edit` / `ask` / `bypass`). search/research tools stay opt-in through `config.tools`. CRUD live in Convex config plane. core keep sandbox lifecycle verbs only.
- Google Search is provider-native, not a core tool file. provider descriptor (`google.tools.googleSearch({...})`) resolve lazy in `src/harness/tools/provider-tool.ts`. still switch on with `config.tools.googleSearch`.
- account provider constructor settings live under `config.provider`. account model config under `config.model`: `provider`, `modelId`, normal Vercel AI SDK `streamText` settings, `providerOptions` for provider-specific options.
- code go in `src/shared/` only when both handlers really use it. harness-only code stay in `src/harness/`.
- secrets by SST: `AdminAccountSecret`, `AccountConfigEncryptionSecret`. channel, provider, tool credential live in account encrypted config when account-specific.

## Style

every file start with block-docstring header, one blank line before first import:

```ts
/**
 * ...
 */

import ...
```

keep header short. say what file boundary is, what belong there, where near-by logic should go. never list functions in it.

change, refactor, or add behavior = update docs, examples, tests. put doc update in the one file that fit, not spray across every doc. write little. prefer picture and diagram. move the diagram too.

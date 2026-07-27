# apps/core

`@broods/core` — the agent harness. one Bun container (Vercel AI SDK) serving the whole runtime behind the gateway.

**off Lambda.** source in `src/`, not `functions/`. no Lambda runtime, no `afterResponse`, no Function-URL discovery. do not bring any of it back. Convex persistence, the AWS data plane (S3/STS/Scheduler) and the MicroVM tool-exec plane all stay. `sst.config.ts` provision that data plane + the container IAM user, never the runtime process.

paths relative to `apps/core/`.

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

`src/accounts/handler.ts` is the other half: admin-gated account create, account delete, sandbox lifecycle verbs. `routesToAccountManage` in `src/server.ts` decide which handler get the request.

## Gotchas

- route **by path only**. the gateway strip Host, so Host tell you nothing.
- **most CRUD is not here.** account metadata/rotate, and agent, skills, tools, workspace-files, cron, workspace, sandbox-config, policy CRUD all live in the Convex config plane (`../../packages/convex/configHttp.ts`); gateway send those paths there by `BROODS_CONFIG_URL`. core keep only the runtime side: `POST /v1/agents/{id}` and scoped invocation, skills, tool bundle load, workspace mount/S3 read, sandbox lifecycle verbs, the `/v1/cron-runs` leaf, account-delete cleanup. hunting for account CRUD in core is wasted grep.
- new tool must be registered in `src/harness/tools/index.ts`. that registry is what pull the file into the compiled binary — miss it and the tool silently not exist. logic go straight in the tool `execute`. option validation go in `normalizeToolsConfig` (`src/shared/domain/agent-config.ts`) only when the tool take `config.tools.<name>` options.
- storage adapter reach the Convex generated API with `require("@broods/convex/_generated/api")` **on purpose**. a typed import drag every backend source into core stricter typecheck. keep it `require()`.
- `src/harness/ingress.ts` drain mutate ownership. emit owner-gated side effect **before** you dispatch the next ingress, never after.
- keep the SSE path alive when you simplify. handlers return a streaming Web `Response`. work after response go through `ctx.waitUntil(...)`.
- account-uploaded tools: `src/harness/bundles/executor.ts` dispatches by tier and invokes the Lambda; `payload.ts` is the frame protocol it shares with the isolate tier and `hook-runner.ts`. pure/fetch-only bundles run in the in-core V8 isolate (`src/harness/isolate/`); node/npm/native bundles run in the Lambda whose source is `../lambda/` — plain `.mjs`, no build, `sst.config.ts` points straight at it. the MicroVM sandbox that runs bash/python is a different plane; keep custom-tool code out of `src/harness/sandbox/`. the Lambda answers over `InvokeWithResponseStream`, not `Invoke` — its response is raw NDJSON, so core and the Lambda must roll together. the Lambda **handler** resolves `bundleUrl`, not the child: the handler process is warm across invocations and keeps its connection to S3.
- the isolate tier is not a Node runtime and not a browser. what a bundle can reach is exactly `isolate/runner/web-globals.mjs` plus the timers/fetch/console set in `runner.mjs`. `inferAccountToolRuntime` (`src/shared/domain/account-tools.ts`, **mirrored** in `packages/convex/model/accountTools.ts` — change both) is what keeps a bundle off a tier that cannot run it, so widening one without the other turns a routing decision into a runtime ReferenceError. no Web Streams there: anything importing `ai` goes to sandbox.
- the isolate tier runs **pooled by default** (`ISOLATE_POOL=0` for the one-shot fallback). workers are long-lived Node processes: they spawn only when every live one is busy, get reaped after `ISOLATE_WORKER_IDLE_SECONDS`, and `shutdownIsolatePool()` kills them on SIGTERM. core's pod has 1 GiB for everything, so never pre-fill the pool to its cap.
- the sandbox child gets its **bundle on fd 3**, raw, and only the run request on stdin. base64-in-JSON cost a third more bytes and ~25ms of CPU on both sides for a 7 MB bundle. handler and child must roll together.
- **a tenant bundle can never be imported from a `data:` URL.** bundlers emit `createRequire(import.meta.url)` at module scope whenever they inline a CommonJS dep, and `createRequire` rejects a data: URL outright — the tool dies before its own first line. `child-runner.mjs` serves the bytes under a synthetic `file:` URL through `module.registerHooks`; nothing is written to disk.
- a tool bundle gets the **AI SDK's own execute options** — `toolCallId`, `abortSignal`, `messages`, `experimental_context` — plus broods `ctx` (`config`/`fetch`/`state`) at `options.context`. `messages` is bounded to the newest 512 KB in `bundles/payload.ts`: the whole conversation would blow Lambda's 6 MB invoke quota. **secrets ride `ctx.config`** as `${NAME}` placeholders Convex resolved at sync time — there is no `ctx.env` and no `process.env` (the child's is scrubbed), and re-adding either just makes a second empty path.
- the sandbox child stamps **`cpuUsec` on its terminal frame**, and core meters it as `type: "custom-tool-sandbox"`, `role: "tool"` — never as the `lambda` sandbox provider, which means the agent's own MicroVM and would file uploaded-tool compute under the agent's sandbox. that sample is what feeds `usageRollups.toolSandboxCpuUsec` and the dashboard Compute panel. `toolCallId` rides the in-memory sample only, for the span; the stored row stays aggregated.
- **one normalized duration per tool call.** `toolSpanDurationMs` picks the SDK's `toolExecutionMs` over the handler clock (which overstates parallel calls by the model's own time) and clamps NaN/negative. every surface — span, observability row, `tool.call.finished`, summary, logs — quotes that one number, so a trace and its event log cannot disagree.
- **never wrap a tool `execute` in a plain `async` function.** the AI SDK streams a tool only when `execute` *returns* an AsyncIterable; an async wrapper hands back a Promise, the SDK takes it as the whole result, and the generator is never iterated — the tool silently returns `{}` and the bundle never runs. `src/harness/tool-execute.ts` holds the shape check every wrapper (owner fence, hooks, async-tools) must go through.
- Google Search is provider-native, not a tool file. the descriptor (`google.tools.googleSearch({...})`) resolve lazy in `src/harness/tools/provider-tool.ts`. still switch on with `config.tools.googleSearch`.
- cron come from outside: EventBridge Scheduler → cron-runs event bus → API destination → gateway `/v1/cron-runs` (service-token auth) → `handleScheduledCron`.
- `opa/broods_authz.rego` is the policy source of truth. stale rego already caused live breakage once.
- `src/shared/.generated/compaction-prompt.ts` is generated by `scripts/compaction-prompt.ts`. do not hand-edit. see `COMPACTION.md`.
- `src/shared/` is only for what **both** handlers really use. harness-only code stay in `src/harness/`.

## Shapes

- sandbox and workspace are separate account-scoped records (`sandboxConfig` / `workspaceConfig`). agent config point at them by id: `sandbox: "<id>"` + `workspaces: [{name, workspaceId}]`. CRUD live in the config plane; core keep lifecycle verbs only.
- a referenced sandbox expose Claude-Code-style tools — `bash` always, `read`/`write`/`edit`/`glob`/`grep` only when a workspace is attached too. approval follow sandbox `permissionMode` (`edit` / `ask` / `bypass`). search/research tools stay opt-in through `config.tools`.
- account model config under `config.model`: `provider`, `modelId`, normal Vercel AI SDK `streamText` settings, `providerOptions` for provider-specific options. provider constructor settings under `config.provider`.
- secrets by SST: `AdminAccountSecret`, `AccountConfigEncryptionSecret`. channel / provider / tool credentials live in the account encrypted config when they are account-specific.

## Adding Things

- **channel:** `src/shared/<channel>-channel.ts` implementing `ChannelAdapter` from `src/shared/channels.ts`, then wire normalize into `src/harness/integrations.ts`. reply send stay inside that channel `ChannelActions`. never hardcode channel logic into a shared handler or the agent loop. prefer the channel SDK formatter; hand-rolled formatting only when the provider ship no SDK.
- **bot command:** entry in the `commands` array in `src/shared/commands.ts`. command get channel-agnostic `ChannelActions` from `CommandContext`. never import a channel module from a command.

## Style

on top of root style: every file open with a block docstring, one blank line before the first import.

```ts
/**
 * ...
 */

import ...
```

keep it short — what the file boundary is, what belong there, where near-by logic go. never list functions in it.

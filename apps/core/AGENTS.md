# apps/core

`@broods/core` — the agent harness. one Bun container (Vercel AI SDK) serving the whole runtime behind the gateway.

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
- **most CRUD is not here.** account metadata/rotate, and agent, skills, tools, workspace-files, cron, workspace, sandbox-config, policy, channel-record CRUD all live in the Convex config plane (`../../packages/convex/configHttp.ts`); gateway send those paths there by `BROODS_CONFIG_URL`. core keep only the runtime side: `POST /v1/agents/{id}` and scoped invocation, skills, tool bundle load, workspace mount/S3 read, sandbox lifecycle verbs, the `/v1/cron-runs` leaf, account-delete cleanup. hunting for account CRUD in core is wasted grep.
- new tool must be registered in `src/harness/tools/index.ts`. that registry is what pull the file into the compiled binary — miss it and the tool silently not exist. logic go straight in the tool `execute`. option validation go in `normalizeToolsConfig` (`src/shared/domain/agent-config.ts`) only when the tool take `config.tools.<name>` options.
- storage adapter reach the Convex generated API with `require("@broods/convex/_generated/api")` **on purpose**. a typed import drag every backend source into core stricter typecheck. keep it `require()`.
- `src/harness/ingress.ts` drain mutate ownership. emit owner-gated side effect **before** you dispatch the next ingress, never after.
- keep the SSE path alive when you simplify. handlers return a streaming Web `Response`. work after response go through `ctx.waitUntil(...)`.
- account-uploaded tools: `src/harness/bundles/executor.ts` dispatches by tier and invokes the Lambda; `payload.ts` is the frame protocol it shares with the isolate tier and `hook-runner.ts`. pure/fetch-only bundles run in the in-core V8 isolate (`src/harness/isolate/`); node/npm/native bundles run in the Lambda whose source is `../lambda/` — plain `.mjs`, no build, `sst.config.ts` points straight at it. the MicroVM sandbox that runs bash/python is a different plane; keep custom-tool code out of `src/harness/sandbox/`. the Lambda answers over `InvokeWithResponseStream`, not `Invoke` — its response is raw NDJSON, so core and the Lambda must roll together. the Lambda **handler** resolves `bundleUrl`, not the child: the handler process is warm across invocations and keeps its connection to S3.
- **custom tools stay on Lambda, never move to a Worker.** they are meant to stop being TypeScript-only — python, go, rust uploads need a real process, a filesystem and real deps, which a V8-isolate Worker cannot give. a Worker is right only for code _we_ vendor and ship (#191); tenant code is not that.
- the isolate tier is not a Node runtime and not a browser. what a bundle can reach is exactly `isolate/runner/web-globals.mjs` plus the timers/fetch/console set in `runner.mjs`. `inferAccountToolRuntime` (`src/shared/domain/account-tools.ts`, **mirrored** in `packages/convex/model/accountTools.ts` — change both) is what keeps a bundle off a tier that cannot run it, so widening one without the other turns a routing decision into a runtime ReferenceError. no Web Streams there: anything importing `ai` goes to sandbox.
- the isolate tier runs **pooled by default** (`ISOLATE_POOL=0` for the one-shot fallback). workers are long-lived Node processes: they spawn only when every live one is busy, get reaped after `ISOLATE_WORKER_IDLE_SECONDS`, and `shutdownIsolatePool()` kills them on SIGTERM. core's pod has 1 GiB for everything, so never pre-fill the pool to its cap.
- the sandbox child gets its **bundle on fd 3**, raw, and only the run request on stdin. base64-in-JSON cost a third more bytes and ~25ms of CPU on both sides for a 7 MB bundle. handler and child must roll together.
- **a tenant bundle can never be imported from a `data:` URL.** bundlers emit `createRequire(import.meta.url)` at module scope whenever they inline a CommonJS dep, and `createRequire` rejects a data: URL outright — the tool dies before its own first line. `child-runner.mjs` serves the bytes under a synthetic `file:` URL through `module.registerHooks`; nothing is written to disk.
- a tool bundle gets the **AI SDK's own execute options** — `toolCallId`, `abortSignal`, `messages`, `experimental_context` — plus broods `ctx` (`config`/`fetch`/`state`) at `options.context`. `messages` is bounded to the newest 512 KB in `bundles/payload.ts`: the whole conversation would blow Lambda's 6 MB invoke quota. **secrets ride `ctx.config`** as `${NAME}` placeholders Convex resolved at sync time — there is no `ctx.env` and no `process.env` (the child's is scrubbed), and re-adding either just makes a second empty path.
- the sandbox child stamps **`cpuUsec` on its terminal frame**, and core meters it as `type: "custom-tool-sandbox"`, `role: "tool"` — never as the `lambda` sandbox provider, which means the agent's own MicroVM and would file uploaded-tool compute under the agent's sandbox. that sample is what feeds `usageRollups.toolSandboxCpuUsec` and the dashboard Compute panel. `toolCallId` rides the in-memory sample only, for the span; the stored row stays aggregated.
- **one normalized duration per tool call.** `toolSpanDurationMs` picks the SDK's `toolExecutionMs` over the handler clock (which overstates parallel calls by the model's own time) and clamps NaN/negative. every surface — span, observability row, `tool.call.finished`, summary, logs — quotes that one number, so a trace and its event log cannot disagree.
- **never wrap a tool `execute` in a plain `async` function.** the AI SDK streams a tool only when `execute` _returns_ an AsyncIterable; an async wrapper hands back a Promise, the SDK takes it as the whole result, and the generator is never iterated — the tool silently returns `{}` and the bundle never runs. `src/harness/tool-execute.ts` holds the shape check every wrapper (owner fence, hooks, async-tools) must go through.
- Google Search is provider-native, not a tool file. the descriptor (`google.tools.googleSearch({...})`) resolve lazy in `src/harness/tools/provider-tool.ts`. still switch on with `config.tools.googleSearch`.
- cron come from outside: EventBridge Scheduler → cron-runs event bus → API destination → gateway `/v1/cron-runs` (service-token auth) → `handleScheduledCron`. a cron `conversationKey` that name a **live channel session** make the run resume that session and reply there (`getConversationTarget` → `replyTarget`); anything else stay its own `api:` conversation. `schedule` / `list_schedules` / `update_schedule` / `cancel_schedule` are the runtime way in — the only cron writes core own, straight to `awsCrons` through `storage.crons`. a fired run is marked by `session.trigger === "cron"`: that one flag name the root span `agent.cron` **and** withhold **every** schedule tool, because the run read its own stored instructions as a fresh request and would act on the job it is running. subagent inherit the flag (their span stay `subtask`). those instructions never reach the model bare either — `withScheduledRunContext` frame the first user message with what fired and when, since nobody typed that turn. an `at(...)` job is **self-deleting**: EventBridge drop the schedule (`ActionAfterCompletion`), core drop the row when that one run settle (`settleCronRun`) or when it never start. so cron row deletion is a normal path now, not only an owner action — never assume the row still there after a run.
- `opa/broods_authz.rego` is the policy source of truth, and it deploy **separate from the container**. stale rego already caused live breakage once.
- **two** webhook shapes, no agent in the URL ever: `/webhooks/{acct}/{channel}` is production's, and `/webhooks/{acct}/dev/{endpointId}/{channel}` pin delivery to one stage. the `dev` marker keep the stage form at four segment, so the retired `/webhooks/{acct}/{agent}/{channel}` still fall to its own 404 instead of read as a stage id. the **credential holder** is whichever agent config verify the request — its adapter parse and reply, because the reply must come from the app that received it. the `channelRecords` row then pick who actually run; no record = the credential holder, exactly like before. on the bare URL two agents sharing one provider app both verify, so the scan sort by agentId and take the lowest — deterministic, but a stage URL or a record is the real answer. a stage URL that resolve to no agent is a 404 (`unknown_webhook_stage`), never a fall back to the account scan.
- a channel record **narrow and add, never grant**. `applyChannelRecord` is the one seam. do not let it hand out capability the agent lack, or reading an agent stop telling you its ceiling. instruction and policy are safe to add — a policy only ever refuse. **workspace is not**: attaching one is what materialise the sandbox file tools, so a record workspace the agent do not already attach get dropped. it shipped as a union first and that was an escalation path.
- a record's `replyIn` is **reply placement, not OPA** — the policy field is `policies`, and each policy document carries its own `mode`. it work by rewriting the message `source` once, right after the record resolve (`channelReplySource`), so the run, the refusal and any later background reply all route on the same rewritten source. only Slack implement `applyReplyIn`; every other provider deliver back to the one place the message came from, so there is nothing to choose.
- `denyTools` apply to the **finished** ToolSet in `harness/tools/index.ts`, not through `config.tools`. writing a sandbox tool name into `config.tools` throw "not a supported tool" and kill the whole run — and sandbox tools never appear there anyway, they come from the attached workspaces.
- on a `STORED_ITEM_PROVIDERS` provider (`harness/provider.ts` — openai, azure) an assistant message replay as a **reference** to the item the provider still hold, not as its content. so reasoning is not optional there: drop it and the `msg_` reference is refused. three rule fall out. persist reasoning (`isPersistedAssistantContentPart`). never prune it half-way — `pruneMessages` `reasoning: "before-last-message"` re-create the bug one turn later, it is all or nothing. and reasoning plus its item ids only replay to the **same** model, so projection strip both when the stored `model` differ, which is also what repair a conversation written before we recorded producers. `retryWithoutStoredItemsMiddleware` catch what slip through (item aged past 30 days, encrypted content from another model) and retry once with the whole stored-item state dropped.
- `src/shared/.generated/compaction-prompt.ts` is generated by `scripts/compaction-prompt.ts`. do not hand-edit. see `COMPACTION.md`.
- `src/shared/` is only for what **both** handlers really use. harness-only code stay in `src/harness/`.

## Shapes

- a **channel record** (`channelRecords`) is one row per real place a team talk — a Slack channel, a Discord channel, a repo — keyed `(account, platform, externalId)`. it bind that place to an agent and carry instructions, workspaces, `policies`, `denyTools`, `replyIn`, `workspaceScope`, `sandboxImages`, `tagRoles`. different thing from `config.channels`, which hold one adapter credentials.
- sandbox and workspace are separate account-scoped records (`sandboxConfig` / `workspaceConfig`). agent config point at them by id: `sandbox: "<id>"` + `workspaces: [{name, workspaceId}]`. CRUD live in the config plane; core keep lifecycle verbs only.
- a referenced sandbox expose Claude-Code-style tools — `bash` always, `read`/`write`/`edit`/`glob`/`grep` only when a workspace is attached too. approval follow sandbox `permissionMode` (`edit` / `ask` / `bypass`). search/research tools stay opt-in through `config.tools`.
- account model config under `config.model`: `provider`, `modelId`, normal Vercel AI SDK `streamText` settings, `providerOptions` for provider-specific options. provider constructor settings under `config.provider`.
- secrets by SST: `AdminAccountSecret`, `AccountConfigEncryptionSecret`. channel / provider / tool credentials live in the account encrypted config when they are account-specific.

## Adding Things

- **channel:** `src/shared/<channel>-channel.ts` implementing `ChannelAdapter` from `src/shared/channels.ts`, then wire normalize into `src/harness/integrations.ts`. reply send stay inside that channel `ChannelActions`. never hardcode channel logic into a shared handler or the agent loop. prefer the channel SDK formatter; hand-rolled formatting only when the provider ship no SDK.
- **bot command:** entry in the `commands` array in `src/shared/commands.ts`. command get channel-agnostic `ChannelActions` from `CommandContext`. never import a channel module from a command.
- **model provider:** add the name to `packages/convex/model/modelProviders.ts` (the source of truth — Convex can not import the AI SDK), then the `@ai-sdk/*` dep plus one line in `modelProviderFactories()` (`src/harness/provider.ts`). the `satisfies` there fail the build when the two drift. write **no** per-provider settings validation: what the provider factory accept is what we accept. the shared `apiKey`/`base_url`/`headers` checks in `normalizeProviderSettings` already cover every provider. the CLI read that same list, so nothing else need touching.
- a type the SDK reach through `shared/domain/*` must resolve to **source**: the rolled-up `dist/*.d.ts` externalise a bare `@broods/*` specifier, and `npm i broods` then can not resolve it — the union silently degrade to `any` under `skipLibCheck`. the `@broods/*` wildcard in `packages/broods/tsconfig.dts.json` already cover every workspace, so a new import need no new mapping.

## Style

on top of root style: every file open with a block docstring, one blank line before the first import.

```ts
/**
 * ...
 */

import ...
```

keep it short — what the file boundary is, what belong there, where near-by logic go. never list functions in it.

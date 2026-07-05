# apps/core Agent Guide

Scope: this file applies to `apps/core` (`@broods/core`) — the self-hosted AI agent harness: a single Bun container (Vercel AI SDK) serving the whole runtime behind the gateway. It is **off Lambda** (epic #85 phase 9); source lives under `src/` (not `functions/`). The AWS data plane (DynamoDB/S3/STS/Scheduler) and the MicroVM tool-exec backend stay. `sst.config.ts` provisions that data plane + the container's IAM user, not the runtime process itself.

Paths in this file are relative to `apps/core/` unless written with `../../`. If you started directly in this folder, also read `../../AGENTS.md` for the monorepo-wide rules.

Dependent workspaces (in this monorepo):

- `../../packages/convex` (`@broods/convex`): shared Convex backend. Core's storage adapter at `src/shared/storage/convex/` reads it; convex mode is active on **any stage that supplies both `CONVEX_URL` and `CONVEX_DEPLOY_KEY`** (production always does; dev does too since CI injects those secrets). Read `../../packages/convex/AGENTS.md` before changing Convex files.
- `../../packages/broods` (`broods`): CLI + SDK npm package that calls core through the gateway. Update its types/client when the public API or config shape changes.
- `../../packages/demos`: runnable demo folders against the API (deployed gateway or a local `bun run serve` core), importing the SDK. Keep them in sync with config changes.
- `../../apps/dashboard` (`@broods/dashboard`): Next.js dashboard sharing the Convex backend. Has its own AGENTS.md — read it before dashboard work.
- `../../apps/docs` (`@broods/docs`): Docusaurus docs site. Update docs and diagrams there when core behavior changes.

Related external repos (siblings of the monorepo checkout):

- `../../../infra`: infrastructure repo for the kubernetes cluster and VM provision. Keep `sst.config.ts` constants, naming pattern, and tag conventions aligned with it.
- `../../../lambda-sanbdox`: custom Lambda runtime for sandbox to run bash, node and python script, simulate VM machine.

Local workspace rules:

- Use Bun from the repo root for install/check/build scripts; run `sst` commands from `apps/core/`. `bun run serve` runs the container from source locally (`src/server.ts`, port 3000).
- Demos run from their own folder under `packages/demos/<name>/`, which loads that demo's local `.env`.
- Env files are per-package. Keep the matching `.env.example` files in sync with new env reads, and never commit real values.
- The core storage adapter reaches the Convex generated API via `require("@broods/convex/_generated/api")` on purpose — a typed import would drag every backend source into core's stricter typecheck. Keep it a require().
- `../../packages/convex/_generated/` is committed. After schema changes run `bun run --filter @broods/convex codegen` and commit the diff. The dashboard image build re-runs `convex deploy`.

Key rules:

- The whole runtime is one Bun container. `src/server.ts` is the single entry point: one `Bun.serve` process builds a transport-neutral `CoreRequest` from each HTTP request and routes **by path** (never Host — the gateway strips it) to the account or harness handler, streaming their Web `Response` back (SSE included). `scripts/build.ts` compiles it to `dist/core-server`; `apps/core/Dockerfile` builds `ghcr.io/beeblastco/broods-core`, deployed as k3s pods from the infra repo. There is no Lambda runtime.
- Two handlers, one process, split by path in `src/server.ts` (`routesToAccountManage`):
  - `src/accounts/handler.ts` — account creation, secret rotation, account metadata/config management (`/v1/account`, admin `/accounts/*` for account administration + rotate-secret only), sandbox lifecycle verbs, plus the `/v1/internal/observability-log` service-token leaf (the Convex config-audit bridge). Agent, skills, tools, workspace-files, cron, workspace, sandbox-config, and policy CRUD are NOT core routes: they live in the Convex config plane (`packages/convex/configHttp.ts`) and the gateway forwards `/v1/agents*` CRUD, `/v1/skills*`, `/v1/tools*`, `/v1/workspaces/{id}/files`, `/v1/crons*`, `/v1/workspaces*`, `/v1/sandboxes*` CRUD, and `/v1/policies*` there (`BROODS_CONFIG_URL`). Core keeps only their runtime paths (`POST /v1/agents/{id}` and scoped agent invocations, `src/shared/skills.ts`, tool bundle loading, workspace mount/S3 read helpers, sandbox lifecycle verbs, the harness `/v1/internal/cron-run` leaf) and account-deletion cleanup.
  - `src/harness/handler.ts` — everything else: account-authenticated direct API requests, async requests, status polling, supported account-scoped channel webhooks, and the `/v1/internal/cron-run` service-token leaf. It normalizes requests through `src/harness/integrations.ts`, runs the agent loop in `src/harness/harness.ts`, persists conversation state in `src/harness/session.ts`, and emits SSE only for sync direct API callers.
- Handlers speak the Web contract in `src/shared/http.ts`: `CoreHandler = (request: CoreRequest, ctx: RequestContext) => Promise<Response>`. Post-response work uses `ctx.waitUntil(...)` (there is no Lambda `afterResponse`); response helpers `jsonResponse/textResponse/errorResponse` return a `Response`. The async self-invoke fan-out runs in-process (`dispatchInProcessWorker` in `src/harness/handler.ts`) and background-job callbacks use `PUBLIC_BASE_URL` (no Function-URL discovery). Cron runs off Lambda: EventBridge Scheduler → HTTPS → gateway `/v1/internal/cron-run` (service-token auth) → `handleScheduledCron`.
- To add a new non-workspace tool: create `src/harness/tools/<name>.tool.ts`, export a default tool factory, put the tool logic directly inside each tool's `execute`, register that factory in `src/harness/tools/index.ts`, and add account option validation in `src/shared/accounts.ts` only when the tool has account-level options.
- `src/harness/tools/index.ts` is the static factory registry and account-configured selector used to ensure tool files are bundled into the compiled binary.
- Custom tools run inline inside the harness during the streaming request. Do not add queue-based tool execution or external tool-Lambda wiring unless the architecture intentionally changes. (The MicroVM sandbox backend that runs untrusted bash/python is a separate tool-exec plane and stays.)
- Sandbox and workspace are independent, account-scoped records (tables `sandboxConfig`/`workspaceConfig`), referenced from agent config by id: `sandbox: "<id>"` + `workspaces: [{name, workspaceId}]`. A referenced sandbox exposes the Claude-Code-style tools (`bash` always; `read`/`write`/`edit`/`glob`/`grep` when a workspace is also attached); approvals follow the sandbox `permissionMode` (`edit`/`ask`/`bypass`). Search/research tools remain opt-in through `config.tools`. CRUD for both lives in the Convex config plane; core keeps sandbox lifecycle verbs only.
- Google Search lives in `src/harness/tools/google-search.tool.ts` and is enabled through `config.tools.googleSearch`.
- Account provider constructor settings live under `config.provider`. Account model configuration lives under `config.model`: `provider`, `modelId`, normal Vercel AI SDK `streamText` settings, and `providerOptions` for provider-specific AI SDK options.
- Shared code goes in `src/shared/` only when it is actually shared by both handlers. Keep harness-only code in `src/harness/`.
- File header comments must use a block-docstring style:

  ```ts
  /**
   * ...
   */

  import ...
  ```

- Leave one blank line between the file header docstring and the first import or code line.
- Keep file header docstrings short. They should describe the file boundary, what belongs there, and where adjacent logic should go. Do not turn them into a function inventory.
- Use `bun run build` to compile the container binary (`dist/core-server`); `bun run serve` runs it from source locally. `sst.config.ts` provisions the AWS data plane + container IAM user (not the runtime); only the `dev` stage exists. Do not deploy except when the user asks to.
- Priority to push to `dev` or `main` branch and let CI/CD workflows handle deployment.
- To add a new communication channel (e.g. Slack, WhatsApp): create `src/shared/<channel>-channel.ts` implementing the `ChannelAdapter` interface from `src/shared/channels.ts`, then wire the normalization path into `src/harness/integrations.ts`. Reply sending should stay inside that channel's `ChannelActions`; do not hardcode channel-specific logic into shared handlers or the core agent loop.
- To add a new bot command: add an entry to the `commands` array in `src/shared/commands.ts` with aliases, description, and an execute function. Commands receive a `CommandContext` with a channel-agnostic `ChannelActions` interface — do not import channel-specific modules from commands.
- Reply formatting should prefer the channel SDK/adapter formatter when one exists. New custom formatting should stay in the channel module only when the provider lacks SDK support.
- Core secrets are managed via SST: `AdminAccountSecret` and `AccountConfigEncryptionSecret`. Channel, provider, and tool credentials live in each account's encrypted config when they are account-specific.

Remember:

- The main flow is `incoming request -> integrations.ts -> handler.ts -> session.ts -> harness.ts -> optional channel reply`.
- Keep the SSE streaming path intact when simplifying code (handlers return a streaming Web `Response`). Do not replace it unless that change is intentional.
- The active persistence layer for the harness lives in `src/harness/session.ts`.
- `src/harness/handler.ts` should stay thin and orchestration-focused.
- `src/harness/integrations.ts` owns request normalization and channel/webhook routing.
- `src/harness/harness.ts` owns the model/tool execution loop.
- Existing tools live in `src/harness/tools/`.
- Update docs, examples, and tests file when changes somethings, refactoring something from the original code or added new features. Make sure that when writing the docs, only added in the suitable files, don’t add in every files, avoid writing too much, focus on visualization, diagrams. Remember to update diagrams as well.
- Please check for the interface, some interface can be import directly from the ai-sdk vercel library or other library. Don't over doing this, don't create new interface where we can reuse the interface from the library. Always double check when you want to create new interface or new types.
- Don't over engineering new features or patch fixes. Keep it simple and keep it elegant. Keep the code readable and easy to visible, easy to navigate. Don't put too much abstraction and functions if it is not necessary.

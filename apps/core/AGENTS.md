# apps/core Agent Guide

Scope: this file applies to `apps/core` (`@broods/core`) — the serverless AI agent harness on AWS (Lambda + Vercel AI SDK + SST) and the future Rust port boundary.

Paths in this file are relative to `apps/core/` unless written with `../../`. If you started directly in this folder, also read `../../AGENTS.md` for the monorepo-wide rules.

Dependent workspaces (in this monorepo):

- `../../packages/convex` (`@broods/convex`): shared Convex backend. Core's storage adapter at `functions/_shared/storage/convex/` reads it; convex mode is active on **any stage that supplies both `CONVEX_URL` and `CONVEX_DEPLOY_KEY`** (production always does; dev does too since CI injects those secrets). Read `../../packages/convex/AGENTS.md` before changing Convex files.
- `../../packages/broods` (`broods`): CLI + SDK npm package that calls core's deployed Function URLs. Update its types/client when the public API or config shape changes.
- `../../packages/demos`: runnable demo folders against the deployed API, importing the SDK. Keep them in sync with config changes.
- `../../apps/dashboard` (`@broods/dashboard`): Next.js dashboard sharing the Convex backend. Has its own AGENTS.md — read it before dashboard work.
- `../../apps/docs` (`@broods/docs`): Docusaurus docs site. Update docs and diagrams there when core behavior changes.

Related external repos (siblings of the monorepo checkout):

- `../../../infra`: infrastructure repo for the kubernetes cluster and VM provision. Keep `sst.config.ts` constants, naming pattern, and tag conventions aligned with it.
- `../../../lambda-sanbdox`: custom Lambda runtime for sandbox to run bash, node and python script, simulate VM machine.

Local workspace rules:

- Use Bun from the repo root for install/check/build scripts; run `sst` commands from `apps/core/`.
- Demos run from their own folder under `packages/demos/<name>/`, which loads that demo's local `.env`.
- Env files are per-package. Keep the matching `.env.example` files in sync with new env reads, and never commit real values.
- The core storage adapter reaches the Convex generated API via `require("@broods/convex/_generated/api")` on purpose — a typed import would drag every backend source into core's stricter typecheck. Keep it a require().
- `../../packages/convex/_generated/` is committed. After schema changes run `bun run --filter @broods/convex codegen` and commit the diff. The dashboard image build re-runs `convex deploy`.

Key rules:

- Each Lambda function lives in its own folder under `functions/` with a `bootstrap.ts` entry point for the Bun custom runtime.
- Default runtime is Bun on Lambda `provided.al2023` with ARM64 binaries built by `scripts/build.ts`.
- The deployed architecture uses two public Lambdas:
  - `account-manage` — account creation, account secret rotation, and account metadata/config management.
  - `harness-processing` — streaming Function URL (`RESPONSE_STREAM` invoke mode). It accepts account-authenticated direct API requests, async requests, status polling, and supported account-scoped channel webhooks. It normalizes them through `functions/harness-processing/integrations.ts`, runs the agent loop in `functions/harness-processing/harness.ts`, persists conversation state in `functions/harness-processing/session.ts`, and emits SSE only for sync direct API callers.
- The custom Bun runtime used by the deployed path is `startStreamingRuntime` from `functions/_shared/runtime.ts`. It passes the full Lambda Function URL event envelope into the handler so request routing can distinguish direct API traffic from supported webhook traffic and return channel-specific HTTP responses.
- To add a new non-workspace tool: create `functions/harness-processing/tools/<name>.tool.ts`, export a default tool factory, put the tool logic directly inside each tool's `execute`, register that factory in `functions/harness-processing/tools/index.ts`, and add account option validation in `functions/_shared/accounts.ts` only when the tool has account-level options.
- `functions/harness-processing/tools/index.ts` is the static factory registry and account-configured selector used to ensure tool files are bundled into the compiled Lambda binary.
- Custom tools run inline inside `harness-processing` during the streaming request. Do not add queue-based tool execution or external tool-Lambda wiring unless the architecture intentionally changes.
- Sandbox and workspace are independent, account-scoped records (tables `sandboxConfig`/`workspaceConfig`), referenced from agent config by id: `sandbox: "<id>"` + `workspaces: [{name, workspaceId}]`. A referenced sandbox exposes the Claude-Code-style tools (`bash` always; `read`/`write`/`edit`/`glob`/`grep` when a workspace is also attached); approvals follow the sandbox `permissionMode` (`edit`/`ask`/`bypass`). Search/research tools remain opt-in through `config.tools`. CRUD for both lives in `account-manage` (`/accounts/me/{sandboxes,workspaces}`).
- Google Search lives in `functions/harness-processing/tools/google-search.tool.ts` and is enabled through `config.tools.googleSearch`.
- Account provider constructor settings live under `config.provider`. Account model configuration lives under `config.model`: `provider`, `modelId`, normal Vercel AI SDK `streamText` settings, and `providerOptions` for provider-specific AI SDK options.
- Shared code goes in `functions/_shared/` only when it is actually shared by multiple Lambdas. Keep harness-only code in `functions/harness-processing/`.
- File header comments must use a block-docstring style:

  ```ts
  /**
   * ...
   */

  import ...
  ```

- Leave one blank line between the file header docstring and the first import or code line.
- Keep file header docstrings short. They should describe the file boundary, what belongs there, and where adjacent logic should go. Do not turn them into a function inventory.
- Use `bun run build` to compile all functions, then `bun run deploy` to deploy from local. Do not use local deploy except when the user ask to. Only have the `dev` stage.
- Priority to push to `dev` or `main` branch and let CI/CD workflows handle deployment.
- To add a new communication channel (e.g. Slack, WhatsApp): create `functions/_shared/<channel>-channel.ts` implementing the `ChannelAdapter` interface from `functions/_shared/channels.ts`, then wire the normalization path into `functions/harness-processing/integrations.ts`. Reply sending should stay inside that channel's `ChannelActions`; do not hardcode channel-specific logic into shared handlers or the core agent loop.
- To add a new bot command: add an entry to the `commands` array in `functions/_shared/commands.ts` with aliases, description, and an execute function. Commands receive a `CommandContext` with a channel-agnostic `ChannelActions` interface — do not import channel-specific modules from commands.
- Reply formatting should prefer the channel SDK/adapter formatter when one exists. New custom formatting should stay in the channel module only when the provider lacks SDK support.
- Core secrets are managed via SST: `AdminAccountSecret` and `AccountConfigEncryptionSecret`. Channel, provider, and tool credentials live in each account's encrypted config when they are account-specific.

Remember:

- The main flow is `incoming request -> integrations.ts -> handler.ts -> session.ts -> harness.ts -> optional channel reply`.
- Keep the Function URL SSE path intact when simplifying code. Do not replace it with synthesized events unless that change is intentional.
- The active persistence layer for harness-processing lives in `functions/harness-processing/session.ts`.
- `functions/harness-processing/handler.ts` should stay thin and orchestration-focused.
- `functions/harness-processing/integrations.ts` owns request normalization and channel/webhook routing.
- `functions/harness-processing/harness.ts` owns the model/tool execution loop.
- Existing tools live in `functions/harness-processing/tools/`.
- Update docs, examples, and tests file when changes somethings, refactoring something from the original code or added new features. Make sure that when writing the docs, only added in the suitable files, don’t add in every files, avoid writing too much, focus on visualization, diagrams. Remember to update diagrams as well.
- Please check for the interface, some interface can be import directly from the ai-sdk vercel library or other library. Don't over doing this, don't create new interface where we can reuse the interface from the library. Always double check when you want to create new interface or new types.
- Don't over engineering new features or patch fixes. Keep it simple and keep it elegant. Keep the code readable and easy to visible, easy to navigate. Don't put too much abstraction and functions if it is not necessary.

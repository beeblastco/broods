# Demos

Small runnable examples for the declarative `broods` SDK and deployed service.

Run demos from their own folder:

```bash
bun run dev
bun run start
```

Use `.env.local` for local runtime settings. SDK clients automatically read the
runtime key from `BROODS_API_KEY`, which `bun run dev`/`bun run deploy`
writes for the selected environment.
WebSocket demos use the same `BROODS_BASE_URL` or `BROODS_HOST` override as
HTTP clients. The hosted SDK default is `gateway.broods.app`.

## Run against a local core

The core now runs as a single container (`apps/core`, off Lambda) — you can run
it on your machine against the **real** Convex backend (the database
doesn't change), then aim the demos at it:

```bash
# 1. Start the core locally (serves http://localhost:3000, path-routed).
cd apps/core && bun run serve          # fill apps/core/.env first — see its .env.example

# 2. In the demo's .env.local (or packages/demos/.env), point the SDK at it:
#    BROODS_BASE_URL=http://localhost:3000
#    BROODS_API_KEY=fp_agent_...        # a runtime key for the demo account

# 3. Run the demo from its own folder.
cd packages/demos/basic-stream && bun run start
```

The SDK resolves its target from `BROODS_BASE_URL` / `BROODS_HOST` (falling back
to `gateway.broods.app`), so this swaps only the base URL — see
`packages/demos/.env.example`.

- `basic-stream`: stream an agent over SSE.
- `basic-async`: start `/async`, then poll by the returned status id.
- `cron`: create a scheduled agent run with the SDK cron helper.
- `websocket`: stream a deployed endpoint with `WebsocketClient`.
- `channel-telegram`, `channel-github`, `channel-slack`, `channel-discord`, `channel-pancake`, `channel-zalo`: declare provider channels and receive generated webhook URLs.
- `tool-custom-stream`: upload and stream an isolated custom tool.
- `tool-custom-async-sse`: upload a detached asynchronous custom tool.
- `policy-enforcement-lambda`: compare OPA policy `audit` vs `enforce` behavior against the AWS Lambda MicroVM sandbox using Bedrock MiniMax.

Sandbox examples (one `defineSandbox` per provider/mode):

- `sandbox`: stateless, bash-only self-hosted `sandbox` (workdir) — code exec, config env var, internet egress.
- `sandbox-workspace`: workspace-backed `sandbox` — file tools on the shared S3 workspace mount.
- `sandbox-workspace-persistent`: reserved (persistent) `sandbox` with package persistence + a background job via `async_status`.
- `sandbox-lambda`: stateless, bash-only `lambda` (AWS Lambda MicroVM).
- `sandbox-workspace-lambda`: persistent workspace-backed `lambda` MicroVM.
- `sandbox-workspace-daytona`, `sandbox-vercel`, `sandbox-e2b`, `sandbox-workspace-override`: provider-specific sandbox configs.

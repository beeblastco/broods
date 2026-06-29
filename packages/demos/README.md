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
The WebSocket demo uses the SDK default runtime host, `gateway.broods.app`; only
set `BROODS_WEBSOCKET_URL` for a non-default or self-hosted gateway.

- `basic-stream`: stream an agent over SSE.
- `basic-async`: start `/async`, then poll by the returned status id.
- `cron`: create a scheduled agent run with the SDK cron helper.
- `websocket`: stream a deployed endpoint with `WebsocketClient`.
- `channel-telegram`, `channel-github`, `channel-slack`, `channel-discord`, `channel-pancake`, `channel-zalo`: declare provider channels and receive generated webhook URLs.
- `tool-custom-stream`: upload and stream an isolated custom tool.
- `tool-custom-async-sse`: upload a detached asynchronous custom tool.

Sandbox examples (one `defineSandbox` per provider/mode):

- `sandbox`: stateless, bash-only self-hosted `sandbox` (workdir) — code exec, config env var, internet egress.
- `sandbox-workspace`: workspace-backed `sandbox` — file tools on the shared S3 workspace mount.
- `sandbox-workspace-persistent`: reserved (persistent) `sandbox` with package persistence + a background job via `async_status`.
- `sandbox-lambda`: stateless, bash-only `lambda` (AWS Lambda MicroVM).
- `sandbox-workspace-lambda`: workspace-backed `lambda` MicroVM.
- `sandbox-workspace-daytona`, `sandbox-vercel`, `sandbox-e2b`, `sandbox-workspace-override`: provider-specific sandbox configs.

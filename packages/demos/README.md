# Demos

Small runnable examples for the declarative `filthy-panty` SDK and deployed service.

Run demos from their own folder:

```bash
bun run dev
bun run start
```

Use `.env.local` for local runtime settings. SDK demos use the runtime key in
`FILTHY_PANTY_API_KEY`, which `bun run dev`/`bun run deploy` writes for the
selected environment.
The WebSocket demo uses the SDK default runtime host, `app.beeblast.co`; only
set `FILTHY_PANTY_WEBSOCKET_URL` for a non-default or self-hosted gateway.

- `basic-stream`: stream an agent over SSE.
- `basic-async`: start `/async`, then poll by the returned status id.
- `cron`: create a scheduled agent run with the SDK cron helper.
- `websocket`: stream a deployed endpoint with `WebsocketClient`.

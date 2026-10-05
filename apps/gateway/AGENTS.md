# apps/gateway

The WebSocket server. Traefik is the front door: it routes HTTP straight to core or the Convex config plane, limits per client address and sets CORS (`apps/edge`), and sends the gateway only health checks and socket upgrades. `src/main.ts` is the only entry (`bun src/main.ts`); there is no `index.ts`, it was removed. paths relative to `apps/gateway/`.

## Gotchas

- **it imports core source by relative path**, not as a package: `../../core/src/shared/nats.ts`, `../../core/src/shared/terminal-ticket.ts`. the `Dockerfile` copies each of those files by name, so a new cross-workspace import needs a `COPY` line too. so a rename inside `apps/core/src/shared/` break the gateway build even though nothing declare a dependency. move those files, grep here.
- **which request reaches the gateway is `apps/edge/src/routes.ts`, not this app.** a new socket path needs a route there and a branch in `route()` here. anything else that lands here is a 404.
- four WebSocket surfaces: `src/agent.ts` (agent runs), `src/observability.ts` (live telemetry), `src/terminal.ts` (sandbox PTY, and the `broods machine` daemon socket on the same relay). terminal upgrades are ticket-authenticated through the shared `terminal-ticket.ts`; the machine socket carries the daemon's own bearer to core (`BROODS_CORE_URL`), whose close codes pass through.
- **the gateway holds one secret, `TERMINAL_TICKET_SECRET`, and must never hold the service token.** it stamps `x-broods-via-gateway` on every call it makes to core (the scope lookup, the agent socket, the machine relay), and core refuses the service token when that header is there, so a new upstream call from here must carry it too.
- the browser-origin check and `src/rate-limiter.ts` gate upgrades. the limiter counts failed socket logins per client address (`GATEWAY_AUTH_FAILURES_PER_MINUTE`); it needs the credential result, which is why it lives here and not in Traefik. it is a security control, not a nicety. keep it in front of the token check.

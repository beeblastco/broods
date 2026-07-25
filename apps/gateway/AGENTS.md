# apps/gateway

`@broods/gateway` — the front door. every public request land here before anything else. `src/main.ts` is the only entry (`bun src/main.ts`); there is no `index.ts`, it was removed. paths relative to `apps/gateway/`.

## Gotchas

- **it imports core source by relative path**, not as a package: `../../core/src/shared/nats.ts`, `../../core/src/shared/terminal-ticket.ts`. so a rename inside `apps/core/src/shared/` break the gateway build even though nothing declare a dependency. move those files, grep here.
- **it strips Host before forwarding.** core route by path only and cannot see the original Host. do not add Host-based logic on either side.
- `src/routes.ts` is the split. `isConfigHttpPath` decide what go to the Convex config plane (`BROODS_CONFIG_URL`) and `isCoreHttpRoute` what go to core (`BROODS_CORE_URLS`). the config list is **method-aware** — `/v1/account` is config only for GET/PATCH, `/accounts` only for GET. add a route in core or the config plane and you must teach `routes.ts` about it, or it lands on the wrong upstream.
- three WebSocket surfaces, each with its own module: `src/agent.ts` (agent runs), `src/observability.ts` (live telemetry), `src/terminal.ts` (sandbox PTY). terminal upgrades are ticket-authenticated through the shared `terminal-ticket.ts`.
- `src/rate-limiter.ts` gate auth failures and upgrades, tuned by `GATEWAY_AUTH_FAILURES_PER_MINUTE` and `GATEWAY_UPGRADES_PER_MINUTE`. it is a security control, not a nicety — keep it in front of the upgrade path.
- env surface: `BROODS_CONFIG_URL`, `BROODS_CORE_URLS`, `NATS_URL`, `NATS_TOKEN`, `LOKI_URL`, `TEMPO_URL`, `PORT`, `BIND_HOST`, `HOSTNAME`.

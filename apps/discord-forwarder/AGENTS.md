# apps/discord-forwarder

Holds the Discord Gateway sockets nobody else does. `src/main.ts` is the only entry (`bun src/main.ts`). paths relative to `apps/discord-forwarder/`.

Discord POSTs interactions — slash commands, buttons — to `interactions_endpoint_url` over plain HTTP, but regular messages only ever arrive over a Gateway WebSocket. That is a Discord routing rule, not a setting. So without this process a Discord agent answers `/new` and silently ignores every mention, which reads as a broken agent rather than missing infrastructure.

It polls the config plane, opens one socket per Discord bot token, and POSTs each `MESSAGE_CREATE` to that token's channel webhooks in the shape core's Discord adapter already accepts:

```
POST {BROODS_WEBHOOK_BASE_URL}/webhooks/{accountId}/dev/{endpointId}/discord
x-discord-gateway-token: <bot token>

{ "type": "GATEWAY_MESSAGE_CREATE", "data": { ...MESSAGE_CREATE } }
```

## Gotchas

- **one socket per token, not per agent.** Discord permits several connections with identical shard tuples and sends every event to all of them, so two sockets on one token means every message twice. `src/supervisor.ts` keys the socket map on the bot token and fans one event out to every webhook that token serves. two agents sharing a token both run, and it logs a warning saying so.
- **the IDENTIFY allowance is the thing to protect.** 1000 IDENTIFYs per token per 24h, and past that Discord terminates every session, **resets the bot token**, and emails the owner. a 5s reconnect loop burns 1000 in 83 minutes, and one crash-looping pod holding many tenants' tokens gets all of them reset. two guards: `src/backoff.ts` caps the retry interval (300s default, so under 300 IDENTIFYs a day even for a socket that never succeeds), and `src/identify-budget.ts` counts them per token and parks the socket instead of dialling past the limit. the counter is in-process and a pod restart forgets it — the ceiling is the real defence, the counter is the belt.
- **fatal close codes must not be retried.** `FATAL_CLOSE_CODES` in `src/discord.ts` lists them; 4014 in particular means Message Content Intent is off in the developer portal, and its log line says so by name. reconnecting on any of these spends budget on a request that cannot start succeeding.
- **liveness and readiness are different paths.** `/healthz` answers while the process is alive, `/readyz` waits on the first successful config-plane poll. probing liveness on the config plane would turn a Convex outage into a restart loop, which is the one thing the IDENTIFY budget cannot survive.
- **it imports two core modules by relative path**, not as a package: `../../core/src/shared/env.ts` and `../../core/src/shared/convex/client.ts`. rename either and this build breaks with nothing declaring the dependency. the Dockerfile copies them by name too.
- **it forwards Discord's payload, it does not normalize it.** the one addition is `thread`, which Discord genuinely omits from `MESSAGE_CREATE` — inside a thread `channel_id` _is_ the thread and the parent is unsaid, and core needs both to key the conversation the same way the slash-command path does. `author.bot` is left absent for human authors because core's `isGatewayMessage` accepts that; putting the same rule in two places would leave every other forwarder still broken. **opening** a thread on a mention is a product decision and does not live here — see the `replyIn` follow-up on issue #320.

## Why its own deployment

`apps/gateway` already holds long-lived connections and could read the same configs, but sockets there mean pinning the front door to one replica forever. `kubernetes/charts/app` in `../infra` is `replicaCount: 1` with no `strategy`, so the default RollingUpdate surges to a second pod on every deploy — and a second pod means a second socket per token, which is duplicate delivery plus a doubled IDENTIFY rate. A separate release with `strategy: Recreate` closes that window and leaves the gateway free to scale.

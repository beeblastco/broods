# apps/discord-forwarder

Holds the Discord Gateway sockets nobody else does. `src/main.ts` is the only entry (`bun src/main.ts`). paths relative to `apps/discord-forwarder/`.

Discord POSTs interactions — slash commands, buttons — to `interactions_endpoint_url` as an ordinary HTTPS request, but regular messages only ever arrive over a Gateway WebSocket. That is a Discord routing rule, not a setting. So without this process a Discord agent answers `/new` and silently ignores every mention, which reads as a broken agent rather than missing infrastructure.

It subscribes to every config plane it is given over a Convex websocket (the connections query re-runs only when a plane's rows change, so there is no standing poll), opens one socket per Discord bot token, and POSTs each `MESSAGE_CREATE` to that token's channel webhooks in the shape core's Discord adapter already accepts:

```text
POST {plane webhookBaseUrl}/webhooks/{accountId}/dev/{endpointId}/discord
x-discord-gateway-token: <bot token>

{ "type": "GATEWAY_MESSAGE_CREATE", "data": { ...MESSAGE_CREATE } }
```

## Gotchas

- **one socket per token, not per agent.** Discord permits several connections with identical shard tuples and sends every event to all of them, so two sockets on one token means every message twice. `src/supervisor.ts` keys the socket map on the bot token and fans one event out to every webhook that token serves. two agents sharing a token both run, and it logs a warning saying so.
- **one process for every config plane, not one per stage.** `BROODS_CONFIG_PLANES` lists the Convex deployments to read, each with its own deploy key and gateway front door. dev and prod are separate Convex deployments but one forwarder, because the one-socket-per-token rule above is a property of the token and nothing stops the same bot token being deployed to both — two forwarders would then each hold a socket for it. `src/connections.ts` isolates the planes: one that fails contributes whatever it last answered, so its sockets survive the blip while every healthy plane still reconciles, and one that has never answered contributes nothing — which is what lets this process serve a deployment whose backend is not live yet. With no poll to reject, total silence simply never fires a reconcile, and readiness stays false until the first plane answers.
- **the IDENTIFY allowance is the thing to protect.** past 1000 IDENTIFYs per token per 24h Discord terminates every session, **resets the bot token**, and emails the owner — so one crash-looping pod holding many tenants' tokens gets all of them reset. `src/identify-budget.ts` carries the full reasoning; the short version is that the backoff ceiling in `src/backoff.ts` bounds the rate and the per-token counter parks a socket rather than dial past the limit.
- **fatal close codes must not be retried.** `FATAL_CLOSE_CODES` in `src/discord.ts` lists them; 4014 in particular means Message Content Intent is off in the developer portal, and its log line says so by name. reconnecting on any of these spends budget on a request that cannot start succeeding.
- **the resume host is a credential decision.** the RESUME frame carries the bot token, and READY names its own host in `resume_gateway_url`. `resumeGatewayUrl` in `src/discord.ts` does not use the name as given: it keeps one validated DNS label and rebuilds the URL onto a literal `.discord.gg`, so the dial cannot leave Discord no matter what READY says. Following a redirect would hand the token to whoever named the host. `heartbeat_interval` from HELLO is clamped for the same reason — an unbounded value from the wire becomes a hot loop.
- **liveness and readiness are different paths.** `/healthz` answers while the process is alive, `/readyz` waits on the first config-plane snapshot. probing liveness on the config plane would turn a Convex outage into a restart loop, which is the one thing the IDENTIFY budget cannot survive.
- **the config-plane read is not Discord-specific.** `channel/connections.listConnections` in `packages/convex` takes a channel name; `src/connections.ts` is the caller that asks for `discord`. no other channel needs a forwarder today, because Telegram, Slack, Zalo, GitHub and Pancake all receive regular messages on a registered webhook URL. Discord is the exception, not the pattern.
- **it imports two core modules by relative path**, not as a package: `../../core/src/shared/env.ts` and `../../core/src/shared/convex/client.ts`. rename either and this build breaks with nothing declaring the dependency. the Dockerfile copies them by name too.
- **it forwards Discord's payload, it does not normalize it.** the one addition is `thread`, which Discord genuinely omits from `MESSAGE_CREATE` — inside a thread `channel_id` _is_ the thread and the parent is unsaid, and core needs both to key the conversation the same way the slash-command path does. `author.bot` is left absent for human authors because core's `isGatewayMessage` accepts that; putting the same rule in two places would leave every other forwarder still broken. **opening** a thread on a mention is a product decision and does not live here — see the `replyIn` follow-up on issue #320.

## Why its own deployment

`apps/gateway` already holds long-lived connections and could read the same configs, but sockets there mean pinning the front door to one replica forever. `kubernetes/charts/app` in `../infra` is `replicaCount: 1` with no `strategy`, so the default RollingUpdate surges to a second pod on every deploy — and a second pod means a second socket per token, which is duplicate delivery plus a doubled IDENTIFY rate. A separate release with `strategy: Recreate` closes that window and leaves the gateway free to scale.

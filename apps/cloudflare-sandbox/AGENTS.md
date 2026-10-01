# apps/cloudflare-sandbox

Bridge Worker behind core's `cloudflare` sandbox provider. `src/index.ts` is the only source: the authenticated `fetch` router and the `Sandbox` Durable Object. paths relative to `apps/cloudflare-sandbox/`.

The Container API (`ctx.container`) only answers inside a Durable Object, so core cannot reach it directly. `apps/core/src/harness/sandbox/cloudflare-executor.ts` is the only caller, plus the gateway opening `/terminal` from a sealed terminal ticket. route shapes are in `apps/docs/docs/internals/sandboxes.md#cloudflare`.

## Gotchas

- **keep it dumb.** reservations, ids, env merging, the working directory and the output limit all come from core. the bridge runs exactly the argv it is given. a rule added here is a rule core and its tests cannot see.
- this is Sandbox SDK 1.0: our own Durable Object drives `ctx.container`. the 0.x `Sandbox` class, `getSandbox`, `sleepAfter` and `keepAlive` are gone. `@cloudflare/sandbox` now only ships `Files`, `S3Mount` and `DirectoryBackup`; nothing here needs them yet, so it is not a dependency.
- a Container that sleeps loses its disk. `setInactivityTimeout` is reapplied on every exec because a restarted Durable Object forgets it.
- `scheduling_policy: "durable_object"` containers take no `max_instances` or `instance_type` in `wrangler.jsonc`; the instance type rides `start()`. `npx wrangler types <out>` validates the config without deploying.
- the Worker and core must agree on `SANDBOX_API_KEY` = core's `CLOUDFLARE_SANDBOX_API_KEY`. set it with `wrangler secret put SANDBOX_API_KEY`. never deploy from a branch.
- `bun run check` is types only, against `@cloudflare/workers-types`. there is no runtime test here: the executor tests in core mock this bridge, and `workerd` with containers needs Docker and a Cloudflare account.

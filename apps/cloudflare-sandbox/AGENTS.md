# apps/cloudflare-sandbox

Bridge Worker behind core's `cloudflare` sandbox provider. `src/index.ts` is the only source: the authenticated `fetch` router and the `Sandbox` Durable Object. paths relative to `apps/cloudflare-sandbox/`.

The Container API (`ctx.container`) only answers inside a Durable Object, so core cannot reach it directly. `apps/core/src/harness/sandbox/cloudflare-executor.ts` is the only caller, plus the gateway opening `/terminal` from a sealed terminal ticket. route shapes are in `apps/docs/docs/internals/sandboxes.md#cloudflare`.

## Gotchas

- **keep it dumb.** reservations, ids, env merging, the working directory and the output limit all come from core. the bridge runs exactly the argv it is given, under GNU `timeout -k` so the deadline kills the whole process group (124/137 read as timed out). a rule added here is a rule core and its tests cannot see.
- never abort a `container.exec` that already exited: workerd throws it uncaught. the exec deadline is a cleared backstop timer, and the terminal only aborts a shell still running.
- `exec` answers core's `SandboxExecResponse`; `ExecResult` is derived from that type, so a contract change fails `check` here.
- this is Sandbox SDK 1.0: our own Durable Object drives `ctx.container`. the 0.x `Sandbox` class, `getSandbox`, `sleepAfter` and `keepAlive` are gone. `@cloudflare/sandbox` now only ships `Files`, `S3Mount` and `DirectoryBackup`; nothing here needs them yet, so it is not a dependency.
- a Container that sleeps loses its disk. `#ensureRunning` shares one start between concurrent first calls and reapplies `setInactivityTimeout` once per Durable Object instance, because a restarted one forgets it. the first `exec()` after `start()` waits for readiness itself.
- `scheduling_policy: "durable_object"` containers take no `max_instances` or `instance_type` in `wrangler.jsonc`; the instance type rides `start()`. `npx wrangler types <out>` validates the config without deploying.
- a terminal ticket carries a `terminal-token.ts` token, not the API key: an HMAC of one sandbox id and an expiry, signed with `SANDBOX_API_KEY`, accepted only on that sandbox's `/terminal`. core imports the same file to sign it. never put the API key back in a ticket; the gateway is not meant to hold it.
- `sst deploy` ships one Worker per stage with this workspace's `deploy` script (`deployCloudflareWorker` in `apps/core/sst.config.ts`), named `resourceName("sandbox")`, when the deploy has `CLOUDFLARE_API_TOKEN`. it reruns only when a file here changes; `bun.lock` is left out, since zod is bundled.
- `scripts/deploy.ts` builds the image only when the `Dockerfile` changes, as `broods-sandbox:<Dockerfile hash>` shared by every stage, and deploys a gitignored copy, `wrangler.deploy.json`, named for the stage and pinned to that image's digest. the Dockerfile is the whole build context: a `COPY` would need the hash to cover what it copies.
- wrangler names the Container application `<name>-sandbox` from the config, not `--name` (workers-sdk#15827), hence the copy. `name` and `dockerfile` in `wrangler.jsonc` are only for `wrangler dev`.
- the deploy needs a user API token (the Containers API refuses account tokens), `CLOUDFLARE_ACCOUNT_ID`, and Docker only when it builds.
- the Worker and core must agree on `SANDBOX_API_KEY` = core's `CLOUDFLARE_SANDBOX_API_KEY`. the infra repo generates it and writes it to both; a Worker without it refuses every call, terminal tokens included. never deploy from a branch or an agent session.
- `bun run check` is types only, against `@cloudflare/workers-types`. there is no runtime test here: the executor tests in core mock this bridge, and `workerd` with containers needs Docker and a Cloudflare account.

# apps/cloudflare-isolate

Worker behind core's `isolate` sandbox provider: bash in a V8 isolate, no container, no Durable Object. `src/index.ts` is the authenticated `fetch` router; `src/runtime.ts` is what each sandbox's isolate runs (just-bash, a bash in TypeScript with its own in-memory disk); `src/vfs-state.ts` turns that disk into bytes for R2 and back. paths relative to `apps/cloudflare-isolate/`.

core's `apps/core/src/harness/sandbox/isolate-executor.ts` is the only caller. route shapes are in `apps/docs/docs/internals/sandboxes.md#isolate`.

## Gotchas

- **keep it dumb.** reservations, ids, env merging, the working directory and the output limit all come from core; the Worker runs exactly the script it is given. a rule added here is a rule core and its tests cannot see.
- one isolate per sandbox id, loaded with `LOADER` (Dynamic Workers) from `.generated/runtime.txt`, which `bun run build` writes from `src/runtime.ts`. the loader caches by id, and a loaded isolate's network and CPU limit are fixed, so the id carries both. `check`, `dev`, `deploy` and the tests build first; the file is gitignored.
- `exec` answers core's `SandboxExecResponse`; `ExecResult` in `contract.ts` is derived from that type, so a contract change fails `check` here. `duration_ms` is the host's wall clock around the RPC: inside an isolate the clock only moves on I/O.
- a sandbox's files live in R2 under `sandboxes/<id>` only when the call says `persist`; an ephemeral call runs on an empty disk and stores nothing. the stored bytes are the gzip of the paths a command wrote; the shell's own layout is rebuilt from scratch every time. `MAX_STATE_BYTES` caps one object, and a disk past it stays as it was.
- `limits.cpuMs` on the loaded isolate is the real guard for a busy command: just-bash's deadline fires only when the shell waits on something, and `Date.now()` does not move while it computes.
- `nodejs_compat` on the loaded isolate is for `node:zlib` (just-bash's gzip, tar and file sniffing) and the `Buffer` global; nothing else from Node is in the browser build the runtime bundles.
- `globalOutbound: null` is the whole network policy when the sandbox has no internet; `curl` is not even registered then. with internet, just-bash's own fetch goes through the isolate's global `fetch`, so the policy is enforced twice.
- the Worker and core must agree on `ISOLATE_API_KEY` = core's `CLOUDFLARE_ISOLATE_API_KEY`. set it with `wrangler secret put ISOLATE_API_KEY`. never deploy from a branch.
- `bun test` runs the Worker in Miniflare with a real Worker Loader and R2: no Docker, no account. the codec has its own test under Bun.

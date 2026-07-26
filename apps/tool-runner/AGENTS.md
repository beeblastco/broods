# apps/tool-runner

`@broods/tool-runner` — the AWS Lambda that runs account-uploaded custom tools classified `runtime: "sandbox"` (node/npm/native). One always-on function shared by every account. Core invokes it by name; see `../core/src/harness/custom-tools/lambda.ts`.

Its own workspace because it deploys as a Lambda, not into the core container binary.

## Flow

```
core invokes  → src/handler.ts        spawn + collect + reap, never runs tenant code itself
              → src/child-runner.ts   spawned as a raw `node` child, imports and runs the bundle
              → NDJSON frames back    chunk / final / error
```

The frame protocol and payload shape are owned by `../core/src/harness/custom-tools/payload.ts`. Change one side, change the other.

## Gotchas

- **The child is containment, not a trust boundary.** It runs same-UID, so tenant code can read this function's own environment. Keep the execution role empty — it has no `link` and no `permissions` in `sst.config.ts`, and that is the actual protection. See #174.
- **Never write the bundle to disk.** `/tmp` survives in a warm execution environment that AWS reuses across accounts. The bundle imports from a `data:` URL for that reason.
- **Reap the process group, not the child.** The child is spawned `detached` so `killGroup` takes everything it spawned. A plain `child.kill()` leaves grandchildren alive into the next account's invocation. A tool that spawns its own `detached` child still escapes — Lambda gives no PID namespace to close that.
- **`dist/` is what deploys.** `sst.config.ts` in `apps/core` points at `../tool-runner/dist/`, so `bun run build` must run before a deploy. The tests build first for the same reason — they spawn real `node`, which cannot run the TypeScript sources.
- Timeouts nest deliberately: child self-aborts at ~28s → handler SIGKILLs at 30s → Lambda times out at 35s → core's SDK client gives up at 45s. Keep that order when changing any of them.

# apps/cloudflare-mcp

`@broods/cloudflare-mcp` is the opt-in hosted MCP runtime on Cloudflare Dynamic Workers (Worker Loader). core sends it a batch only for a hosted row with `runtime: "cloudflare"`; Lambda (`../lambda/`) stays the default. one Worker, `src/index.ts`, no build step beyond wrangler.

## Gotchas

- the request body and the NDJSON response are the **same contract as the Lambda runner** (`McpHostPayload` and `../core/src/harness/frames.ts`). change one side = change core and `../lambda/` with it. `t` first, `id` second on every frame.
- the tenant isolate gets `env: {}`, no `compatibilityFlags` and `globalOutbound: TenantOutbound`. never hand it a binding, a secret or `nodejs_compat`: anything in its env is readable by account code. new egress rules go in `TenantOutbound`, which is also why tenant code has no `connect()`.
- the loader id is `accountId:sha256`, and the bundle callback re-hashes the downloaded bytes against `expectedSha256` before any of it runs. keep both: the id is only safe because the code behind it is content-addressed.
- `MCP_API_KEY` (secret) must equal core's `CLOUDFLARE_MCP_API_KEY`; `BUNDLE_ORIGIN` (var) is the exact origin of the presigned tool-bundles S3 URLs. without either the Worker answers 503.
- limits mirror the Lambda: 6 MiB batch in, 16 MiB out shared by the batch, 10 MiB bundle (Workers' script cap), and per request 5 s CPU and 50 subrequests. core bounds wall time at 45 s.
- `bun test` runs the Worker in local workerd through Miniflare with a real Worker Loader. use Bun's `fetch` against `await mf.ready`, not `dispatchFetch`: Bun ignores the undici dispatcher it relies on.
- `check` types `src/` against `@cloudflare/workers-types` and `tests/` against Bun, two tsconfigs because the two global sets clash.
- never `wrangler deploy` from an agent session.

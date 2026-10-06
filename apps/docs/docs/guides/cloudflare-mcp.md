# Cloudflare MCP runtime

A [hosted MCP server](tools.md#host-your-own-server-on-broods) runs where it is cheapest and fastest for its code. With `runtime: "auto"`, the default, Broods runs a server on Cloudflare Dynamic Workers when its bundle can run there, and on AWS Lambda otherwise. Set `runtime: "lambda"` to keep a server on Lambda; the CLI then ships its Node build.

| Runtime    | Picked when                                                                      | Bundle cap         | Per call                      |
| ---------- | -------------------------------------------------------------------------------- | ------------------ | ----------------------------- |
| Cloudflare | `auto`, and the bundle builds for Workers, is 10 MB or less, needs nothing below | 10 MB, sent inline | 30 s, 5 s CPU, 50 subrequests |
| Lambda     | `lambda`, or anything else                                                       | 50 MB              | 30 s shared by the batch      |

For a server that mostly does `fetch` calls and JSON, Workers costs about a quarter of Lambda per call and starts in milliseconds. A batch is the parallel calls of one model step to one server; both runtimes take up to 6 MiB in and 16 MiB out.

## What sends a server to Lambda

- Node builtins (`node:child_process`, `node:fs`, ...), `require()`, `process`, `Buffer`, `__dirname`, native modules or a filesystem.
- `eval` or `new Function`, which Workers forbid.
- A bundle over 10 MB.
- A deployment that does not run the Cloudflare runtime. A self-hosted Broods without it keeps every server on Lambda.

With `runtime: "auto"` the CLI tries a Workers build first (browser and `workerd` package exports) and ships it when it passes the same static scan Broods runs on every upload; otherwise, or with `runtime: "lambda"`, it ships a Node build. The scan is a heuristic that leans toward Lambda.

A server that loads on Workers but fails while it serves a call stays there until its code changes.

If the bundle fails to load on Cloudflare, or the runtime is down or unreachable, nothing has run yet, so Broods runs that batch on Lambda instead and logs a warning. A misconfigured runtime (a wrong key, a missing setting) fails the call instead of hiding behind Lambda. Once a call has started on Cloudflare it is never retried, because a tool may already have acted.

## What the server can reach on Cloudflare

- Each account's bundle runs in its own isolate. Broods checks the bundle against its sha256 before it runs.
- The runtime keeps its own copy of each bundle in R2, so a cold start reads it inside Cloudflare. S3 stays the source of truth: the first load, and the first after a copy's 30-day expiry, downloads it from S3.
- The isolate has no bindings and no platform secrets. Pass credentials through `headers` with `${NAME}` env refs, exactly as on Lambda.
- Outbound `fetch` reaches the public internet. Raw TCP sockets (`connect()`) are not available.

## Billing

A Cloudflare call is billed like a Lambda call: one request per batch, plus the batch's wall time at the hosted MCP rate. The Compute panel shows no CPU figure for these calls, because the runtime does not report one.

## Running it on a self-hosted deployment

The runtime is `apps/cloudflare-mcp`, a Worker with a `LOADER` [Worker Loader](https://developers.cloudflare.com/dynamic-workers/) binding. Dynamic Workers needs a Workers Paid plan.

1. Create the R2 bucket `broods-mcp-bundles` (the `BUNDLES` binding), ideally with a 30-day expiry rule.
2. Set the Worker secret `MCP_API_KEY` and the var `BUNDLE_ORIGIN`: the exact `https://` origin of your tool-bundles S3 bucket's presigned URLs.
3. Deploy the Worker with Wrangler.
4. Set core's `CLOUDFLARE_MCP_URL` to `https://<worker-host>/mcp` and `CLOUDFLARE_MCP_API_KEY` to the same secret.

Until `CLOUDFLARE_MCP_URL` is set, every server runs on Lambda.

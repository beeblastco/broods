# Cloudflare MCP runtime

A [hosted MCP server](tools.md#host-your-own-server-on-broods) runs on AWS Lambda unless you choose otherwise. Set `runtime: "cloudflare"` to run it on Cloudflare Dynamic Workers instead. Each server opts in on its own, and Broods never moves an existing server for you.

```ts
import { defineMcp } from "broods";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

export const greeter = defineMcp({
  name: "greeter",
  runtime: "cloudflare",
  handler: createMcpHandler(() => {
    const server = new McpServer({ name: "greeter", version: "1.0.0" });
    // server.registerTool(...)
    return server;
  }),
});
```

Remove `runtime` and sync again to move the server back to Lambda. Over the API, send `runtime` on `POST /v1/mcp` or `PATCH /v1/mcp/{serverId}`. Only hosted servers accept it.

## When to pick it

| Runtime            | Runs                                | Bundle cap | Per call                              |
| ------------------ | ----------------------------------- | ---------- | ------------------------------------- |
| `lambda` (default) | Node.js, npm dependencies, builtins | 50 MB      | 30 s and 16 MB per batch              |
| `cloudflare`       | Workers-compatible JavaScript only  | 10 MiB     | 5 s CPU, 50 subrequests, 16 MiB/batch |

Cloudflare starts in milliseconds. Pick it for a server that only does `fetch` calls and JSON. Stay on Lambda if the server needs Node builtins, native modules, a filesystem or long CPU work.

## What the server can reach

- The CLI bundles for Workers: browser and `workerd` package exports, no Node builtins. An import such as `node:child_process` fails the sync, before anything uploads.
- Each account's bundle runs in its own isolate. Broods checks the bundle against its sha256 before it runs.
- The isolate has no bindings and no platform secrets. Pass credentials through `headers` with `${NAME}` env refs, exactly as on Lambda.
- Outbound `fetch` reaches the public internet. Raw TCP sockets (`connect()`) are not available.

## Billing

A Cloudflare call is billed like a Lambda call: one request per batch, plus the batch's wall time at the hosted MCP rate. The Compute panel shows no CPU figure for these calls, because the runtime does not report one.

## Enabling it on a self-hosted deployment

The runtime is `apps/cloudflare-mcp`, a Worker with a `LOADER` [Worker Loader](https://developers.cloudflare.com/dynamic-workers/) binding. Dynamic Workers needs a Workers Paid plan.

1. Set the Worker secret `MCP_API_KEY` and the var `BUNDLE_ORIGIN`: the exact `https://` origin of your tool-bundles S3 bucket's presigned URLs.
2. Deploy the Worker with Wrangler.
3. Set core's `CLOUDFLARE_MCP_URL` to `https://<worker-host>/mcp` and `CLOUDFLARE_MCP_API_KEY` to the same secret.

Until both core variables are set, a call to a `cloudflare` server fails with a clear error. Lambda servers are unaffected.

# tool-custom-sandbox

An uploaded custom tool that needs the **Node runtime**, so it runs in the platform tool-runner Lambda instead of the in-core V8 isolate.

## Why this lands on the sandbox tier

`broods/agents.ts` declares `execute` inline and imports `node:crypto`, `node:zlib`, `node:fs`, and `node:os`. Nothing declares `runtime` — the classifier reads the built bundle, sees the `node:` imports, and routes it to the sandbox tier on its own. The same bundle in the isolate tier would fail: the isolate has no module surface at all.

## What the tool returns

| field                              | why it is here                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `sha256`, `gzipBytes`, `requestId` | native `node:crypto` / `node:zlib` work                                      |
| `nodeVersion`                      | proves a real Node process, not an isolate                                   |
| `visibleAwsCredentials`            | must be `[]` — the runner scrubs every AWS credential from the child env     |
| `tmpModuleFiles`                   | must be `[]` — the bundle is imported from memory, so it never lands on disk |

The last two are the containment properties from #174, observable from inside a tenant tool. They are also asserted in `apps/core/tests/tool-runner-security.test.ts`.

## Run it

```bash
bun install
broods dev --once     # sync the agent + tool to your stage
bun index.ts          # stream a run that calls the tool
```

Needs `AI_API_KEY` and `AI_BASE_URL` set on the account (`broods env set AI_API_KEY`), and `TOOL_RUNNER_FUNCTION_NAME` wired into the core deployment — without it the first sandbox-tier invoke fails on a missing env var.

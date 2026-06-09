# External Tools

This guide covers agent-configured external tools: built-in tools such as Tavily/Google Search and account-uploaded custom tools. It does not cover the sandbox tools (`bash`, `read`, `write`, `edit`, `glob`, `grep` — see [Workspace & Sandbox](workspace/index.md)), `load_skill`, or `run_subagent`.

External tools are enabled per agent through `config.tools`. Built-in keys use their static name. Uploaded custom tools use their account-scoped `toolId` key, and the uploaded manifest supplies the model-facing name, description, and input schema. Uploaded tool code executes in a Kubernetes sandbox runner, not inside `harness-processing`.

```mermaid
flowchart LR
  Upload["POST /accounts/me/tools<br/>bundle + manifest"] --> Store["AccountTool metadata + S3 bundle"]
  Config["config.tools.<name or toolId><br/>async"] --> Registry["tools/index.ts"]
  Store --> Registry
  Registry --> Wrap["AsyncToolCoordinator"]
  Wrap --> Model["streamText tools"]
  Model --> Call["model calls tool"]
  Call --> BuiltIn["built-in<br/>Lambda execute"]
  Call --> UploadedSse["uploaded + SSE<br/>wait for runner result"]
  Call --> UploadedDetached["uploaded + detached path<br/>runner completes by callback"]
  UploadedSse --> Runner["Kubernetes tool runner"]
  UploadedDetached --> Runner
```

## Current Tools

| Tool | File | External dependency | Config key |
| --- | --- | --- | --- |
| `tavilySearch` | [`functions/harness-processing/tools/tavily.tool.ts`](../functions/harness-processing/tools/tavily.tool.ts) | Tavily AI SDK search | `config.tools.tavilySearch` |
| `tavilyExtract` | [`functions/harness-processing/tools/tavily.tool.ts`](../functions/harness-processing/tools/tavily.tool.ts) | Tavily AI SDK extract | `config.tools.tavilyExtract` |
| `googleSearch` | [`functions/harness-processing/tools/google-search.tool.ts`](../functions/harness-processing/tools/google-search.tool.ts) | Google provider-defined tool | `config.tools.googleSearch` |
| Uploaded custom tool | S3 bundle + account tool metadata | Kubernetes tool runner | `config.tools.<toolId>` |

Sandbox tools come from a referenced `sandbox` (+ `workspaces`) — see [Workspace & Sandbox](workspace/index.md). Skills use `config.skills`; see [Skills](skills.md). Subagents use `config.subagent`.

## Runtime Behavior

`functions/harness-processing/harness.ts` resolves the configured model and calls `createTools()` from [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts).

Tool registry path:

1. `createTools()` rejects unknown `config.tools` names.
2. The sandbox tools come from a referenced `sandbox`: `bash` (stateless) when there is no workspace; per workspace, the full `read`/`write`/`edit`/`glob`/`grep`/`bash` set when it has an effective sandbox, or read-only `read`/`glob` when it has none (via a read-only mount by default, or direct S3 with the `sandbox: null` opt-out). Approvals follow that workspace's `permissionMode`.
3. `run_subagent` comes only from `config.subagent`.
4. `load_skill` comes from `config.skills`.
5. Built-in tools come from the static `toolFactories` map.
6. `tool_*` config keys load account-owned uploaded tool metadata and expose the uploaded model-facing tool name.
7. `needsApproval` is applied before tools are passed to `streamText()`.
8. Local `execute` tools with `async: true` are wrapped by `AsyncToolCoordinator`.

Built-in local tools execute during the current `harness-processing` request. Uploaded custom tools run in a persistent Kubernetes runner pod keyed by account/tool. `harness-processing` creates a local Kubernetes executor client, but that does not mean a new pod is created for each call: `persistent: true` selects the reserved-sandbox path, and the stable account/tool `reservationKey` becomes the deterministic Kubernetes Sandbox name. Change the reservation key and the executor will address a different pod; keep it stable and it reconnects to the existing pod, creates it on first use, or resumes it after idle scale-to-zero.

For the MVP, each tool call uses a short `exec` command inside that warm pod. The Lambda sends the tool input, merged config, a short-lived bundle URL, bundle hash, and async metadata to the runner script, then waits for JSON output. The runner verifies the cached bundle under `/cache/tools/<sha256>` first, downloads only on cache miss, verifies the downloaded hash, imports the default export, calls `execute(ctx, input)`, and returns the result. `$HOME/.cache/tools` and `/tmp/cache/tools` are fallback cache roots for images that do not expose `/cache/tools`.

```mermaid
sequenceDiagram
  participant H as harness-processing
  participant K as Kubernetes executor
  participant P as "persistent account/tool pod"
  participant S as "S3 bundle object"

  H->>K: run(reservationKey=custom-tool-account-tool)
  K->>P: reconnect/create/resume pod
  P->>P: check /cache/tools/sha256/tool.mjs
  opt cache miss
    P->>S: GET signed bundle URL
    P->>P: verify sha256 + cache bundle
  end
  P->>P: import bundle + execute(ctx,input)
  P-->>H: JSON result marker
```

### Future Runner Process

The next performance step is a long-lived Node worker process inside the same persistent pod. Instead of `exec`-ing a short Node heredoc for every call, the pod would start a small HTTP or gRPC server once:

```text
harness-processing -> invoke runner endpoint -> warm Node process -> cached module -> execute(ctx,input)
```

Benefits:

- Lower per-call overhead: no per-call shell process, Node startup, heredoc transfer, or module reload.
- Better cache behavior: loaded modules and parsed JavaScript can stay in process memory, not just on disk.
- Cleaner invoke protocol: payloads can be sent as JSON over HTTP/gRPC instead of embedded in generated code.
- Closer to Convex-style function running: a warm runtime owns module loading and dispatch, while the control plane only sends invocations.

Tradeoffs:

- More infrastructure: pod readiness must include the runner server, health checks, port forwarding/service routing, and graceful restarts.
- More lifecycle code: deploy/update has to tell the worker when a tool hash changes and evict the loaded module.
- More security surface: the runner API needs local-only or authenticated access so uploaded code cannot invoke other tools directly.

Recommendation: keep the current warm-pod `exec` runner for MVP because it preserves isolation and is simple to debug. Move to the long-lived Node worker once custom tools are frequently invoked enough that Node/process startup and module import show up in latency metrics.

### Streaming partial output (sync)

A bundle whose `execute` is an async generator streams partial output. The resident worker returns NDJSON frames over the unix socket — one `chunk` frame per `yield`, then `end` (or a single `final` for a normal return, or `error` on throw) — and the executor surfaces them as an async iterable. The AI SDK turns each yield into a **preliminary tool result** on the sync SSE stream; the last yield is the final output the model sees. Auto-detected per call: a non-generator `execute` behaves exactly as before. Streaming is live only on the resident-worker path; the one-shot runner fallback drains the generator to its last value.

```ts
// uploaded bundle — yields stream as preliminary results, last yield is final
export default {
  async *execute(ctx, input) {
    yield { type: "text", value: "working…" };
    yield { type: "text", value: "done: " + input.q };
  },
};
```

```text
worker NDJSON:  {"t":"chunk",...}  {"t":"chunk",...}  {"t":"end"}
SSE fullStream: tool-result(preliminary) … tool-result(preliminary) … tool-result(final)
```

When `config.tools.<name>.async` is `true`, the platform chooses the lifecycle from the tool type and request path:

| Tool type | Request path | Tool code runs in | Lambda waits? | Result completion | Model continuation |
| --- | --- | --- | --- | --- | --- |
| Built-in sync | all paths | `harness-processing` Lambda | Yes | tool `execute()` return value | same active agent loop |
| Built-in async | all paths | `harness-processing` Lambda | Yes | tool `execute()` return value | same active agent loop injects result |
| Uploaded sync | all paths | Kubernetes runner | Yes | runner returns final result | same active agent loop |
| Uploaded async | SSE | Kubernetes runner | Yes | runner returns final result | same SSE Lambda injects result and streams final answer |
| Uploaded async | `/async`, channel, NATS | Kubernetes background runner | No | token-authenticated completion endpoint | new continuation Lambda injects result |

SSE is the only path that must wait for uploaded async tools. The open SSE response belongs to the current Lambda invocation, so a later callback cannot write to that response without a separate broker/reconnect protocol. Detached paths already have a polling, channel, or NATS delivery target, so uploaded async tools are launched as sandbox background work and complete through the existing settle-and-continue pipeline.

```mermaid
sequenceDiagram
  participant H as harness-processing
  participant P as Parent agent
  participant C as AsyncToolCoordinator
  participant D as DynamoDB AsyncToolResult
  participant W as Kubernetes runner

  alt built-in async or uploaded async on SSE
    P->>C: tool call
    C->>D: processing row
    C->>C: run built-in locally or wait for uploaded runner
    C->>D: completed/failed
    C->>P: inject result and continue
  else uploaded async on detached path
    P->>C: tool call
    C->>D: processing row + delivery metadata + dispatch group
    C->>W: launch Kubernetes background runner
    C-->>H: pending result, Lambda can exit
    W->>H: POST /sandbox-jobs/\{resultId\}/complete
    H->>D: settle result row
    H->>P: continue after dispatch group is sealed and all siblings settled
  end
```

Detached uploaded async tools complete through a token-authenticated callback generated by the platform:

```http
POST /sandbox-jobs/{resultId}/complete
x-job-token: <per-result-token>
```

```json
{
  "status": "completed",
  "response": { "answer": "done" }
}
```

or:

```json
{
  "status": "failed",
  "error": "External job failed"
}
```

The uploaded tool does not need account secrets for platform completion. On detached paths, `ctx.asyncTool.completePath` points at the token-authenticated completion route and `ctx.asyncTool.completionToken` carries the per-result token. The platform runner posts the final `execute()` result itself. If a future tool needs to hand completion to a separate external service without waiting, add an explicit defer contract first; do not reintroduce a public lifecycle switch.

Detached uploaded async completion path:

1. The wrapper creates one `AsyncToolResult` row for each async tool call.
2. For detached uploaded async, the wrapper also registers the `resultId` in a dispatch-group item in the same `AsyncToolResult` table.
3. The Kubernetes runner launches the uploaded tool as background sandbox work and returns the pending result to the model.
4. The runner calls `POST /sandbox-jobs/{resultId}/complete` when it finishes. It does not write DynamoDB directly.
5. The completion handler settles that `AsyncToolResult` row.
6. When the parent model pass has registered all detached calls, the group is sealed.
7. The parent continues only after the sealed group has every sibling row completed or failed.
8. Direct async completions re-drive the async worker. NATS completions invoke `nats-worker` with stored connection metadata.

Notes:

- The continuation loop waits only for in-memory pending work: built-in async and uploaded async on SSE. Detached uploaded async does not add pending work.
- The original `/async` status row is settled through `asyncResultEventId`; the internal continuation uses a separate event id for dedupe.
- Current fan-in is DynamoDB, but it is not a separate table. The dispatch group is an item in the existing `AsyncToolResult` table.
- Future: when NATS uses JetStream, missed WebSocket stream chunks can be replayed from persisted stream/consumer state. Until then, NATS continuation reaches the client only while the gateway/client remains subscribed.

> Warning: Provider-defined tools without local `execute`, such as Google Search, cannot use this wrapper. If `async: true` is configured for one of those tools, the runtime logs a warning and leaves the tool in its normal provider-defined behavior.

For sync direct API callers, approval requests are streamed as SSE and persisted in the conversation. The caller resumes the turn by sending a direct API `tool-approval-response`. Channel webhooks cannot complete approval; the handler denies channel approval requests with a channel-visible error.

> TODO: Add channel webhook support for completing tool approval requests when channel-safe approval UX is available.

## Agent Config

Use `config.tools` for built-in and uploaded tools:

```json
{
  "tools": {
    "tavilySearch": {
      "enabled": true,
      "async": true,
      "needsApproval": true,
      "apiKey": "...",
      "maxResults": 5
    },
    "tavilyExtract": {
      "enabled": true,
      "apiKey": "..."
    },
    "googleSearch": {
      "enabled": true
    },
    "tool_abc123": {
      "enabled": true,
      "async": true,
      "needsApproval": false,
      "config": {}
    }
  }
}
```

Omitting a tool disables it. Setting `enabled: false` also disables it. Set `needsApproval: true` when the tool should require the AI SDK approval flow before execution.
Set `async: true` when a local `execute` tool may take long enough that the parent agent should keep working while the result is produced.
For uploaded tools, `config` is merged over the upload-time `defaultConfig` and passed to `ctx.config`. Uploaded tool code always runs in Kubernetes; the platform decides whether to wait or detach from the request path.

See [`examples/tool-async.ts`](../examples/tool-async.ts) for a runnable direct SSE example that uploads `test_async`, enables `config.tools.<toolId>.async`, and asks the agent to call the uploaded tool.

The full config field reference lives in the [API Reference](/api-reference) under `AgentConfig.tools`.

## Upload a Custom Tool

Create an already-bundled JavaScript module whose default export is a tool definition object or factory:

```ts
export default {
  name: "test_async",
  description: "Test async tool.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(ctx, input) {
    return { type: "text", value: "done" };
  },
};
```

Upload it through account-manage:

```http
POST /accounts/me/tools
Authorization: Bearer <account-secret>
Content-Type: application/json
```

```json
{
  "name": "test_async",
  "description": "Test async tool.",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
  "bundle": "export default { name: \"test_async\", async execute() { return { type: \"text\", value: \"done\" }; } };",
  "defaultConfig": {}
}
```

Use the returned `toolId` as the `config.tools` key. The model still sees the uploaded `name`.

Tool management endpoints:

- `GET /accounts/me/tools`
- `GET /accounts/me/tools/{toolId}`
- `PATCH /accounts/me/tools/{toolId}`
- `DELETE /accounts/me/tools/{toolId}`

MVP limits: uploaded code must already be bundled JavaScript, server-side `npm install` is not supported, and shared multi-pod dependency caches are future work. This is intentionally close to Convex's deployed-function developer loop, but the MVP does not build/install dependencies server-side yet; it runs the uploaded bundle in a warm sandbox and reuses the bundle cache between calls for the same account/tool.

## Add a Built-In Tool

1. Create `functions/harness-processing/tools/<name>.tool.ts`.
2. Add the standard file header docstring.
3. Export a default tool factory, or named factories when one provider module exposes several tools.
4. Keep the model-facing schema and external service call in that tool file.
5. Import the factory in [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts).
6. Add the factory to the static `toolFactories` map with the exact model-facing tool name.
7. Add config validation in [`functions/_shared/storage/agent-config.ts`](../functions/_shared/storage/agent-config.ts) only for options the account can set.
8. Optionally set `config.tools.<name>.async: true` for slow local `execute` tools. Built-in async tools always run in the current Lambda; uploaded async tools are waited on for SSE and detached automatically for `/async`, channels, and NATS.
9. Update the [API Reference](/api-reference) `AgentConfig.tools` schema, [`examples/account.config.example.json`](../examples/account.config.example.json), and focused tests/examples when the public config shape changes.

Keep the factory small. It should read `context.config`, resolve any API key, return a `ToolSet`, and leave unrelated orchestration to `harness.ts`.

```ts
/**
 * Example external service tool for the harness agent.
 * Keep Example API access and model-facing schema here.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolContext } from "./index.ts";

export default function exampleLookupTool(context: ToolContext): ToolSet {
  const { enabled: _enabled, apiKey, ...options } = context.config;

  if (typeof apiKey !== "string") {
    throw new Error("config.tools.exampleLookup.apiKey is required.");
  }

  return {
    exampleLookup: tool({
      description: "Look up external Example records.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      execute: async ({ query }) => {
        const response = await fetch("https://api.example.com/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, ...options }),
        });

        if (!response.ok) {
          throw new Error(`Example lookup failed: ${response.status}`);
        }

        return response.json();
      },
    }),
  };
}
```

## Design Rules

- Keep external tool logic in `functions/harness-processing/tools/<name>.tool.ts`.
- Do not add a new Lambda, queue, or worker for ordinary built-in external-service tools.
- Use `async: true` only when the tool has a local `execute`; provider-defined tools without `execute` remain provider-managed.
- Do not expose request lifecycle choices in agent config; the platform chooses wait vs detached from tool type and request path.
- Do not put external tool config under `workspace`, `skills`, or `subagent`.
- Prefer provider or service SDK types over new custom interfaces when they already model the same options.
- Keep account-specific credentials in encrypted agent config when the account owns them.
- Use SST secrets only for service-wide fallback credentials, such as `TAVILY_API_KEY`.
- Return structured data from `execute` instead of pre-formatting prose for the model, use the `ToolSet` interface from vercel-ai sdk.
- Add approval support through `needsApproval`, not by asking inside the tool implementation. [Implement from vercel=ai sdk](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#tool-execution-approval)

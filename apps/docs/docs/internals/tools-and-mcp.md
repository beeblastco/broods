# Tools and MCP

This page covers how core builds an agent's tool set for a run, how async tools settle, how hosted MCP servers execute, and how to add a built-in tool. What users configure is in the [tools guide](../guides/tools.md). Paths are relative to `apps/core/`.

## Registry

`harness.ts` resolves the model, then calls `createTools()` in `src/harness/tools/index.ts`. The tool set is assembled in this order:

1. Sandbox tools from the agent's `sandboxes` and `workspaces`. `bash` when there is any sandbox or sandbox-backed workspace. `computer` for every machine sandbox. `read` and `glob` for every workspace, through the mount when it has a sandbox and through S3 or a read-only mount when it does not. `write`, `edit` and `grep` only when a workspace has a sandbox. `memory_save` when a sandbox-backed workspace keeps the memory harness on.
2. Channel tools (`send-files`, `send-images`, `send-reactions`, `send-sticker`, `send-update`) on channel turns, each gated on the adapter's capabilities, and `send-message` when the agent has channels and the request can dispatch to another session. See [channels](channels.md).
3. `run_subagent` when `config.subagent.enabled` and the request has a dispatcher, plus `get_subagent_status`, `update_subagent` and `stop_subagent` in persistent mode.
4. `load_skill` when `config.skills.enabled` and `allowed` has paths.
5. `schedule`, `list_schedules`, `update_schedule` and `cancel_schedule` when `config.scheduler.enabled`, except on a cron-fired run.
6. Every `config.tools` key, resolved against the configured provider's `tools` namespace. A key that is not a provider tool name throws `config.tools.<name> is not a supported tool`. `enabled: false` skips it. Keys other than `enabled`, `needsApproval` and `async` pass through as the tool's arguments.
7. `ask_questions` when the session has a delivery to resume on, meaning a channel or WebSocket turn, and the run is not cron-fired. Subagent sessions carry no delivery, so they never get it.
8. MCP server tools from `config.mcp`, as `<server>__<tool>`.
9. `async_status` when any `config.tools` entry has `async: true` or a workspace has a persistent sandbox. Its `logs` and `stop` actions exist only when a workspace's provider exposes live job controls.
10. `withholdTools(tools, config.denyTools)` last, so a channel record's deny list covers sandbox and MCP tools too.
11. `needsApproval` is applied before the tools reach `streamText()`, and `async: true` tools are wrapped by the `AsyncToolCoordinator`.

## Provider-defined tools

A provider tool built by the AI SDK serializes to a plain descriptor, `{ type: "provider", id: "google.google_search", args: {...} }`. Its lazy input and output schemas do not survive JSON, so `provider-tool.ts` rebuilds the tool by calling the same provider factory with the descriptor's `args`. The dashboard writes a flat shape (`googleSearch: { enabled: true, searchTypes: {...} }`), which core also accepts.

Core keeps no list of tool names. It reads the live provider's `tools` namespace at registry build, so any provider-executed tool the AI SDK ships works without a core change. A name the provider does not expose fails the run with the available names in the error.

Provider tools have no local `execute`, so `async: true` cannot wrap them. Core logs a warning and leaves the tool as a normal provider tool.

## Async tools

The async subsystem (`async-tools.ts`, `async-tool-result.ts`) creates `runtimeAsyncToolResults` rows, exposes `async_status`, waits for in-process pending work, and injects completed results into the same active agent loop.

- The continuation loop waits only for in-memory pending work.
- Detached work, currently `bash` background jobs, settles through the token-authenticated `POST /v1/sandbox-jobs/{resultId}/complete`, which resumes the conversation. See [architecture](architecture.md).
- The original background-run status row settles through `asyncResultEventId`. The internal continuation uses a separate event id for dedup.

Approval requests on a sync direct API run stream as SSE and persist in the conversation. The caller resumes with a `tool-approval-response`. Channel turns cannot complete approval, so they deny tools with `needsApproval`.

## MCP servers

Core is the MCP client, spec 2026-07-28, stateless Streamable HTTP only. At agent registration it connects to each enabled server, lists tools, caches them for the listing's own `ttlMs`, and registers each as `<server>__<tool>`. `tools/call` is one POST per call with no session.

- The `url` host is resolved before connecting. Private, loopback, link-local and metadata addresses are refused, and so are redirects. The OAuth `tokenUrl` gets the same check.
- Credential-bearing headers must reference an account env var (`Bearer ${NAME}`). Inline secrets and URL userinfo are rejected at registration, and a header still carrying an unresolved ref refuses to connect.
- OAuth rows mint access tokens with the refresh-token grant, cache them per config, re-mint before expiry, and send `Authorization: Bearer` themselves.
- `subscriptions/listen` is not supported. Tool lists refresh when `ttlMs` expires. MRTR `input_required` results surface as tool errors.
- A `sandbox` row routes calls over the machine socket to the `broods machine --mcp` daemon on the user's computer.

### Hosted servers

A hosted row with `transport: "hosted"` stores a bundle under the `account-mcp/` prefix of the tool-bundles bucket. `MAX_MCP_BUNDLE_BYTES` caps it at 50 MB, checked by the CLI and again in `packages/convex/aws/bundles.ts`. The CLI bundles the module that calls `defineMcp({ handler })` and imports the build before upload, failing the deploy if the handler is missing or not fetch-style. Bundles over 10 MB, set by `INLINE_MCP_BUNDLE_BYTES`, go through a storage upload URL from `POST /v1/mcp/uploads` instead of the request body.

The handler factory must build a fresh server on every call. The stateless transport connects one per request, and the parallel calls of a model step run concurrently in one process, where a shared instance would have every in-flight handler aborted when one request's transport closes.

The mcp-runner Lambda (`apps/lambda/handler.mjs`, `child-runner.mjs`) hosts the bundle. `src/harness/mcp/hosted.ts` is the core side:

- Batching. The parallel calls of one model step reach core together, so core holds a call for `MCP_BATCH_WINDOW_MS`, default 10 ms, and sends every call for the same account and bundle that arrived in that window as one invoke, up to `MCP_BATCH_MAX`, default 8. Setting it to `1` disables batching. The child runs them concurrently and answers each on its own frame.
- A batch shares one 30 s deadline and one 16 MB output cap. `RUN_TIMEOUT_MS` in `apps/lambda/handler.mjs` sets the deadline, with a 2 s grace for the child to abort itself. Its CPU is split evenly across its calls.
- Warm reuse. Repeat invokes for the same account and bundle sha256 reuse a warm child, so only the first pays fetch, parse and spawn. A child serves at most `MCP_CHILD_MAX_CALLS` calls, default 64, and retires after `MCP_CHILD_IDLE_SECONDS` idle, default 300. A timeout or crash retires it at once. A handler that throws fails only its own request.
- Metering. Each call's span carries `tool.compute.type: "mcp-sandbox"` and `tool.compute.cpu_usec`, billed into the account's tool-sandbox CPU usage.
- Every invoke carries the account id as its Lambda tenant id, unless `MCP_TENANT_ISOLATION=false` on a non-production stage. See [security](security.md).
- The bundle reaches the runner as a pre-signed URL valid for 120 s, so the function holds no S3 access.

Because the transport is stateless, per-invoke hosting is a complete implementation, and agents use hosted and external servers the same way. `defineTool` and `POST /v1/tools` are retired; hosted MCP servers replace them.

## Add a built-in tool

Most integrations should not be built-in tools. A service with its own API belongs in an MCP server, external or hosted. Add a built-in tool only for behavior that needs core internals, such as the session, a sandbox or a channel.

1. Create `src/harness/tools/<name>.tool.ts` with a file header comment, the model-facing schema and the execution logic.
2. Export a factory that takes only the context it needs and returns a `ToolSet`.
3. Import it in `src/harness/tools/index.ts` and register it in `createTools()` behind the config or session condition that enables it. `config.tools` is only for provider-defined tools; do not route a built-in through it.
4. If users can configure it, add the field to `AgentConfig` in `src/shared/domain/agent-config.ts`, validate it in `packages/convex/model/agentRules.ts`, expose it in `packages/broods/src/resources.ts`, and run Convex codegen.
5. Update the [API reference](/api-reference), the [tools guide](../guides/tools.md), and focused tests.

```ts
/**
 * Example lookup tool. Keeps the model-facing schema and the service call together.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

interface ExampleLookupContext {
  apiKey: string;
}

export default function exampleLookupTool(
  context: ExampleLookupContext,
): ToolSet {
  return {
    example_lookup: tool({
      description: "Look up Example records.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const response = await fetch("https://api.example.com/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${context.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: query }),
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

### Design rules

- Keep each tool's schema and external call in its own `<name>.tool.ts`. Leave orchestration to `harness.ts`.
- Do not add a Lambda, queue or worker for an ordinary external-service tool. Use an MCP server.
- Use `async: true` only for tools with a local `execute`.
- Do not expose request lifecycle choices in agent config. The platform picks the wait behavior from the tool type and request path.
- Reuse provider or service SDK types instead of new interfaces when they model the same options.
- Per-account credentials live in encrypted agent config or account env vars. SST secrets are only for service-wide fallbacks.
- Return structured data from `execute`, not pre-formatted prose.
- Add approval through `needsApproval`, as in [AI SDK tool approval](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#tool-execution-approval), never by asking inside the tool.

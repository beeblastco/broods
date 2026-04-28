# Architecture and Workflows

The deployed path is one public Lambda Function URL backed by the `harness-processing` Lambda. That Lambda handles sync direct API requests, async direct API requests, status polling, and optional Telegram, GitHub, Slack, and Discord webhooks.

## Lambda Runtime Layer

This layer is the Lambda execution plumbing. It explains how AWS invokes the Bun binary and how the custom runtime turns Lambda Runtime API events into application handler calls.

```mermaid
flowchart TD
  Aws["AWS Lambda service"] -->|"starts provided.al2023 runtime"| Bun["Bun custom runtime binary"]
  Bun --> Boot["functions/harness-processing/bootstrap.ts"]
  Boot --> Start["startStreamingRuntime(handler)"]

  subgraph Runtime["functions/_shared/runtime.ts"]
    Poll["GET /runtime/invocation/next"]
    Parse["parse event envelope + context"]
    Call["call handler(event, context)"]
    Encode["encode Lambda HTTP integration response"]
    Stream["POST streamed response<br/>Lambda-Runtime-Function-Response-Mode: streaming"]
    After["await response.afterResponse"]
    Error["POST invocation error"]
  end

  Start --> Poll --> Parse --> Call
  Call -->|"LambdaResponse"| Encode --> Stream --> After
  Call -->|"throw"| Error
  After --> Poll
  Error --> Poll

  Call --> App["functions/harness-processing/handler.ts"]
  App -->|"statusCode, headers, body stream, afterResponse"| Call
```

Runtime boundary:

- AWS invokes `bootstrap`, not `handler.ts`, because SST config sets `handler: "bootstrap"` in [`sst.config.ts`](../sst.config.ts).
- [`bootstrap.ts`](../functions/harness-processing/bootstrap.ts) starts [`startStreamingRuntime()`](../functions/_shared/runtime.ts), then the runtime loop calls the exported [`handler()`](../functions/harness-processing/handler.ts) for each invocation.
- [`functions/_shared/runtime.ts`](../functions/_shared/runtime.ts) owns Lambda Runtime API polling, streaming HTTP response encoding, error reporting, and post-response work via `afterResponse`.
- The full Lambda Function URL event envelope is passed into `handler.ts`; routing is not synthesized by the runtime layer.

## Application Traffic Layer

This layer is the application behavior. It explains how direct API calls, async requests, status polling, and channel webhooks move through the single public Lambda.

### Entry Points

Everything enters through the same Lambda Function URL, then `integrations.ts` decides which handler path should own the request.

```mermaid
flowchart TD
  SyncCaller["Direct API caller<br/>POST /"] --> Url["Lambda Function URL"]
  AsyncCaller["Async caller or durable workflow<br/>POST /async"] --> Url
  Poller["Status poller<br/>GET /status/{eventId}"] --> Url
  Channel["Telegram / GitHub / Slack / Discord webhook"] --> Url

  Url --> Handler["handler.ts"]
  Handler --> Integrations["integrations.ts<br/>auth, route, normalize"]

  Integrations -->|"POST /"| Direct["handleDirectRequest()"]
  Integrations -->|"POST /async"| AsyncStart["handleAsyncRequest()"]
  Integrations -->|"GET /status/{eventId}"| StatusRead["handleStatusRequest()"]
  Integrations -->|"channel webhook"| ChannelRoute["channel adapter parse"]

  Direct --> SyncResponse["SSE response"]
  AsyncStart --> AsyncResponse["202 + statusUrl"]
  StatusRead --> StatusResponse["JSON status"]
  ChannelRoute --> ChannelAck["immediate HTTP ack"]

  classDef entry fill:#e8f1ff,stroke:#2f6fba,color:#10233f
  classDef lambda fill:#f3f6f8,stroke:#687683,color:#1f2933
  classDef direct fill:#eaf7ee,stroke:#2d7d46,color:#14351f
  classDef async fill:#fff3d6,stroke:#b7791f,color:#3d2b09
  classDef channel fill:#f2e8ff,stroke:#805ad5,color:#2d1b4e

  class SyncCaller,AsyncCaller,Poller,Channel,Url entry
  class Handler,Integrations lambda
  class Direct,SyncResponse direct
  class AsyncStart,AsyncResponse,StatusRead,StatusResponse async
  class ChannelRoute,ChannelAck channel
```

### Async Direct API

The caller receives `statusUrl` immediately, while the background worker runs the normal agent path and updates `status.ts`.

```mermaid
flowchart TD
  Caller["Async caller or durable workflow"] -->|"POST /async"| Url["Lambda Function URL"]
  Url --> AsyncStart["handler.ts<br/>handleAsyncRequest()"]
  AsyncStart --> Pending["status.ts<br/>create processing record"]
  Pending --> AsyncTable["DynamoDB: AsyncResults"]
  AsyncStart -->|"202 + statusUrl"| Caller

  AsyncStart --> SelfInvoke["Lambda async self-invocation<br/>InvocationType: Event"]
  SelfInvoke --> Worker["handler.ts<br/>handleAsyncWorkerRequest()"]
  Worker --> Session["session.ts<br/>claim + context"]
  Session --> Harness["harness.ts<br/>agent loop"]
  Harness --> Tools["tools/index.ts<br/>inline tools"]
  Harness --> Model["Google Gemini<br/>Vercel AI SDK"]
  Harness -->|"final response or error"| Worker
  Worker --> StatusUpdate["status.ts<br/>update record"]
  StatusUpdate --> AsyncTable
  Worker -->|"optional signed callback"| Webhook["webhookUrl"]

  Caller -->|"GET /status/{eventId}"| StatusUrl["Lambda Function URL"]
  StatusUrl --> StatusRead["handler.ts<br/>handleStatusRequest()"]
  StatusRead --> StatusLookup["status.ts<br/>read record"]
  StatusLookup --> AsyncTable
  StatusRead -->|"processing / completed / failed"| Caller

  classDef caller fill:#e8f1ff,stroke:#2f6fba,color:#10233f
  classDef lambda fill:#f3f6f8,stroke:#687683,color:#1f2933
  classDef async fill:#fff3d6,stroke:#b7791f,color:#3d2b09
  classDef agent fill:#eaf7ee,stroke:#2d7d46,color:#14351f
  classDef storage fill:#ffe8e8,stroke:#c53030,color:#4a1111
  classDef callback fill:#f2e8ff,stroke:#805ad5,color:#2d1b4e

  class Caller caller
  class Url,StatusUrl,AsyncStart,SelfInvoke,Worker,StatusRead lambda
  class Pending,StatusUpdate,StatusLookup async
  class Session,Harness,Tools,Model agent
  class AsyncTable storage
  class Webhook callback
```

The async path stays inside `harness-processing`: `POST /async` stores a processing record, returns a status URL, and starts an internal async Lambda self-invocation. The worker then runs the normal agent turn through `session.ts`, `harness.ts`, and the inline tool registry, and writes the final status through `status.ts`.

### Direct SSE and Channel Webhooks

Direct API calls hold an SSE connection open. Channel webhooks are acknowledged quickly, then `afterResponse` runs the channel message through the same agent loop and sends the reply through channel actions.

```mermaid
flowchart TD
  DirectCaller["Direct API caller"] -->|"POST /"| Url["Lambda Function URL"]
  Url --> Direct["handleDirectRequest()"]
  Direct --> Session["session.ts<br/>claim + context"]
  Direct -->|"SSE stream"| DirectCaller

  Channel["Telegram / GitHub / Slack / Discord"] -->|"webhook POST"| Url
  Url --> ChannelRoute["channel adapter<br/>auth + parse"]
  ChannelRoute -->|"immediate HTTP ack"| Channel
  ChannelRoute --> AfterResponse["afterResponse<br/>processChannelMessage()"]
  AfterResponse --> ChannelHandler["handleChannelRequest()"]
  ChannelHandler --> Session

  Session --> Harness["harness.ts<br/>agent loop"]
  Harness --> Tools["tools/index.ts<br/>inline tools"]
  Harness --> Model["Google Gemini<br/>Vercel AI SDK"]
  Harness -->|"final/error hooks"| Direct
  Harness -->|"sendText / reactions / typing"| ChannelHandler
  ChannelHandler -->|"channel reply"| Channel

  classDef caller fill:#e8f1ff,stroke:#2f6fba,color:#10233f
  classDef lambda fill:#f3f6f8,stroke:#687683,color:#1f2933
  classDef direct fill:#eaf7ee,stroke:#2d7d46,color:#14351f
  classDef channel fill:#f2e8ff,stroke:#805ad5,color:#2d1b4e
  classDef agent fill:#fff3d6,stroke:#b7791f,color:#3d2b09

  class DirectCaller caller
  class Url lambda
  class Direct direct
  class Channel,ChannelRoute,AfterResponse,ChannelHandler channel
  class Session,Harness,Tools,Model agent
```

### Agent and Storage Boundary

Every request type that needs the model eventually enters the same agent turn loop. `session.ts` owns persistence and context; `harness.ts` owns the model/tool loop.

```mermaid
flowchart TD
  Entrypoint["Direct, async worker, or channel handler"] --> Session["session.ts<br/>claim, persist, load context"]
  Session --> Harness["harness.ts<br/>model + tool loop"]
  Harness -->|"prepareStep refresh"| Session
  Harness --> Tools["tools/index.ts<br/>static inline registry"]
  Tools --> ToolFiles["tools/*.tool.ts<br/>execute inline"]
  Harness --> Model["Google Gemini<br/>Vercel AI SDK"]
  Harness --> ReplyHooks["reply hooks<br/>SSE, status update, webhook, or channel reply"]

  Session --> Processed["DynamoDB: ProcessedEvents"]
  Session --> Conversations["DynamoDB: Conversations"]
  Session --> Memory["S3: MEMORY.md"]
  Tools --> Files["S3: MEMORY.md / tool state"]

  classDef handler fill:#f3f6f8,stroke:#687683,color:#1f2933
  classDef agent fill:#eaf7ee,stroke:#2d7d46,color:#14351f
  classDef storage fill:#ffe8e8,stroke:#c53030,color:#4a1111
  classDef reply fill:#e8f1ff,stroke:#2f6fba,color:#10233f

  class Entrypoint handler
  class Session,Harness,Tools,ToolFiles,Model agent
  class Processed,Conversations,Memory,Files storage
  class ReplyHooks reply
```

## Durable Workflow Compatibility

The current deployed implementation uses Lambda async self-invocation for the background worker. There is no durable workflow Lambda in this deployed stack today.

The compatibility point is for a caller that already owns a separate Lambda durable workflow. That external workflow should delegate the expensive agent turn to this app's `POST /async` endpoint, then wait and poll `GET /status/{eventId}`. The durable workflow can checkpoint between polls, so it does not need to keep its own Lambda compute running while the agent loop, model calls, and inline tools execute inside `harness-processing`.

```mermaid
sequenceDiagram
  participant W as User durable workflow<br/>outside this app
  participant A as harness-processing<br/>Function URL
  participant S as status.ts<br/>AsyncResults
  participant H as handler.ts<br/>async worker
  participant L as session.ts + harness.ts<br/>agent loop

  W->>A: POST /async
  A->>S: create processing status
  A-->>W: 202 Accepted + statusUrl
  A->>H: async self-invocation
  H->>L: run normal agent turn
  L->>L: session context + inline tools + model loop
  L-->>H: final response or error
  H->>S: update status record

  loop Durable wait and poll
    W->>A: GET /status/{eventId}
    A->>S: read status
    S-->>A: processing / completed / failed
    A-->>W: JSON status
  end
```

Important boundaries:

- The durable workflow is owned by the caller, not by this app.
- `POST /async` remains the delegation point and returns `202 Accepted` with `statusUrl`.
- The caller's durable workflow owns wait, retry, and polling behavior.
- `harness-processing` owns request normalization, session setup, and the actual agent/model/tool execution.
- The async worker runs the same agent path as other turns: `handler.ts -> session.ts -> harness.ts -> tools/index.ts`.
- `status.ts` is the status update layer for async direct API work. The worker updates that record when the agent finishes or fails; clients poll it through `/status/{eventId}`.
- Optional signed webhook callbacks can still be delivered by this app when `webhookUrl` and `X-Webhook-Secret` are provided.

Lambda durable functions are useful for longer caller-owned workflows because they support checkpoint and replay semantics through the Durable Execution SDK, including waits without holding the caller's workflow compute for the full wall-clock duration.

## Code Ownership

- [`functions/harness-processing/integrations.ts`](../functions/harness-processing/integrations.ts): request normalization, channel detection, auth checks, direct API parsing, and `/async` plus `/status/{eventId}` route detection.
- [`functions/harness-processing/handler.ts`](../functions/harness-processing/handler.ts): thin orchestration for SSE, async self-invocation, commands, leases, and reply flow.
- [`functions/harness-processing/session.ts`](../functions/harness-processing/session.ts): event deduplication, conversation persistence, prompt context, and memory loading.
- [`functions/harness-processing/status.ts`](../functions/harness-processing/status.ts): async direct API result persistence for polling.
- [`functions/harness-processing/harness.ts`](../functions/harness-processing/harness.ts): model execution loop and inline tool orchestration.
- [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts): static tool registry so tool files are bundled.
- [`functions/_shared/`](../functions/_shared/): shared channel adapters, auth helpers, logging, env, and runtime code.

## Storage and Behavior Boundaries

- `Conversations` DynamoDB table stores normalized model messages by `conversationKey`.
- `ProcessedEvents` DynamoDB table stores dedup markers and short-lived conversation lease records.
- `AsyncResults` DynamoDB table stores async direct API state and final results for `/status/{eventId}` polling.
- The S3 filesystem bucket stores `MEMORY.md` and filesystem-backed tool state under per-conversation namespaces.
- Tool execution is inline in `harness-processing`. Async direct API requests currently use Lambda async self-invocation to run the same harness code in the background.
- The async API contract is intentionally compatible with caller-owned Lambda durable workflows.
- Direct API and webhook traffic share the same Lambda, but use separate `conversationKey` prefixes and routing/auth paths.

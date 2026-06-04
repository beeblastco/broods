# Architecture and Workflows

The deployed system is a multi-account serverless agent harness. Accounts are managed by `account-manage`; runtime traffic is handled by `harness-processing`.

## Runtime Layer

Both Lambdas use the Bun custom runtime and `startStreamingRuntime()` from `functions/_shared/runtime.ts`.

```mermaid
flowchart TD
  Aws["AWS Lambda service"] -->|"provided.al2023"| Bun["Bun custom runtime binary"]
  Bun --> Boot["functions/*/bootstrap.ts"]
  Boot --> Runtime["startStreamingRuntime(handler)"]
  Runtime --> Handler["handler(event)"]
  Handler --> Response["LambdaResponse<br/>status, headers, body, afterResponse"]
  Response --> Runtime
```

Runtime boundary:

- SST points Lambda `handler` to `bootstrap`.
- The runtime passes the full Function URL event envelope into each handler.
- `afterResponse` lets channel webhooks acknowledge quickly, then continue work after the HTTP response.

## High-Level Architecture

```mermaid
flowchart TD
  Owner["Account owner"] -->|"POST /accounts<br/>agents + skills APIs"| ManageUrl["account-manage<br/>Function URL"]
  Admin["Admin"] -->|"Bearer AdminAccountSecret"| ManageUrl
  Direct["Direct API client"] -->|"Bearer account secret<br/>POST / or /async"| HarnessUrl["harness-processing<br/>Function URL"]
  Status["Status poller"] -->|"Bearer account secret<br/>GET /status/\{eventId\}"| HarnessUrl
  Provider["Telegram / GitHub / Slack / Discord"] -->|"/webhooks/\{accountId\}/\{agentId\}/\{channel\}"| HarnessUrl
  WSClient["WebSocket client"] <-->|"wss://gateway"| WSGateway["WebSocket Gateway<br/>(caller's service)"]
  WSGateway -->|"Lambda Event invocation"| HarnessUrl
  HarnessUrl -->|"js.publish (persisted)"| NATS["NATS JetStream"]
  NATS -->|"conversation-scoped<br/>replay on reconnect"| WSGateway

  ManageUrl --> AccountStore["DynamoDB: AccountConfig<br/>account metadata + secretHash"]
  ManageUrl --> AgentStore["DynamoDB: AgentConfig<br/>encrypted agent configs"]
  ManageUrl -->|"Manage Skills"| SkillStore["S3: Skills<br/>account-scoped skill bundles"]
  ManageUrl -->|"Manage Cron Jobs"| CronJobs["DynamoDB: CronJobs"]
  ManageUrl -->|"Create/update/delete schedules"| Scheduler["EventBridge Scheduler"]
  AccountStore -->|Authentication| HarnessUrl
  AgentStore -->|agentId config lookup| HarnessUrl
  HarnessUrl --> Handler["handler.ts"]
  Handler --> Integrations["integrations.ts<br/>account auth + routing"]
  Integrations --> Session["session.ts<br/>conversation state + prompt assembly"]
  Session --> Harness["harness.ts<br/>model/tool loop"]
  Harness --> Model["Configured AI SDK provider<br/>Google / OpenAI / Bedrock / Gateway"]
  Harness --> Tools["workspace + account-enabled tools"]
  Harness -->|"structured JSON logs<br/>usage + tool metadata"| CloudWatch["CloudWatch Logs<br/>metrics + dashboards"]
  Harness --> AsyncTools["async-tools.ts<br/>async external tool wrapper"]
  Harness --> Subagents["subagents.ts<br/>parallel child runs + parent continuation"]
  Handler -->|"nats-worker publishes stream events"| NATS

  Session --> Conversations["DynamoDB: Conversations"]
  Session --> Processed["DynamoDB: ProcessedEvents"]
  AgentStore -->|config resolved before session<br/>passed into session for speed| Session
  Handler --> AsyncAgentResult["DynamoDB: AsyncAgentResult"]
  AsyncTools --> AsyncToolResult["DynamoDB: AsyncToolResult"]
  Scheduler -->|"cron-job event"| HarnessUrl
  HarnessUrl --> CronJobs["DynamoDB: CronJobs"]
  Session --> Workspace["S3: account-scoped workspace files"]
  SkillStore -->|"Load skills metadata"| Session
  Harness -->|"Access skills"| SkillStore 
  Tools --> Filesystem["S3: account-scoped workspace files"]
  Subagents --> AsyncAgentResult
  Subagents --> Session
  AsyncTools --> Session
```

## Account Routing

Every runtime request resolves an account and an account-owned agent before agent work begins.

The diagrams show the logical ownership of runtime config. In code, `integrations.ts` resolves the account once, loads the selected agent, then passes the runtime config into `handler.ts` and `session.ts` to avoid extra lookups during the turn. The runtime projection keeps model, tool, workspace, and skills config, but strips channel credentials before the agent loop.

```mermaid
flowchart TD
  Direct["POST / or /async"] --> Bearer["Authorization: Bearer account secret"]
  Status["GET /status/\{eventId\}"] --> Bearer
  Bearer --> Hash["hash secret"]
  Hash --> Lookup["AccountConfig GSI<br/>SecretHashIndex"]
  Lookup --> Account["active AccountRecord"]

  Webhook["POST /webhooks/\{accountId\}/\{agentId\}/\{channel\}"] --> Load["load account by accountId"]
  Load --> AgentLookup["load agent by agentId"]
  AgentLookup --> ChannelConfig["read encrypted agent config<br/>channels.\{channel\}"]
  ChannelConfig --> Verify["verify provider-native signature/secret"]
  Verify --> Account

  Account --> Namespace["prefix event/conversation keys<br/>acct:\{accountId\}:..."]
```

Root provider webhooks are not accepted. Provider webhook URLs must include the `accountId`, `agentId`, and channel name.

## Account Management

```mermaid
sequenceDiagram
  participant U as Account owner
  participant M as account-manage
  participant A as AccountConfig table
  participant S as Skills S3 bucket

  U->>M: POST /accounts { username, description? }
  M->>M: generate accountId + secret
  M->>A: store secretHash + metadata
  M-->>U: account + one-time secret

  U->>M: POST /accounts/me/agents (Bearer account secret)
  M->>A: store encrypted agent config
  M-->>U: agent + agentId

  U->>M: POST /accounts/me/skills (Bearer account secret)
  M->>S: validate + store skill bundle
  M-->>U: path

  U->>M: PATCH /accounts/me/agents/{agentId}
  M->>A: resolve secretHash
  M->>A: deep-merge agent metadata/config
  M-->>U: redacted account view
```

Provider secrets are not returned in normal account responses. Secret-like fields are redacted as `********`; sending that value back in a patch preserves the existing stored secret.

Deleting an account runs account-scoped cleanup before removing the account record. The cleanup deletes runtime rows whose keys are prefixed with `acct:{accountId}:` and removes the current account filesystem namespaces from S3.

## Direct and Async API

```mermaid
flowchart TD
  Caller["Caller"] -->|"POST /"| Sync["sync direct request"]
  Caller -->|"POST /async"| Async["async direct request"]

  Sync --> Auth["account bearer auth"]
  Async --> Auth
  Auth --> Parse["parse direct payload"]
  Parse --> AgentLookup["load selected agent"]
  AgentLookup --> Session["session.ts<br/>claim + context + skills"]
  Session --> HandlerLoop["handler.ts<br/>parent continuation loop"]
  HandlerLoop --> Coordinator["SubagentCoordinator<br/>created per request"]
  HandlerLoop --> ToolCoordinator["AsyncToolCoordinator<br/>created per request"]
  HandlerLoop --> Agent["harness.ts<br/>configured streamText + tools"]
  Coordinator -->|"dispatchSubagents"| Agent
  ToolCoordinator -->|"wrap async=true execute tools"| Agent
  Agent -->|"SSE chunks"| Caller
  Agent -->|"run_subagent tool call"| Coordinator
  Agent -->|"async external tool call"| ToolCoordinator
  Coordinator --> ChildRuns["subagents.ts<br/>in-process child agent loops"]
  ToolCoordinator --> ToolRuns["same-invocation tool execute"]
  ChildRuns -->|"queued completion"| Coordinator
  ToolRuns -->|"queued completion"| ToolCoordinator
  Coordinator -->|"inject batched result events"| Session
  ToolCoordinator -->|"inject result events"| Session
  Coordinator -->|"heartbeat comments while parent waits"| Caller
  ToolCoordinator -->|"SSE heartbeat comments while parent waits"| Caller
  HandlerLoop -->|"rerun after injected results"| Agent

  Async --> Pending["async-agent-result.ts<br/>processing"]
  Pending --> AsyncTable["AsyncAgentResult"]
  Async --> SelfInvoke["Lambda async self-invocation"]
  SelfInvoke --> Session
  Agent --> Complete["async-agent-result.ts<br/>completed / failed"]
  Complete --> AsyncTable

  Caller -->|"GET /status/\{eventId\}"| Status["status poll"]
  Status --> Auth
  Status --> AsyncTable
```

The async path stays inside `harness-processing`: `POST /async` creates `AsyncAgentResult`, returns a status URL, and starts an internal Lambda Event invocation. Subagents and `same-invocation` async tools run inside that Lambda. `external-dispatch` async tools store delivery metadata and continue later through `/async-tools/{resultId}/complete`.

```mermaid
flowchart TD
  Parent["parent model pass"] --> Kind{"child work type"}
  Kind -->|"subagent"| InMemory["in-memory pending work"]
  Kind -->|"async tool: same-invocation"| InMemory
  Kind -->|"async tool: external-dispatch"| External["external worker"]
  InMemory -->|"wait only while pendingCount > 0"| Inject["inject result into conversation"]
  External -->|"complete endpoint"| Group["sealed dispatch group<br/>all siblings settled"]
  Group --> Inject
  Inject --> Continue["continue parent agent"]
```

Direct sync and async POST access is controlled by `ENABLE_DIRECT_API`, which defaults to `true`. When disabled, `POST /` and `POST /async` are closed while channel webhooks and internal worker invocations remain available.

## Cron Jobs

Cron jobs are included in the default stack as a small scheduled-agent add-on, not a workflow DSL. `account-manage` owns cron job create, update, delete, and list operations: it stores the account-scoped cron job in DynamoDB and creates, updates, or deletes the matching EventBridge Scheduler schedule. EventBridge Scheduler wakes `harness-processing` with `{ kind: "cron-job", accountId, cronJobId }`, and the harness starts the configured agent asynchronously.

```mermaid
flowchart TD
  Manage["account-manage<br/>cron create/update/delete/list"] --> Jobs["DynamoDB: CronJobs"]
  Manage --> Scheduler["EventBridge Scheduler<br/>schedule lifecycle"]
  Scheduler -->|"cron-job event"| Harness["harness-processing"]
  Harness --> Jobs
  Harness -->|"internal async worker event"| Harness
  Harness --> AsyncAgentResult["AsyncAgentResult"]
```

Developers who need custom chaining, cleanup, polling, or external workflow behavior can deploy their own scheduled worker and call the existing direct or async API.

## Channel Webhooks

```mermaid
flowchart TD
  Provider["Provider webhook"] -->|"POST /webhooks/\{accountId\}/\{agentId\}/\{channel\}"| Url["harness-processing URL"]
  Url --> Load["load account + agent config"]
  Load --> Adapter["build channel adapter from agent config"]
  Adapter --> Auth["verify provider-native auth"]
  Auth --> Parse["parse normalized channel message"]
  Parse --> Ack["immediate provider ACK"]
  Parse --> After["afterResponse"]
  After --> Handler["handleChannelRequest()"]
  Handler --> Session["account-scoped session"]
  Session --> Agent["agent loop"]
  Agent --> Reply["channel actions<br/>sendText / typing / reactions"]
  Reply --> Provider
```

Customers talk to the provider bot/app owned by the account. They never receive an account secret.

## WebSocket Gateway (durable NATS JetStream)

Streaming responses are published to a **durable, conversation-scoped JetStream
stream**. The platform owns the durable stream and a documented replay contract;
the gateway that relays to a browser is the **caller's application** (this is a
PaaS — we provide the connection, not the client). Because the stream is keyed by
conversation (not connection), a client that drops can reconnect with a fresh
socket and **replay** events it missed — including a background job's result that
landed after the original connection closed.

```mermaid
flowchart TD
  Client["WebSocket Client"] <-->|"wss://gateway"| GW["WebSocket Gateway<br/>(caller's service)"]
  GW -->|"validate account secret"| Auth["Account auth"]
  Auth -->|"JetStream consumer<br/>replay from last seq on reconnect"| NATS["NATS JetStream<br/>(WS_RESPONSES stream)"]
  Auth -->|"Lambda Event invocation<br/>\{ kind: 'nats-worker', event: \{..., connectionId\} \}"| Harness["harness-processing Lambda"]
  Harness -->|"js.publish (persisted + ack)"| NATS
  NATS -->|"consume v1.\{acct\}.\{agent\}.ws.response.\{convToken\}"| GW
  GW -->|"forward / replay events"| Client
```

The gateway owns client auth, consuming the conversation subject, and the
`nats-worker` Lambda invocation. Lambda persists each AI SDK stream chunk to the
stream; the gateway consumes (and can replay) them.

NATS subject patterns:

| Subject | Direction | Purpose |
| --------- | ----------- | --------- |
| `v1.{accountId}.{agentId}.ws.response.{convToken}` | Lambda → Gateway | Vercel AI SDK stream events (`step-start`, `text`, `tool-call`, `finish`, `error`, …) |

`convToken = base64url(publicConversationKey)` — a single NATS-safe token. The
durable replay cursor is the JetStream message sequence (`JsMsg.seq`), not the
per-invocation envelope `sequence` (which is only an in-turn ordinal).

Notes:

- The `WS_RESPONSES` stream is created on demand (idempotent), file-backed, with
  per-subject retention (`max_age` ~24h, `max_msgs_per_subject`) so finished
  conversations stay replayable for a bounded window. See `functions/_shared/nats.ts`.
- **Reconnect/replay** is a consumer concern: open a JetStream consumer filtered
  to the conversation subject with `deliver_policy: by_start_sequence` +
  `opt_start_seq` (the last `seq` the client persisted). `readConversationStream`
  in `nats.ts` is the reference reader; `examples/nats-stream.ts` demonstrates it.
- `connectionId` is now only a routing/label field on event headers — it no
  longer scopes the subject, so overlapping turns on one conversation share a
  stream (group per turn with `headers.eventId`).
- Background jobs launched over a WebSocket turn republish their result to the
  same conversation stream, so they survive the socket and replay on reconnect.
- `ENABLE_WEBSOCKET=true` and `NATS_URL` are required for `nats-worker`
  invocations. When WebSocket is disabled, the direct API stays SSE-only and NATS
  config is ignored.

> **Infra requirement (applied via CI/CD, not from this repo):** JetStream is
> already enabled on the cluster NATS, but exposing it to browser clients needs a
> NATS **WebSocket listener + ingress** (or a relay gateway) and, for production
> durability, JetStream **clustering** (`replicas: 3`). These live in the infra
> repo. Without them the durable stream still works server-side; only browser
> delivery is unavailable.

## Sandbox & Workspace Boundaries

**Sandbox** (compute) and **workspace** (persistent S3 files) are independent,
account-scoped records, referenced from agent config by id (`sandbox`, `workspaces`). The
handler resolves those references (`resolveAgentRuntime`) before the agent loop. A
sandbox can be attached agent-wide (`config.sandbox`) or per workspace
(`workspaces[].sandbox`, overriding the agent-level one). Each workspace's *effective*
sandbox decides its tools: `read`/`write`/`edit`/`glob`/`grep`/`bash` when present, or
read-only `read`/`glob` when absent (via a read-only mount by default, or direct S3 with the
`sandbox: null` opt-out); `bash` is also exposed stateless when there is no workspace. Each tool's `permissionMode` (`edit`/`ask`/`bypass`)
is resolved per call from the selected workspace.

Every sandbox-backed tool compiles to a single `run` against the provider (`lambda`/`e2b`/
`daytona`/`kubernetes`). The lambda provider deploys the same image as four functions
(workspace mount × internet) and auto-selects one per run. A workspace's namespace is
derived from `accountId:workspaceId`, so agents that reference the same `workspaceId` share
files — including across the sandbox-backed and read-only S3 paths. A workspace with no
sandbox still serves `MEMORY.md` via the S3 API. `workspace.harness.enabled=false`
suppresses only the MEMORY/TASKS guidance.

```mermaid
flowchart LR
  Agents["Agent A / Agent B<br/>sandbox + workspaces refs"] --> Resolve["resolveAgentRuntime"]
  Resolve --> SB["sandboxConfig record"]
  Resolve --> WS["workspaceConfig record"]
  WS --> NS["namespace = hash(accountId:workspaceId)<br/>shared across agents"]
```

See [Workspace & Sandbox](workspace/index.md) for the full model.

## Model and Tool Configuration

Agents control model selection, channel credentials, optional skills, subagents, and tool access through encrypted agent config. `harness.ts` resolves `config.model`; `tools/index.ts` exposes the sandbox tools from a referenced `sandbox` (+ `workspaces`), subagent dispatch from `config.subagent`, search/research tools from `config.tools`, and `load_skill` when `config.skills.enabled` is true and `config.skills.allowed` has paths. See the [API Reference](/api-reference) for the complete `AgentConfig` schema.

## Storage Boundaries

- `AccountConfig`: account metadata and account secret hash.
- `AgentConfig`: account-owned encrypted runtime config payloads.
- `Conversations`: normalized model messages by account-scoped `conversationKey`.
- `ProcessedEvents`: dedup markers and short-lived conversation lease records.
- `AsyncAgentResult`: async direct API and subagent state for `/status/{eventId}` polling.
- `AsyncToolResult`: async external tool call state, same-table dispatch-group rows for external fan-in, delivery metadata for non-SSE continuations, and structured outputs for parent result injection.
- S3 workspace bucket: account/agent-scoped workspace files and staged skill bundles.
- S3 skills bucket: account-scoped skill bundles under `<accountId>/<skill-name>`.

Tool execution is inline unless an agent-configured local `execute` tool sets `async: true`. `execution` chooses `same-invocation` or `external-dispatch`; SSE supports only `same-invocation`, while `/async`, channels, and NATS support both. Subagents are in-process child agent loops; they do not require child Lambda workers.

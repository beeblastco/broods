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
  WSClient["WebSocket client"] <-->|"wss://gateway"| WSGateway["WebSocket Gateway<br/>(separate service)"]
  WSGateway -->|"Lambda Event invocation"| HarnessUrl
  HarnessUrl -->|"publish stream events"| NATS["NATS Server"]
  NATS -->|"connection-scoped responses"| WSGateway

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

## WebSocket Gateway (NATS)

```mermaid
flowchart TD
  Client["WebSocket Client"] <-->|"wss://gateway"| GW["WebSocket Gateway<br/>(separate service)"]
  GW -->|"validate account secret"| Auth["Account auth"]
  Auth -->|"subscribe v1.\{accountId\}.\{agentId\}.ws.response.\{connectionId\}"| NATS["NATS Server"]
  Auth -->|"Lambda Event invocation<br/>\{ kind: 'nats-worker', event: \{..., connectionId\} \}"| Harness["harness-processing Lambda"]
  Harness -->|"publish AI SDK stream chunks"| NATS
  NATS -->|"subscribe v1.\{accountId\}.\{agentId\}.ws.response.\{connectionId\}"| GW
  GW -->|"forward events"| Client
```

The WebSocket gateway owns client authentication, response-subject subscription, and Lambda Event invocation. Lambda publishes to a connection-scoped NATS subject; the gateway forwards those events to the client.

NATS subject patterns:

| Subject | Direction | Purpose |
| --------- | ----------- | --------- |
| `v1.{accountId}.{agentId}.ws.response.{connectionId}` | Lambda → Gateway | Vercel AI SDK stream events (`step-start`, `text`, `tool-call`, `finish`, `error`, etc.) |

Notes:

- Lambda can run multiple `nats-worker` invocations at the same time. Each invocation creates its own NATS connection and publisher, so draining one completed request does not close another request's publisher.
- Response subjects are connection-scoped. If one WebSocket connection allows overlapping turns, the gateway/client should use `headers.eventId` and `sequence` to group events per turn.
- External async tool completions publish back to the same response subject only while the gateway/client remains subscribed; core NATS does not replay missed WebSocket stream chunks.
- Future JetStream support can replay missed WebSocket stream chunks from persisted stream/consumer state.
- If strict conversation ordering is required, the gateway should serialize turns per `conversationKey`.
- `ENABLE_WEBSOCKET=true` and `NATS_URL` are required for `nats-worker` invocations. When WebSocket is disabled, the normal direct API remains SSE-only and NATS configuration is ignored.

This path currently uses core NATS. If JetStream is introduced later, replace best-effort publish/drain with explicit publish acknowledgement, durable consumer replay, duplicate, and backpressure handling.

## Workspace Boundaries

Workspace state is account/agent-scoped and disabled unless the selected agent has `config.workspace.enabled` true. The workspace storage backend is currently `workspace.storage.provider: "s3"`, backed by the configured filesystem bucket. Workspace provides a guidance prompt, storage, and sandbox execution through the model-facing `bash` tool.

When workspace is enabled, Lambda shell commands run in `SandboxBash` against the AWS S3 Files mount, while `python <file.py>` and `python3 <file.py>` continue through `SandboxPython`. E2B and Daytona providers must mount the same S3 workspace bucket at `options.workspaceRoot` so every provider sees the same namespace. Existing `MEMORY.md` files are loaded into the system prompt. `workspace.harness.enabled=false` disables only the default MEMORY/TASKS harness instructions. `workspace.needsApproval` requires approval for `bash` calls. By default workspace state is per conversation; setting `config.workspace.memory.namespace` lets multiple conversations for the same agent share workspace files such as `MEMORY.md`, `TASKS.md`, scripts, data, and staged skills.

```mermaid
flowchart LR
  Conversation["No workspace.memory.namespace"] --> PerConversation["Per-conversation workspace"]
  Namespace["workspace.memory.namespace=support"] --> Shared["Shared account workspace"]
```

See [Workspace](workspace/index.md) for the full model.

## Model and Tool Configuration

Agents control model selection, channel credentials, optional skills, subagents, and tool access through encrypted agent config. `harness.ts` resolves `config.model`; `tools/index.ts` creates the workspace `bash` tool from `config.workspace`, subagent dispatch from `config.subagent`, search/research tools from `config.tools`, and `load_skill` when `config.skills.enabled` is true and `config.skills.allowed` has paths. See the [API Reference](/api-reference) for the complete `AgentConfig` schema.

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

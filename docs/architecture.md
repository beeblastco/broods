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
  Owner["Account owner"] -->|"POST /accounts<br/>PATCH /accounts/me"| ManageUrl["account-manage<br/>Function URL"]
  Admin["Admin"] -->|"Bearer AdminAccountSecret"| ManageUrl
  Direct["Direct API client"] -->|"Bearer accountSecret<br/>POST / or /async"| HarnessUrl["harness-processing<br/>Function URL"]
  Status["Status poller"] -->|"Bearer accountSecret<br/>GET /status/{eventId}"| HarnessUrl
  Provider["Telegram / GitHub / Slack / Discord"] -->|"/webhooks/{accountId}/{channel}"| HarnessUrl

  ManageUrl --> AccountStore["DynamoDB: AccountConfig<br/>secretHash + encrypted config"]
  AccountStore -->|Authentication| HarnessUrl
  HarnessUrl --> Handler["handler.ts"]
  Handler --> Integrations["integrations.ts<br/>account auth + routing"]
  Integrations --> Session["session.ts<br/>conversation state + memory"]
  Session --> Harness["harness.ts<br/>model/tool loop"]
  Harness --> Model["Google AI"]
  Harness --> Tools["inline tools"]

  Session --> Conversations["DynamoDB: Conversations"]
  Session --> Processed["DynamoDB: ProcessedEvents"]
  AccountStore -->|config resolved before session<br/>passed into session for speed| Session
  Handler --> AsyncResults["DynamoDB: AsyncResults"]
  Session --> Memory["S3: account-scoped MEMORY.md"]
  Tools --> Filesystem["S3: account-scoped filesystem/tasks"]
```

## Account Routing

Every runtime request resolves an account before agent work begins.

The diagrams show the logical ownership of runtime config. In code, `integrations.ts` resolves and decrypts the account once, then passes the runtime config into `handler.ts` and `session.ts` to avoid extra lookups during the turn.

```mermaid
flowchart TD
  Direct["POST / or /async"] --> Bearer["Authorization: Bearer accountSecret"]
  Status["GET /status/{eventId}"] --> Bearer
  Bearer --> Hash["hash secret"]
  Hash --> Lookup["AccountConfig GSI<br/>SecretHashIndex"]
  Lookup --> Account["active AccountRecord"]

  Webhook["POST /webhooks/{accountId}/{channel}"] --> Load["load account by accountId"]
  Load --> ChannelConfig["read encrypted config<br/>channels.{channel}"]
  ChannelConfig --> Verify["verify provider-native signature/secret"]
  Verify --> Account

  Account --> Namespace["prefix event/conversation keys<br/>acct:{accountId}:..."]
```

Root provider webhooks are not accepted. Provider webhook URLs must include the account id and channel name.

## Account Management

```mermaid
sequenceDiagram
  participant U as Account owner
  participant M as account-manage
  participant A as AccountConfig table

  U->>M: POST /accounts { username, description?, config? }
  M->>M: generate accountId + accountSecret
  M->>A: store secretHash + encrypted config + metadata
  M-->>U: account + one-time accountSecret

  U->>M: PATCH /accounts/me (Bearer accountSecret)
  M->>A: resolve secretHash
  M->>A: deep-merge metadata/config
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
  Parse --> Session["session.ts<br/>claim + context"]
  Session --> Agent["harness.ts<br/>streamText + tools"]
  Agent -->|"SSE chunks"| Caller

  Async --> Pending["status.ts<br/>processing"]
  Pending --> AsyncTable["AsyncResults"]
  Async --> SelfInvoke["Lambda async self-invocation"]
  SelfInvoke --> Session
  Agent --> Complete["status.ts<br/>completed / failed"]
  Complete --> AsyncTable

  Caller -->|"GET /status/{eventId}"| Status["status poll"]
  Status --> Auth
  Status --> AsyncTable
```

The async path stays inside `harness-processing`: `POST /async` stores a processing record, returns a status URL, and starts an internal async Lambda self-invocation. The worker runs the same account-scoped agent turn and updates `AsyncResults`.

## Channel Webhooks

```mermaid
flowchart TD
  Provider["Provider webhook"] -->|"POST /webhooks/{accountId}/{channel}"| Url["harness-processing URL"]
  Url --> Load["load account config"]
  Load --> Adapter["build channel adapter from account config"]
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

## Memory and Filesystem Boundaries

Memory and filesystem state is account-scoped. By default it is per conversation; setting `config.memoryNamespace` lets multiple conversations in the same account share `MEMORY.md`, filesystem files, and task files.

```mermaid
flowchart LR
  Conversation["No memoryNamespace"] --> PerConversation["Per-conversation memory"]
  Namespace["memoryNamespace=support"] --> Shared["Shared account memory"]
```

See [Memory and Session](memory-and-session.md) for the full model.

## Code Ownership

- [`functions/_shared/accounts.ts`](../functions/_shared/accounts.ts): account records, account secret hashing, bearer auth, encrypted config storage, config merge, and redaction.
- [`functions/account-manage/handler.ts`](../functions/account-manage/handler.ts): account CRUD and admin/self-management HTTP API.
- [`functions/harness-processing/integrations.ts`](../functions/harness-processing/integrations.ts): account auth, direct request parsing, account webhook routing, and channel normalization.
- [`functions/harness-processing/handler.ts`](../functions/harness-processing/handler.ts): SSE, async self-invocation, commands, leases, and reply flow.
- [`functions/harness-processing/session.ts`](../functions/harness-processing/session.ts): event deduplication, conversation persistence, prompt context, and account-scoped memory loading.
- [`functions/harness-processing/status.ts`](../functions/harness-processing/status.ts): async direct API result persistence for polling.
- [`functions/harness-processing/harness.ts`](../functions/harness-processing/harness.ts): model execution loop and inline tool orchestration.
- [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts): static tool registry so tool files are bundled.

## Storage Boundaries

- `AccountConfig`: account metadata, account secret hash, and encrypted config payload.
- `Conversations`: normalized model messages by account-scoped `conversationKey`.
- `ProcessedEvents`: dedup markers and short-lived conversation lease records.
- `AsyncResults`: async direct API state and final results for `/status/{eventId}` polling.
- S3 memory bucket: account-scoped `MEMORY.md`, filesystem, and task state.

Tool execution is inline in `harness-processing`. Async direct API requests use Lambda async self-invocation to run the same harness code in the background.

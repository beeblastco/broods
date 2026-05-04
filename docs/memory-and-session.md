# Memory and Session

This page explains where conversation history, `MEMORY.md`, task files, and filesystem tool files live.

## Mental Model

```mermaid
flowchart TD
  Request["Direct API / Async API / Webhook"] --> Account["Account"]
  Account --> Conversation["Conversation"]
  Conversation --> History["DynamoDB conversation history"]
  Account --> MemoryChoice["Memory namespace choice"]
  MemoryChoice --> Memory["S3 MEMORY.md"]
  MemoryChoice --> Files["S3 filesystem + tasks"]
```

There are two separate things:

- Conversation history: the chat messages for one conversation.
- Workspace state: `MEMORY.md`, task files, and files written by the filesystem tool. Workspace state exists only when `config.workspace.enabled` is true.

## Default: One Memory Per Conversation

If `config.workspace.enabled` is true and the account does not set `workspace.memory.namespace`, every conversation gets its own memory, tasks, and filesystem.

```mermaid
flowchart LR
  T1["Telegram chat 123"] --> M1["Memory A"]
  T2["Telegram chat 456"] --> M2["Memory B"]
  D1["Direct API conversation alpha"] --> M3["Memory C"]
```

Use this when each chat, issue, thread, or direct API conversation should remember different things.

## Shared: One Memory For Many Conversations

Set `config.workspace.memory.namespace` when multiple conversations should share the same memory, tasks, and files.

```json
{
  "config": {
    "workspace": {
      "enabled": true,
      "memory": {
        "namespace": "support"
      }
    }
  }
}
```

```mermaid
flowchart LR
  T1["Telegram chat 123"] --> Shared["Shared memory: support"]
  S1["Slack thread"] --> Shared
  D1["Direct API conversation"] --> Shared
```

Use this when one account should have a shared knowledge/workspace across channels.

## Account Isolation

The namespace is always scoped by account.

```mermaid
flowchart LR
  A["Company A<br/>workspace.memory.namespace=support"] --> AM["Company A support memory"]
  B["Company B<br/>workspace.memory.namespace=support"] --> BM["Company B support memory"]
```

So two accounts can both use `"support"` without sharing data.

## What Uses Workspace

```mermaid
flowchart TD
  Workspace["workspace.enabled=true"] --> Prompt["MEMORY.md<br/>loaded into prompt"]
  Workspace --> Fs["filesystem tool"]
  Workspace --> Tasks["tasks tool"]
  Namespace["workspace.memory.namespace"] --> Prompt
  Namespace --> Fs
  Namespace --> Tasks
```

The filesystem and tasks tools do not need separate `tools` entries. They are enabled together by `workspace.enabled`.

## Session Context Management

Session history is managed before each model turn:

- Pruning is enabled by default through `session.pruning.enabled`; it removes older reasoning/tool-call clutter from the model-visible context without changing persisted history.
- Compaction is disabled by default through `session.compaction.enabled`; when enabled, it uses the account's configured model to summarize older history once the serialized context character count exceeds `session.compaction.maxContextLength`.
- Compaction persists a system summary, keeps the latest user message active, and includes prior compaction summaries when compacting again.

## Configure It

Set or update it through account service.

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "workspace": {
        "enabled": true,
        "memory": {
          "namespace": "support"
        }
      }
    }
  }'
```

Set the namespace to `null` when you want memory to go back to per-conversation behavior. Set `workspace.enabled` to `false` to disable memory, filesystem, and tasks.

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "workspace": {
        "memory": {
          "namespace": null
        }
      }
    }
  }'
```

## Code Path

```mermaid
flowchart TD
  Integrations["integrations.ts<br/>account-scoped conversation keys"] --> Session["session.ts<br/>chooses namespace"]
  Session --> Harness["harness.ts<br/>passes namespace to tools"]
  Harness --> Tools["filesystem.tool.ts<br/>tasks.tool.ts"]
```

Key files:

- [`integrations.ts`](../functions/harness-processing/integrations.ts): builds account-scoped conversation keys.
- [`session.ts`](../functions/harness-processing/session.ts): chooses per-conversation or shared memory namespace.
- [`filesystem.tool.ts`](../functions/harness-processing/tools/filesystem.tool.ts): stores files under that namespace.
- [`tasks.tool.ts`](../functions/harness-processing/tools/tasks.tool.ts): stores task files under that namespace.

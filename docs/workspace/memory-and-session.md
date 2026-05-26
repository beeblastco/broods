# Memory and Session

Memory and session are related but separate:

- Session is the persisted conversation history and the model-visible context projection for a single conversation.
- Memory is the optional `MEMORY.md` file loaded from the Workspace filesystem before each model turn.

Workspace memory is enabled when `config.workspace.enabled` is true and `config.workspace.memory.enabled` is not false. Session pruning and compaction are configured separately under `config.session`.

## Mental Model

```mermaid
flowchart TD
  Request["Incoming request"] --> Session["Session(eventId, conversationKey, accountId, agentId, agentConfig)"]
  Session --> Claim["ProcessedEvents<br/>event claim + conversation lease"]
  Session --> History["Conversations table<br/>persisted model messages"]
  Session --> Context["createTurnContext()"]
  Context --> MemoryEnabled{"workspace memory enabled?"}
  MemoryEnabled -->|"yes"| Memory["S3 workspace<br/><namespace>/MEMORY.md"]
  MemoryEnabled -->|"no"| Prompt["System prompt parts"]
  Memory --> Prompt
  History --> Prune["pruning.ts<br/>drop old transient clutter"]
  History --> Compact["compaction.ts<br/>optional summary when context is large"]
  Prune --> ModelMessages["model-visible messages"]
  Compact --> ModelMessages
  Prompt --> Turn["AI SDK streamText turn"]
  ModelMessages --> Turn
```

## Namespace Behavior

By default, workspace memory is scoped to the conversation:

```mermaid
flowchart LR
  T1["Telegram chat 123"] --> M1["workspace namespace A<br/>MEMORY.md + tasks + files"]
  T2["Telegram chat 456"] --> M2["workspace namespace B<br/>MEMORY.md + tasks + files"]
  D1["Direct API conversation alpha"] --> M3["workspace namespace C<br/>MEMORY.md + tasks + files"]
```

Set `config.workspace.memory.namespace` when multiple conversations should share the same workspace state:

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
  T1["Telegram chat 123"] --> Shared["support namespace<br/>MEMORY.md + tasks + files"]
  S1["Slack thread"] --> Shared
  D1["Direct API conversation"] --> Shared
```

The namespace is still account- and agent-scoped before it is hashed into the filesystem prefix, so two accounts can both use `"support"` without sharing files.

## What the Code Does

[`Session`](https://github.com/beeblastco/filthy-panty/blob/main/functions/harness-processing/session.ts) owns the runtime path:

- `claim()` deduplicates an inbound event in `ProcessedEvents`.
- `acquireConversationLease()` serializes work per conversation.
- `appendIngressEvents()` persists incoming user, assistant, tool, and persisted system messages.
- `createTurnContext()` loads conversation entries, builds system prompt parts, runs compaction when configured, and prunes model-visible messages.
- `loadMemoryFile()` reads `<filesystemNamespace>/MEMORY.md` from the workspace S3 bucket when memory is enabled.
- `filesystemNamespace()` chooses either `workspace.memory.namespace` or the conversation key, scopes it by account and agent, then hashes it with `normalizeFilesystemNamespace()`.

The namespace helper is in [`functions/_shared/runtime-keys.ts`](https://github.com/beeblastco/filthy-panty/blob/main/functions/_shared/runtime-keys.ts). The config interface and validation live in [`functions/_shared/storage/agent-config.ts`](https://github.com/beeblastco/filthy-panty/blob/main/functions/_shared/storage/agent-config.ts).

## Session Context Management

Session history is managed before each model turn:

- Pruning is enabled by default unless `session.pruning.enabled` is false. It removes older reasoning/tool-call clutter from the model-visible context without changing persisted history.
- Compaction is disabled by default unless `session.compaction.enabled` is true. When enabled, it uses the selected agent model to summarize older history once the serialized context exceeds `session.compaction.maxContextLength`.
- Compaction persists a system summary, keeps the latest user message active, and includes prior compaction summaries when compacting again.

## Configure It

Enable per-conversation workspace memory:

```json
{
  "config": {
    "workspace": {
      "enabled": true,
      "memory": {
        "enabled": true
      }
    }
  }
}
```

Share memory, tasks, and sandbox files across conversations for one account agent:

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

Disable memory while keeping workspace tools available:

```json
{
  "config": {
    "workspace": {
      "enabled": true,
      "memory": {
        "enabled": false
      }
    }
  }
}
```

Set `workspace.memory.namespace` to `null` in a patch when you want memory to return to per-conversation behavior. Set `workspace.enabled` to false to disable memory, tasks, and sandbox tools together.

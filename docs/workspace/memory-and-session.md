# Memory and Session

Session history and workspace memory are related but separate:

- Session is persisted conversation history and the model-visible context projection for a single conversation.
- Workspace memory is a developer convention: files like `MEMORY.md`, `TASKS.md`, or `notes/*.md` that the agent reads and updates through the `bash` tool.

The harness still loads `MEMORY.md` into the system prompt when the file exists. It no
longer exposes separate memory or task-list tools. When a workspace has
`harness.enabled` unset or true, the harness also adds short MEMORY/TASKS workflow
instructions by default; the agent then manages memory and task files as ordinary
markdown files in the mounted workspace.

## Mental Model

```mermaid
flowchart TD
  Request["Incoming request"] --> Session["Session(eventId, conversationKey, accountId, agentId, agentConfig)"]
  Session --> Claim["ProcessedEvents<br/>event claim + conversation lease"]
  Session --> History["Conversations table<br/>persisted model messages"]
  Session --> Context["createTurnContext()"]
  Context --> Memory{"MEMORY.md exists?"}
  Memory -->|"yes"| MemoryPrompt["System prompt<br/>current MEMORY.md"]
  Context --> HarnessPrompt{"workspace harness enabled?"}
  HarnessPrompt -->|"yes"| Prompt["System prompt<br/>MEMORY/TASKS guidance"]
  HarnessPrompt -->|"no"| Custom["Agent/system prompt only"]
  History --> Prune["pruning.ts<br/>drop old transient clutter"]
  History --> Compact["compaction.ts<br/>optional summary when context is large"]
  Prune --> ModelMessages["model-visible messages"]
  Compact --> ModelMessages
  Prompt --> Turn["AI SDK streamText turn"]
  MemoryPrompt --> Turn
  Custom --> Turn
  ModelMessages --> Turn
  Turn --> Bash["bash tool"]
  Bash --> Files["Workspace files<br/>MEMORY.md / TASKS.md / project files"]
```

## Workspace Sharing

Workspaces are account-scoped records. Any agent or conversation that references the same
`workspaceId` sees the same files:

```mermaid
flowchart LR
  Create["POST /accounts/me/workspaces<br/>ws_notes"] --> A["Agent A config<br/>notes → ws_notes"]
  Create --> B["Agent B config<br/>notes → ws_notes"]
  A --> Files["shared files<br/>MEMORY.md / TASKS.md / project files"]
  B --> Files
```

Create a workspace, then reference it from the agent:

```jsonc
// POST /accounts/me/workspaces
{ "name": "notes", "config": { "storage": { "provider": "s3" }, "harness": { "enabled": true } } }

// agent config
{
  "sandbox": "sb_default",
  "workspaces": [{ "name": "notes", "workspaceId": "ws_notes" }]
}
```

Agents can expose multiple named workspaces. The first entry is the default when a tool call
omits the optional `workspace` argument:

```jsonc
{
  "sandbox": "sb_default",
  "workspaces": [
    { "name": "personal", "workspaceId": "ws_personal" },
    { "name": "team", "workspaceId": "ws_team", "sandbox": "sb_locked_down" },
    { "name": "docs", "workspaceId": "ws_docs", "sandbox": null }
  ]
}
```

```mermaid
flowchart LR
  C1["Conversation alpha"] --> Personal["personal workspace<br/>ws_personal"]
  C2["Conversation beta"] --> Personal
  C1 --> Team["team workspace<br/>ws_team"]
  C2 --> Team
  C1 --> Docs["docs workspace<br/>read-only S3 direct"]
```

## Runtime Behavior

[`Session`](https://github.com/beeblastco/filthy-panty/blob/main/functions/harness-processing/session.ts) owns the runtime path:

- `claim()` deduplicates an inbound event in `ProcessedEvents`.
- `acquireConversationLease()` serializes work per conversation.
- `appendIngressEvents()` persists incoming user, assistant, tool, and persisted system messages.
- `createTurnContext()` loads conversation entries, builds system prompt parts, runs compaction when configured, and prunes model-visible messages.
- `workspaceBindings()` resolves account-scoped workspace and sandbox records, applies
  per-workspace sandbox overrides, and hashes `accountId:workspaceId` with
  `normalizeFilesystemNamespace()`.
- `filesystemNamespace()` returns the default workspace namespace for existing single-workspace callers.

The namespace helper is in [`functions/_shared/runtime-keys.ts`](https://github.com/beeblastco/filthy-panty/blob/main/functions/_shared/runtime-keys.ts). The config interface and validation live in [`functions/_shared/storage/agent-config.ts`](https://github.com/beeblastco/filthy-panty/blob/main/functions/_shared/storage/agent-config.ts).

## Configure It

Create a workspace with automatic `MEMORY.md` loading and default MEMORY/TASKS harness instructions:

```jsonc
{
  "name": "notes",
  "config": {
    "storage": { "provider": "s3" },
    "harness": { "enabled": true }
  }
}
```

Disable only the MEMORY/TASKS harness instructions while still loading an existing `MEMORY.md`:

```jsonc
{
  "name": "notes",
  "config": {
    "storage": { "provider": "s3" },
    "harness": { "enabled": false }
  }
}
```

Remove a workspace reference from the agent config to disable that workspace's mounted
tools and prompt-time memory loading. Set `workspaces[].sandbox: null` when the agent
should keep read-only `read`/`glob` access through S3 but must not mount or mutate files.

## Session Context Management

Session history is managed before each model turn:

- Pruning is enabled by default unless `session.pruning.enabled` is false. It removes older reasoning/tool-call clutter from the model-visible context without changing persisted history.
- Compaction is disabled by default unless `session.compaction.enabled` is true. When enabled, it uses the selected agent model to summarize older history once the serialized context exceeds `session.compaction.maxContextLength`.
- Compaction persists a system summary, keeps the latest user message active, and includes prior compaction summaries when compacting again.

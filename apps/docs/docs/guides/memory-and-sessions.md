# Memory and sessions

An agent remembers in two places. The session is the conversation history for one conversation. Memory is facts the agent saves to a workspace, which carry across conversations and across every agent that shares the workspace.

## Memory

Memory needs a [workspace](workspaces.md). The agent saves one markdown file per fact under `memory/`, and `memory/MEMORY.md` indexes them with one line each. At the start of every turn the index is loaded into the system prompt, and the agent reads a linked file before relying on it.

With a sandbox behind the workspace, the agent gets a `memory_save` tool that writes an entry like this:

```markdown title="memory/owner-prefers-short-replies.md"
---
name: owner-prefers-short-replies
description: "The workspace owner prefers short, chat-like replies"
metadata:
  node_type: memory
  type: feedback
  originSessionId: slack:T0A6U9DLZV2:C0BGCKWF3PZ
---

Keep replies to a few sentences unless asked for detail.
```

`originSessionId` records the conversation the fact came from, so agents that share a workspace across channels can tell where a memory was learned. A `<memory>` block in the prompt gives the agent today's date, the current conversation, and two rules. The index holds summaries only, and current instructions always outrank memory.

A workspace without a sandbox still loads `memory/MEMORY.md` into the prompt, but the agent cannot save.

### Turn it off

Memory and the workspace guidance prompt are separate features, both on by default:

```ts
import { defineWorkspace } from "broods";

// No memory_save, no <memory> block, index not loaded. File tools stay.
export const notes = defineWorkspace({
  name: "notes",
  harness: { memory: { enabled: false } },
});

// Keep memory, drop the <workspace> prompt that explains the file tools and TASKS.md.
export const bare = defineWorkspace({
  name: "bare",
  harness: { workspace: { enabled: false } },
});
```

An agent that sets `harness` in `defineAgent`, such as Claude Code or Codex, never gets the `<workspace>` prompt, because those runtimes bring their own file tools. Memory still works under every harness.

To drop a workspace's tools and memory from one agent, remove it from that agent's `workspaces`. To keep read-only access, attach it with `sandbox: null`.

`TASKS.md` and any other files are plain files the agent manages with the file tools.

## Shared memory

Every agent and conversation that attaches the same workspace reads and writes the same `memory/`. Give agents separate workspaces, or use [partitioning](workspaces.md#partitioning), when their memories should not mix.

## Session history

Each conversation keeps its full history. Before every model call the platform trims what the model sees, without changing what is stored.

```ts
export const myAgent = defineAgent({
  name: "my-agent",
  session: {
    pruning: { enabled: true },
    compaction: { enabled: true, maxContextLength: 100_000 },
  },
});
```

| Setting                               | Default | What it does                                                                              |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `session.pruning.enabled`             | on      | Drops reasoning and older tool calls with their results from what the model sees          |
| `session.compaction.enabled`          | off     | Summarizes older history with the agent's own model once the pruned context gets too long |
| `session.compaction.maxContextLength` |         | Size of the serialized pruned context that triggers compaction                            |

- On OpenAI and Azure, pruning keeps tool calls in context until compaction. Those providers replay a message by reference to a stored reasoning item, which they refuse without the tool call it produced.
- A tool call with no result, such as an approval nobody answered, is always left out of what the model sees.
- Compaction stores a summary, keeps the latest user message, and folds earlier summaries into the next one. The summary reads the full stored history.
- On Slack, Discord, Matrix, Telegram and Zalo, `/compact [instructions]` compacts on demand between turns, whatever the config says. The instructions steer what the summary keeps. `/new` and `/clear` start over.

A [harness adapter](agents.md) manages its own model context, so these settings apply to the default Broods loop.

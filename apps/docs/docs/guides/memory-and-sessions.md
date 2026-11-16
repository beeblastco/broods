# Memory and sessions

An agent remembers in two places. The session is the conversation history for one conversation. Memory is facts the agent saves to a workspace, which carry across conversations and across every agent that shares the workspace.

## Memory

Memory needs a [workspace](workspaces.md). The agent saves one markdown file per fact under `memory/`, and `memory/MEMORY.md` indexes them with one line each. The whole index is loaded into the system prompt, and the agent reads a linked file before relying on it. The agent is told the index rides every turn, so it keeps the index short by merging or deleting entries.

A conversation keeps the index it loaded while the model's prompt cache is still warm: until 5 minutes pass with no turn, or the history is compacted. A memory saved or deleted in the meantime shows up after that, so a save never forces the whole conversation to be cached again. A new conversation always loads the current index. An index over 256 KB is read fresh on every turn.

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

Saving again under the same title replaces that memory. `memory_delete` removes one that no longer holds: it deletes the file and its index line together and returns the deleted text. The agent sees that text for the rest of the turn and can save it again; after that, pruning hides old tool results from the model, but the text stays in the stored conversation history. Only the Broods-managed bucket also keeps earlier versions of each file; a bucket you bring has whatever versioning you set on it.

`originSessionId` records the conversation the fact came from, so agents that share a workspace across channels can tell where a memory was learned. A `<memory>` block in the prompt gives the agent the current conversation and two rules. The index holds summaries only, and current instructions always outrank memory. Today's date comes from the `<environment>` block every run gets.

A workspace without a sandbox still loads `memory/MEMORY.md` into the prompt, but the agent cannot save or delete.

### Turn it off

Memory and the workspace guidance prompt are separate features, both on by default:

```ts
import { defineWorkspace } from "broods";

// No memory_save or memory_delete, no <memory> block, index not loaded. File tools stay.
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
    autoCompaction: { enabled: true, maxContextLength: 500_000 },
  },
});
```

| Setting                                   | Default | What it does                                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `session.pruning.enabled`                 | on      | Drops reasoning and older tool calls with their results from what the model sees           |
| `session.autoCompaction.enabled`          | on      | Summarizes the history with the agent's own model after a turn whose context grew too long |
| `session.autoCompaction.maxContextLength` | 500000  | Upper bound on the last model call's input tokens before compaction                        |

- On OpenAI and Azure, pruning keeps tool calls in context until compaction. Those providers replay a message by reference to a stored reasoning item, which they refuse without the tool call it produced.
- A tool call with no result, such as an approval nobody answered, is always left out of what the model sees.
- On a model with a context window under 500k tokens, set `maxContextLength` below that window so compaction runs before the provider refuses a turn.
- Auto-compaction runs only after a turn has finished, once the model answered with no tool call left, never between tool steps. It runs before the next queued message, so that message starts from the summary. A turn that stops on a tool approval or a question does not compact.
- If a model rejects a turn because its context is too long, the turn fails with that error and Broods compacts the history, so the next message fits.
- A compaction's model calls count toward usage and cost. In the Tracing tab it shows as a Compaction line with the messages it folded and its tokens, under the turn that triggered it, or as a run of its own for `/compact`.
- Compaction stores a summary and folds earlier summaries into the next one. The summary reads every earlier summary and message. When the model refuses that much input, the older and newer halves are summarized apart and merged. Only a single message too long for the model on its own is cut, keeping as much of its beginning as the model accepts.
- On Slack, Discord, Telegram, Zalo, WhatsApp, Teams, Google Chat, Twilio, Messenger and Instagram, `/compact [instructions]` compacts on demand, whatever the config says. Sent mid-turn, it waits until the model finishes the turn and stops calling tools. The instructions steer what the summary keeps. `/new` and `/clear` start over.

A [harness adapter](agents.md) manages its own model context, so these settings apply to the default Broods loop.

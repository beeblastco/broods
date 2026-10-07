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
- Compaction stores a summary and folds earlier summaries into the next one. The summary reads every earlier summary and message. When the model refuses that much input, the older and newer halves are summarized apart and merged, so no message is dropped.
- On Slack, Discord, Matrix, Telegram, Zalo, WhatsApp, Teams, Google Chat, Twilio, Messenger and Instagram, `/compact [instructions]` compacts on demand, whatever the config says. Sent mid-turn, it waits until the model finishes the turn and stops calling tools. The instructions steer what the summary keeps. `/new` and `/clear` start over.

A [harness adapter](agents.md) manages its own model context, so these settings apply to the default Broods loop.

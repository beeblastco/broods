# Subagents

A subagent is a child run the parent agent starts with `run_subagent`. The parent hands off independent work, keeps going, and continues once the results arrive. Use it for parallel research, a second opinion from a specialist agent, or long side tasks.

```ts title="broods/index.ts"
import { defineAgent, env } from "broods";

export const research = defineAgent({
  name: "research",
  description: "Deep research specialist", // the parent reads this to pick a subagent
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "o3" },
  agent: { system: "You are a research specialist." },
});

export const lead = defineAgent({
  name: "lead",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  subagent: { enabled: true, allowed: [research] },
});
```

## Settings

| Field        | Default        | Meaning                                                                                                                     |
| ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `enabled`    | off            | Turns on `run_subagent`                                                                                                     |
| `allowed`    | `[]`           | Agents the parent may pick. With `[]` the parent can only start virtual subagents, which reuse its own config.              |
| `context`    | `"new"`        | `"inherited"` passes the parent's visible messages to the child for that call. They are not stored in the child's history.  |
| `mode`       | `"persistent"` | Persistent children keep a conversation you can resume, steer and stop. `"ephemeral"` keeps them in memory only.            |
| `stream`     | `false`        | `true` lets a WebSocket client attach to a child's live output                                                              |
| `visibility` | `"result"`     | What the parent sees of a result, `"full"`, `"result"` or `"none"`. The `onSubagentFinish` [hook](hooks.md) can reshape it. |

## How the model uses it

One `run_subagent` call starts up to 10 tasks. Each task has a `prompt`, and optionally the `agentId` of an allowed agent and a `conversationKey` to resume an earlier child. The call returns at once with a `taskId`, `runId` and `conversationKey` per task. Results are injected into the parent automatically when they finish: at the parent's next step if it is still working, or as one batch after its pass.

Children cannot start their own subagents.

In persistent mode the parent also gets:

| Tool                  | Does                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_subagent_status` | Reads a child's status. On a child this turn started, it first waits up to 60s for it to finish. A result read this way is not injected again |
| `update_subagent`     | `steer` changes the running child's direction, or answers its open `ask_parent` question. `continue` queues a follow-up turn                  |
| `stop_subagent`       | Stops the child at its next step. A stopped child's partial work is not sent to the parent.                                                   |

A persistent child gets `ask_parent`: it asks the parent one question and waits up to 5 minutes for the answer. The question reaches the parent at its next step, or wakes it if it is waiting on children. The parent answers with `update_subagent` in `steer` mode. With no answer in time, the child is told to continue on its best judgment.

A parent can only control children it started. From outside, a persistent child is an ordinary conversation. Stop or steer it through the normal run endpoints with its `conversationKey`.

## What a child inherits

- The parent's policies and denied tools, on top of its own. A channel that withholds `bash` from the parent withholds it from every child.
- The same channel and user identity for policy checks.
- A predefined child keeps its own workspaces. A virtual child uses the parent's config, including its hooks.
- Tool approval settings. A child that inherits approval currently fails, so turn approval off on the parent's tools when you use subagents.

## Watching a child live

With `stream: true`, attach to a child over WebSocket using the values `run_subagent` returned:

```json
{
  "type": "attach",
  "requestId": "attach-child-1",
  "agentId": "agent_child",
  "conversationKey": "subagent-persistent-abc123",
  "eventId": "<taskId>",
  "runId": "<runId>"
}
```

A runtime key can attach only to children of a public parent in its own stage. Live output is kept for about three minutes. After that, poll `GET /v1/runs/{runId}` for the result.

## Timing

The parent's request stays open while children run. Over SSE it sends heartbeat comments during quiet waits. If the request is about to hit its deadline, finished results and timeout notices are injected together so the parent can answer with what it has. A follow-up queued on a child after the parent's wait expired still runs, but its result stays in the child's conversation.

The [`subagent` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/subagent) is a runnable example. [Subagent internals](../internals/subagents.md) explains how it works inside.

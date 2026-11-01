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
| `model`      | parent's       | Model for virtual subagents, merged key by key over the parent's `model`. A predefined agent runs on its own model.         |

A virtual subagent on another model keeps everything else of the parent, its tools, MCP servers, sandboxes and hooks included. Provider-defined `tools` resolve on the child's provider, so switch `provider` only when it has them:

```ts title="broods/index.ts"
export const lead = defineAgent({
  name: "lead",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  subagent: { enabled: true, model: { modelId: "o3" } },
});
```

## How the model uses it

One `run_subagent` call starts up to 10 tasks. Each task has a `prompt`, and optionally the `agentId` of an allowed agent and a `conversationKey` to resume an earlier child. Only a key an earlier `run_subagent` call returned resumes: core signs each key for the account and parent agent that minted it and refuses any other, so a model cannot be talked into opening a direct-API caller's conversation with the child agent. The call returns at once with a `taskId`, `runId` and `conversationKey` per task. Results are injected into the parent automatically when they finish: at the parent's next step if it is still working, or as one batch after its pass.

A child that runs a Pi `harness` shares one machine with every other conversation of that agent, each in its own work folder. Set `isolated: true` on a task to give a new conversation a machine of its own, for untrusted code, clashing installs or tests other work could contaminate. The machine a conversation starts on is the one it resumes on. An isolated machine is released after a day idle; the shared one after a week. Claude Code, Codex, Deep Agents and OpenCode always get one machine per conversation, because their bridge binds a fixed port.

Children cannot start their own subagents.

In persistent mode the parent also gets:

| Tool             | Does                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `message-agents` | Messages a child by the `address` `run_subagent` returned. See below.                                          |
| `stop_subagent`  | Stops the child at its next step. A stopped child sends no report: its partial work is not sent to the parent. |

`message-agents` works both ways: the parent messages a child by its address, and a persistent child messages `"parent"`. It takes `to`, `text`, and optionally `wait`, `timeoutSeconds` and `followUp`.

- A running agent reads the message at its next step. An idle child starts a new turn on it, with its work so far.
- `wait: true` waits for the reply, up to `timeoutSeconds` (default 600, at most 3600). For the parent, its turn waits on that child; past the timeout the child keeps going and its reply arrives as a later message. Without `wait`, a child the message starts reports back as a later message.
- A child waiting on `"parent"` ends its turn, and the message is stored on its result row, so a restart or a parent that stopped waiting does not lose it. It reaches the parent at its next step, wakes it if it is waiting on children, or starts a new parent turn later. If the parent does not reply in time, the child resumes with a note and carries on; a late reply still arrives as its next message.
- A child's message to `"parent"` without `wait` is a note: the parent reads it at its next step while the child keeps working.
- Each message returns an `exchangeId`. Passing it back as `followUp` nudges or asks again in the same exchange.
- Messages can start at most 40 turns per parent run, so two agents cannot keep waking each other.

A parent can only message or stop children its conversation started, in this turn or an earlier one. From outside, a predefined persistent child is an ordinary conversation of its agent. Stop or steer it through the normal run endpoints with its `conversationKey`. A virtual child's agent id is `virtual_subagent_<uuid>`, which no agent endpoint knows, so read it with `GET /v1/runs/{runId}` and control it through the parent's tools.

## What a child inherits

- The parent's policies and denied tools, on top of its own. A channel that withholds `bash` from the parent withholds it from every child.
- The same channel and user identity for policy checks.
- A predefined child keeps its own workspaces. A virtual child uses the parent's config, including its tools and hooks, on `subagent.model` when set.
- Tool approval settings. A child that inherits approval currently fails, so turn approval off on the parent's tools when you use subagents.

## Watching a child live

With `stream: true`, attach to a child over WebSocket using the values `run_subagent` returned:

```json
{
  "type": "attach",
  "requestId": "attach-child-1",
  "agentId": "agent_child",
  "conversationKey": "subagent-persistent-3f1c9a2e-7b4d-4e8a-9c21-5d6f0a1b2c3d-8e1f4a2b9c7d6e5f0a1b2c3d4e5f6a7b",
  "eventId": "<taskId>",
  "runId": "<runId>"
}
```

A runtime key can attach only to children of a public parent in its own stage. Live output is kept for about three minutes. After that, poll `GET /v1/runs/{runId}` for the result.

## Timing

The parent's request stays open while children run. Over SSE it sends heartbeat comments during quiet waits. If the request is about to hit its deadline, the parent stops waiting: it gets the finished results and a note that each other child is still running, and answers with what it has. Those children keep working, and each result later arrives in the parent conversation as a new message, which starts a new parent turn. If writing finished results into the parent conversation fails at the end of a pass, the run fails, and each result it did not save arrives later the same way, as does the result of each child still working. Each result arrives once. Once the parent has stopped waiting, a runtime restart within a day of the result does not lose it: a result the restart cut off arrives a few minutes late, and a child the restart killed arrives as failed once its budget has run out, so the parent can run it again. A result older than a day that no run delivered is not sent, and neither is one whose parent run died before it stopped waiting, or one that could neither be saved nor sent while the store was down; those stay readable at their run status URL. A channel or WebSocket conversation gets that turn's reply where it asked; an API conversation finds it in its history on the next run. A follow-up queued on a child after the parent's wait expired still runs, but its result stays in the child's conversation.

Each child turn has a 15-minute budget, and its instructions say so. From 3 minutes before the end its tools are off, so it answers with what it has. A turn stuck in a tool call 3 minutes past the budget is cut off and the parent gets a failure. Stopping the parent run stops its children too, also while it waits for them.

The [`subagent` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/subagent) is a runnable example. [Subagent internals](../internals/subagents.md) explains how it works inside.

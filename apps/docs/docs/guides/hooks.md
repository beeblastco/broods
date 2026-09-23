# Hooks

Hooks are small JavaScript functions you write inline in `defineAgent`. They run at points in a run and can change what happens: add to the system prompt, deny or edit a tool call, rewrite the final answer, reshape a subagent result, or drop a chat message.

To be notified about runs without changing them, use [webhooks](webhooks.md) instead. Both live under `hooks` and work together.

```ts title="broods/index.ts"
import { defineAgent } from "broods";

export const agent = defineAgent({
  name: "guarded-agent",
  hooks: {
    // `system` is appended to the prompt. Return only the addition.
    onStart: () => ({ system: "Never reveal internal IDs." }),

    onToolCall: (ctx, event) =>
      event.toolName === "bash"
        ? { decision: "deny", denyReason: "shell disabled" }
        : { decision: "allow" },

    onMessageReceived: (ctx, event) =>
      event.text.includes("spam") ? { drop: true } : undefined,
  },
});
```

Each hook gets `(ctx, event)` and returns only the fields it may change. A wrong return type is a compile error. On deploy the SDK bundles the functions and uploads them.

## Hook reference

| Hook                | Runs when                        | May return                                                                         |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `onStart`           | a run starts                     | `system` appends to the prompt. `messages` replaces the conversation for this run. |
| `onToolCall`        | before a tool runs               | `decision: "allow" \| "deny"`, `args` to edit the input, `denyReason`              |
| `onToolResult`      | after a tool returns             | `output` replaces the result                                                       |
| `onFinish`          | the final answer is ready        | `output` replaces the answer                                                       |
| `onStepFinish`      | each model step ends             | nothing, observe only                                                              |
| `onError`           | the run fails                    | nothing, observe only                                                              |
| `onApproval`        | a tool waits for approval        | nothing yet. Returning `approve` is not honored.                                   |
| `onSubagentFinish`  | a subagent finishes              | `visibleResult` replaces what the parent sees                                      |
| `onMessageReceived` | a chat message arrives           | `drop` discards it, `text` rewrites it, `metadata` is stored with the message      |
| `onMessageSending`  | a chat reply is about to be sent | `drop` blocks it, `text` rewrites it                                               |

`onMessageReceived` narrows by `event.channel`, so `event.source` is typed per provider. A Pancake message carries `source.tagIds`, for example. It only sees text: an attachment reads as its caption or an empty string, and a `text` rewrite leaves the attachment on the message.

`metadata` returned from `onMessageReceived` shows up on that message in `onStart`'s `messages`, so a later hook can read who sent it without parsing text.

## Sharing state across a run

`ctx.state` is an object every hook in one run shares:

```ts
hooks: {
  onStart: (ctx) => {
    ctx.state.toolCalls = 0;
    return {};
  },
  onToolCall: (ctx) => {
    ctx.state.toolCalls = (ctx.state.toolCalls ?? 0) + 1;
    return { decision: "allow" };
  },
  onFinish: (ctx, event) => ({
    output: `${event.response}\n\n(used ${ctx.state.toolCalls ?? 0} tools)`,
  }),
}
```

- State starts empty on each request and must be JSON-serializable.
- The loop hooks, `onSubagentFinish` and the reply's `onMessageSending` share one state. `onMessageReceived`, delayed background replies and each subagent get their own.
- A hook that throws keeps the state earlier hooks stored. `onError` sees it too.
- Nothing survives the run. For memory across requests, write to your own store with `ctx.fetch`.

## Subagents

A subagent run fires hooks too. A predefined subagent runs its own hooks. A virtual subagent reuses the parent's. Either way its `ctx.state` is its own. The parent's view of a child is `onSubagentFinish`, which runs with the parent's state. Chat hooks never fire for subagents.

## Rules

- Hooks run in an isolated V8 sandbox with only `ctx`, `event` and JavaScript built-ins. No imports, no `require`, no Node modules, no variables from the surrounding file. Uploads that use them are rejected.
- `ctx.fetch` works but blocks private and metadata addresses. `ctx.config` is the agent config, read-only.
- Hooks have a time limit. A hook that throws or times out is logged and skipped, and the run continues unchanged. A hook deny is therefore best effort. For a rule that must hold, use an enforced [policy](policies.md).
- `onFinish` changes the stored and delivered answer, but tokens already streamed over SSE cannot be taken back.
- A return may be at most 128 KB larger than the event it received.
- `console.log` and `info` log at INFO, `warn` and `error` at their levels, `debug` at DEBUG. Lines are tagged `source: "user-code"` and appear in the dashboard Monitoring tab and `broods logs`. DEBUG lines only show in history, never in a live tail.

Runnable example: [`agent-hooks` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/agent-hooks). For a Pancake human-handoff hook, see [Pancake](../channels/pancake.md).

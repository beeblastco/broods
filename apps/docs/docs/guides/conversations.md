# Conversations

A conversation is the history a set of runs share, keyed by `conversationKey`. This page covers what happens when you message an agent that is still working, how to stop it, and how to resume a run that stopped short.

## Messaging a busy agent

A conversation runs one turn at a time. When a message arrives while a turn is running, it does not error and it is not dropped. By default it steers: the message joins the running turn at its next step boundary, after the current model call and tool batch finish and before the next model call. The agent keeps the work it has done and takes your message into account.

If the turn has no step left, the message becomes the next turn instead.

Steer when the run is useful but heading the wrong way. Stop when its output is worthless. Queue when you have more to say but it can wait.

| Mode       | What a busy conversation does with the message                      |
| ---------- | ------------------------------------------------------------------- |
| `steer`    | Joins the running turn at the next step. Default everywhere.        |
| `followup` | Waits and runs as its own turn after earlier work                   |
| `collect`  | Waits, and is merged with other waiting messages into one next turn |
| `reject`   | Refused with `409 conversation_busy`. Nothing is stored.            |

Several steer messages sent quickly are merged into one update. Order is always kept. In a channel, a message from a different person waits for its own turn, so policies check it against its own sender.

### From code

```ts
const status = await client.runAsync(api.agents.support, {
  conversationKey: "ticket-42",
  eventId: "turn-2",
  input: "New information: the database is healthy. Focus on the gateway.",
  // mode: "followup" | "collect" | "reject", omit for steer
});
const final = await status.wait();
console.log(final.requestedMode, final.appliedMode, final.appliedToEventId);
```

`appliedMode` tells you what actually happened. A steer that found no step left reports `appliedMode: "followup"`.

A second `client.stream()` on a busy conversation does not get its own stream. It throws `IngressAcceptedError`, and you poll the accepted run:

```ts
import { IngressAcceptedError } from "broods";

try {
  for await (const part of client.stream(api.agents.support, {
    conversationKey: "ticket-42",
    input: "...",
  })) {
    // ...
  }
} catch (error) {
  if (!(error instanceof IngressAcceptedError)) throw error;
  const terminal = await client.waitForAsyncStatus(error.accepted);
}
```

Over WebSocket, send a `control` frame on the open subscription. See [SDK](../reference/sdk.md) and [HTTP API](../reference/http-api.md).

### From a chat

| Command            | Does                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| any message        | Steers the running turn, or starts one                                                 |
| `/queue <message>` | Queues the message as its own turn                                                     |
| `/queue followup`  | Makes `followup` the default for this conversation. Also `collect`, `reject`, `steer`. |
| `/steer <message>` | Steers explicitly. On an idle conversation it starts a normal turn.                    |
| `/stop`, `/cancel` | Stops the running turn at its next step                                                |
| `/new`, `/clear`   | Clears the history. Refused while a turn or queued message exists.                     |
| `/compact [notes]` | Summarizes the history now. Refused while busy.                                        |

## Stopping a run

- `/stop` in a chat, or stopping a subagent, ends the turn at its next step. The current tool batch finishes, remote tools are not killed, and the run settles as `failed` with `stoppedByUser: true`. Queued messages then run.
- Closing an SSE connection early aborts that run and marks it failed. Finished steps stay in the history. Use `background: true` when the caller may disconnect.
- A WebSocket `cancel` frame, sent when your `AbortSignal` fires or the socket closes, drops the stream at once.

## Resuming a run that stopped

A run that hits `agent.maxTurn` or a provider error ends as `failed` with its history intact. `continue` adds one "continue" message and runs again:

```ts
const resumed = await client.continue(api.agents.support, {
  conversationKey: "ticket-42",
});
await resumed.wait();
```

The dashboard Tracing tab has a Continue button on failed runs that does the same. With a runtime key, `continue` only works on conversations the direct API opened, not channel conversations.

## Retries and idempotency

Send the same `idempotencyKey` (it defaults to `eventId`) to retry safely. The same key with the same payload returns the original run. The same key with a different payload is `409 idempotency_conflict`. Keys are remembered for seven days.

## Limits

| Limit                            | Default                                                  |
| -------------------------------- | -------------------------------------------------------- |
| Queued messages per conversation | 100, and 1 MiB total. Over that: `429 ingress_capacity`. |
| Time a queued message waits      | 15 minutes, then it is `expired`                         |
| Run status kept                  | 7 days                                                   |
| Live stream kept for reconnects  | About 3 minutes                                          |

Every accepted message ends as `completed`, `failed` or `expired`. How it works inside: [Queue and steer design](../internals/queue-and-steer.md).

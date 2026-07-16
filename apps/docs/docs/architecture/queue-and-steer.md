# Queue and Steer Ingress (Proposed v1)

Status: **Proposed** for [issue #71](https://github.com/beeblastco/broods/issues/71).

This decision defines one concurrency contract for direct HTTP, async HTTP,
WebSocket, and channel ingress. It is a contract for later implementation, not a
description of behavior already available.

## Context

Broods currently serializes work with a per-conversation lease. A busy direct
SSE request is rejected with `409`; an async request can be accepted and later
fail as busy. Channel messages use a transactional pending buffer and are
collected into the next turn. The WebSocket gateway permits one active execute
message per socket, and its `cancel` frame only stops gateway-side fetch/read
work—it does not abort the core run.

The v1 goal is to make those concurrency choices explicit and consistent while
preserving current defaults. It is not to add distributed cancellation.

## Decision

### Steering is not interruption

`steer` means **boundary steering**: add accepted input after the current AI SDK
step (including its complete in-flight tool batch) and before the next model
call. It never stops a model call or tool that is already running.

Hard interrupt, abort, and distributed cancellation are separate semantics and
are out of issue #71 v1. They require their own ownership, tool cleanup,
persistence, billing, and terminal-state contract before the public API can
claim that a core run was cancelled. The current gateway-side `cancel` behavior
must not be redefined as core cancellation.

### Public modes

Every ingress surface uses the same four modes:

| Mode       | Busy-conversation behavior                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `reject`   | Do not accept or persist the envelope; return a conflict/error.                                      |
| `followup` | Persist one FIFO envelope that becomes its own turn after earlier work.                              |
| `collect`  | Persist FIFO, then combine all envelopes available at the atomic drain cutoff into one next turn.    |
| `steer`    | Offer the envelope at the next AI SDK step boundary; fall back to `followup` if no boundary remains. |

Defaults stay compatible during the initial rollout:

- direct sync HTTP and WebSocket execute use `reject` when `mode` is omitted;
- async HTTP keeps a non-selectable `legacy-async` compatibility default when
  `mode` is omitted: it durably accepts the request and returns `202`, then a
  worker that finds the conversation busy settles its status as `failed` with
  `CONVERSATION_BUSY`;
- channel messages use `collect` when no channel/conversation preference exists;

`legacy-async` is an internal rollout marker, not a fifth public mode. Once a
caller explicitly supplies `mode`, async HTTP follows the selected public mode;
in particular, explicit `reject` may return a synchronous busy conflict without
creating an accepted envelope.

`collect` is a real public mode, not an undocumented channel optimization.
Collection preserves envelope and event order even though the model sees one
combined turn. Each contributing envelope keeps its own durable status, and the
application relation records the ordered contributor event IDs.

### Transport-neutral ingress envelope

Authentication and transport parsing first produce an in-memory candidate.
Parsing does not persist anything. The conversation coordinator resolves the
explicit or compatibility-default mode and persists an envelope only when it
authorizes acceptance. A busy `reject` candidate is discarded without an
envelope or status row.

```ts
type IngressMode = "reject" | "followup" | "collect" | "steer";

interface IngressCandidate {
  eventId: string;
  conversationKey: string;
  events: ModelMessage[];
  requestedMode?: IngressMode;
  idempotencyKey: string;
  delivery: {
    kind: "http" | "async" | "websocket" | "channel";
    statusUrl?: string;
    connectionId?: string;
    channel?: string;
  };
}

interface IngressEnvelope extends Omit<IngressCandidate, "requestedMode"> {
  requestedMode: IngressMode | "legacy-async";
  applicationId?: string;
  ownerGeneration?: number;
  status:
    | "accepted"
    | "queued"
    | "applied"
    | "processing"
    | "completed"
    | "failed"
    | "expired";
  idempotency: {
    identity: string;
    payloadDigest: string;
  };
  createdAt: string;
  expiresAt: string;
}

interface IngressApplication {
  applicationId: string;
  appliedMode: "followup" | "collect" | "steer";
  appliedToEventId: string;
  contributingEventIds: string[];
  ownerGeneration: number;
}
```

`requestedMode` on the persisted envelope contains either the client's explicit
selection or the resolved compatibility default shown above.

The stored record also carries server-derived `accountId` and `agentId`; clients
cannot select or override them. One canonical idempotency identity is used on
every transport:

```text
(accountId, agentId, scopedConversationKey, idempotencyKey)
```

Clients may provide `idempotencyKey`; otherwise it defaults to `eventId` for
compatibility. `eventId` remains the public correlation ID and is not a second
idempotency identity. First acceptance binds the canonical identity to its
`eventId`, payload digest, envelope, and status. A retry with the same identity
and digest returns that existing `eventId` and status; the same identity with a
different digest is a conflict.

The identity binding/tombstone is retained for at least the same seven-day
window as the status row, including after `completed`, `failed`, or `expired`.
Expiry of a queued envelope therefore does not reopen its identity for duplicate
execution. A rejected candidate has no binding because it was never accepted.

`delivery` contains routing identifiers only. Provider credentials, bearer
tokens, request headers, message payload copies, and other secrets are never
stored as delivery metadata.

### Durable FIFO, bounds, and recovery

Accepted busy ingress is stored as individual FIFO envelopes, not an untyped
array on the lease row. Ordering is by a transactionally assigned conversation
sequence, with `(createdAt, eventId)` only as a diagnostic tie-breaker.

`collect` never replaces its source envelopes. At the atomic drain cutoff, the
coordinator creates one `IngressApplication` whose ordered
`contributingEventIds` contains every source `eventId`, and links each envelope
to it. Every source status then transitions independently through
`applied`/`processing` to the same terminal outcome, preserving per-request
polling, replay, and audit provenance.

Initial limits are configurable, with conservative defaults of 100 queued
envelopes and 1 MiB of serialized queued events per conversation. Acceptance is
atomic: an envelope is either durably inserted with a status record or rejected.
Overflow returns a visible capacity error (`429` is recommended) and never drops
the oldest or newest item silently.

Queued envelopes expire 15 minutes after acceptance by default, matching the
current conversation-lease window. Status records remain pollable for seven days.
Expiry transitions the envelope to terminal `expired`; it does not simply delete
evidence that accepted work was lost.

Every lease acquisition or recovery atomically increments a monotonic
per-conversation `ownerGeneration` and returns it as a fencing token. The
generation survives lease deletion. The owner must renew the lease, and every
dequeue/application, conversation-history write, status transition, result
commit, stream publish, outbox write/claim, and lease release includes the token
and fails unless it still matches the current generation.

Externally visible replies and callbacks go through a durable fenced outbox with
deterministic effect IDs; workers do not send them directly. Only the current
generation can claim an effect, and the dispatcher revalidates the generation
immediately before delivery and supplies the effect ID as provider idempotency
metadata when supported. Tool/provider calls also revalidate before starting.
An external call already in flight when ownership changes cannot be revoked, but
its stale result, output, and follow-on effects are rejected; true remote abort
remains outside v1.

After a process crash, the lease expires and a new generation marks elapsed
envelopes `expired` and resumes the remaining FIFO. Stale workers cannot apply an
envelope or commit outputs after recovery. A failed owner releases or times out
its lease without leaving accepted work permanently `accepted`, `queued`,
`applied`, or `processing`.

```mermaid
flowchart LR
  Accepted["accepted"] --> Queued["queued"]
  Accepted --> Applied["applied"]
  Queued --> Applied
  Applied --> Processing["processing"]
  Processing --> Completed["completed"]
  Processing --> Failed["failed"]
  Accepted --> Expired["expired"]
  Queued --> Expired
  Applied --> Expired
```

Every accepted async ingress therefore reaches `completed`, `failed`, or
`expired`. Each status record includes `requestedMode`, the actual `appliedMode`,
and `appliedToEventId` through its `IngressApplication`. A `steer` that misses
its boundary records `requestedMode: "steer"`, `appliedMode: "followup"`, and the
event ID of the follow-up turn.

### AI SDK boundary

The only v1 steering injection point is the AI SDK `prepareStep` boundary. The
coordinator checks for steering envelopes after `onStepEnd` has observed all tool
results from the current step and before the next model call is prepared. It
appends the steered events durably, refreshes the next step's messages/system
context, and records the active event ID in `appliedToEventId`.

No injection occurs inside a model stream or between tool calls in a parallel
tool batch. If the current run has finished, reached its step limit, entered an
approval/terminal path, or otherwise has no next model call, the coordinator
atomically converts the envelope to `followup`.

### HTTP and status

An initial direct request may still own its `200 text/event-stream` response. A
second request that explicitly uses `followup`, `collect`, or `steer` while that
run is active does **not** receive a second SSE stream. Once durably accepted it
returns `202 application/json`:

```json
{
  "eventId": "event-2",
  "conversationKey": "conversation-1",
  "status": "queued",
  "requestedMode": "steer",
  "statusUrl": "/status/event-2"
}
```

Steered model output remains on the active SSE stream because it is part of that
run. `followup` and `collect` work is observable through the status URL; it does
not keep the accepting HTTP connection open. For direct sync HTTP, omitted or
explicit `reject` retains the existing busy conflict behavior and creates no
accepted status record.

For async HTTP, omitted `mode` keeps the `legacy-async` path: the status row and
envelope are accepted before worker dispatch, and a later busy observation
settles that row as `failed` with `CONVERSATION_BUSY`. Explicit modes use the new
coordinator contract. In every case, async `202` means durable acceptance, never
merely that an in-process worker was scheduled.

### WebSocket control frames

While a run is active, the WebSocket protocol adds correlated control input and
status output. The minimum frame shapes are:

```json
{ "type": "control", "requestId": "r2", "eventId": "event-2", "idempotencyKey": "client-op-2", "mode": "steer", "events": [] }
{ "type": "ack", "requestId": "r2", "eventId": "event-2", "status": "queued" }
{ "type": "status", "requestId": "r2", "eventId": "event-2", "status": "applied", "appliedMode": "steer", "appliedToEventId": "event-1" }
```

`requestId` correlates frames on one socket only. `idempotencyKey` participates
in the canonical identity defined above and defaults to `eventId`; `eventId`
correlates the durable envelope/status. ACK is sent only after durable
acceptance. Later status frames mirror the pollable record.

#### Attach and output replay

A reconnecting client attaches to one active event with the last output cursor
it fully processed:

```json
{ "type": "attach", "requestId": "a1", "agentId": "agent-1", "conversationKey": "conversation-1", "eventId": "event-1", "afterCursor": "ws-responses:4:1234" }
{ "type": "attached", "requestId": "a1", "eventId": "event-1", "status": "processing", "replayFromCursor": "ws-responses:4:1235", "replayThroughCursor": "ws-responses:4:1270" }
{ "type": "output", "eventId": "event-1", "cursor": "ws-responses:4:1235", "replay": true, "data": { "type": "text-delta", "text": "..." } }
```

The cursor is opaque to clients. It encodes the JetStream stream generation and
global `JsMsg.seq`; the publisher-local `NatsStreamEvent.sequence` is not a
resume cursor because it resets for each publisher. `afterCursor` is exclusive:
the first delivered frame has the next retained JetStream sequence. The client
advances its cursor only after it has processed the complete `output` frame.

After authorization, the gateway creates one ordered JetStream consumer starting
at `afterCursor + 1` and snapshots the current high-water mark as
`replayThroughCursor`. Frames through that inclusive boundary carry
`replay: true`; later frames from the same consumer carry `replay: false`. This
single replay-then-tail consumer prevents a gap between replay and live output.
When `afterCursor` is omitted, replay begins at the earliest retained frame for
the target `eventId`. The gateway filters the conversation-scoped stream by the
event ID in the NATS envelope headers.

If the cursor's stream generation is stale or any requested sequence has already
been purged/expired, attach returns `replay_unavailable` with the latest durable
status and `statusUrl`; it never silently skips a gap. On terminal status, the
conversation stream may already be purged, so reconnect returns the terminal
status/result rather than recreating token-by-token output. An attached socket
does not own the run, and status remains pollable for seven days independently
of JetStream's short output-retention window.

Because the current purge is conversation-scoped, the v1 gateway/core lifecycle
must delay it until every attachable event on that conversation is terminal. A
single event finishing must not erase another active event's replay range. After
the last terminal status/result is durable, purge may remove the conversation's
token output; the seven-day status and idempotency records remain.

True abort/cancel remains separate from these control frames. Closing a socket or
aborting a gateway fetch only detaches that reader in v1.

### Channel commands

Channels add two transport-neutral commands:

- `/steer <text>` submits one `steer` envelope. When the conversation is idle,
  the text is normal input and starts a normal turn.
- `/queue <mode>` sets the conversation's channel ingress preference to one of
  `reject`, `followup`, `collect`, or `steer`; the default remains `collect`.

`/clear` must participate in the same conversation coordinator. The v1 default
is to reject `/clear` with a retry message while a turn or queued ingress exists,
then clear only while holding the conversation lease. It must never delete
history concurrently with an active turn.

### Authorization and tenant isolation

Ingress authorization completes before envelope creation:

- account secrets retain account/agent ownership checks;
- deployment keys retain project, environment, endpoint, and agent scope;
- channel ingress retains provider-native authentication and the configured
  account/agent route;
- gateway control frames inherit the authenticated socket's deployment scope.

The server derives the scoped conversation key and storage identity. A caller
cannot steer by presenting another tenant's raw conversation key, event ID,
status URL, NATS subject, or connection ID. Status reads and idempotent retries
repeat the same authorization checks.

### Payload-free observability

Metrics, logs, and traces may record account/agent IDs, event IDs, a hashed or
encoded conversation identity, requested/applied mode, status, queue depth,
event count, age, boundary latency, fallback reason, and
`appliedToEventId`. They must not record message contents, tool inputs/results,
system prompts, authorization values, channel credentials, delivery secrets,
idempotency keys/identities, or raw request headers.

## Implementation sequence

Implement the contract in this dependency order:

1. Durable Convex envelope, FIFO, idempotency, lease, status, and fenced-outbox
   primitives.
2. Core conversation coordinator and AI SDK step-boundary steering.
3. Direct/async HTTP behavior, then SDK types/client and OpenAPI.
4. Gateway attach/control plus WebSocket ACK/status frames.
5. Channel `/steer`, `/queue`, and lease-safe `/clear` commands.
6. Cross-transport integration tests and user/operations documentation.

Do not implement [issue #95](https://github.com/beeblastco/broods/issues/95) in
parallel. Its per-subagent WebSocket attach and JetStream lifecycle must first be
made compatible with this decision's attach/control correlation, durable status,
subject ownership, replay, and purge rules. Otherwise the two issues can encode
incompatible meanings for attach, completion, and stream retention.

## Consequences

- Accepted work becomes durable, bounded, observable, and idempotent across all
  transports.
- Steering is predictable because it cannot split a model call or tool batch.
- Existing direct sync, async, WebSocket, and channel defaults remain stable
  while clients opt into new modes.
- Hard cancellation remains visibly unsupported instead of being approximated by
  disconnecting a gateway reader.
- The implementation requires a coordinator and durable status transitions
  before transport-specific features can ship.

There are no unresolved v1 decision blockers. Queue limits and TTLs are
configuration values, but the defaults above are sufficient for implementation
and can be tuned from production evidence without changing the public contract.

---
title: HTTP and WebSocket API
---

# HTTP and WebSocket API

Use the raw API from any language. TypeScript users get the same calls through the [SDK](sdk.md). Every request and response schema is in the [API reference](/api-reference).

The base URL is `https://gateway.broods.app`, or your own gateway when self-hosting.

## Credentials

Every request sends `Authorization: Bearer <credential>`.

| Endpoint                                           | Accepts                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `POST /v1/runs`, `GET /v1/runs/{runId}`, WebSocket | Stage runtime key, account secret, or a stage session ticket |
| `/v1/*` config routes                              | Account secret, or a role session within its policy          |
| Logs and traces socket                             | Stage session ticket only. The runtime key is refused        |

The runtime key only reaches agents with `publicAccess: true` in its own stage. Prefixes, lifetimes and the other limits of each credential are in [Security](../guides/security.md).

## Run an agent

`POST /v1/runs` streams the turn back as server-sent events.

```bash
curl -N -X POST "https://gateway.broods.app/v1/runs" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_...",
    "eventId": "req-001",
    "conversationKey": "my-conversation",
    "events": [
      { "role": "user", "content": [{ "type": "text", "text": "Hello, who are you?" }] }
    ]
  }'
```

| Field             | Required                            | Description                                                                                                                                               |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`         | yes                                 | Agent to run                                                                                                                                              |
| `eventId`         | yes                                 | Your correlation id                                                                                                                                       |
| `conversationKey` | yes                                 | Conversation to continue or create                                                                                                                        |
| `events`          | yes, unless `answers` or `continue` | AI SDK messages. Roles `user`, `tool`, and `system` with `persist: false`                                                                                 |
| `background`      | no                                  | `true` answers `202` with a run id instead of streaming                                                                                                   |
| `mode`            | no                                  | Busy-conversation behavior, one of `steer`, the default, `followup`, `collect`, `reject`                                                                  |
| `idempotencyKey`  | no                                  | Retry identity. Defaults to `eventId`, bound for 7 days                                                                                                   |
| `system`          | no                                  | One-turn system message or list, not stored                                                                                                               |
| `model`           | no                                  | Per-run call settings such as `temperature`, `maxOutputTokens`, `reasoning`, `providerOptions`. `provider`, `modelId`, `output` and `apiKey` are rejected |
| `answers`         | no                                  | Answers to open `ask_questions` prompts. Cannot be combined with `events`                                                                                 |
| `continue`        | no                                  | Re-enter a run that stopped on the step cap or a provider fault                                                                                           |

The stream carries AI SDK stream parts such as `step-start`, `text-delta`, `tool-call`, `tool-result`, `finish` and `error`. Long quiet waits send SSE comment lines such as `: waiting for async work pending=2` to keep the connection open. Closing the connection before the run finishes aborts the run and marks it failed. Use `background: true` when the caller may disconnect.

The dashboard advertises a scoped form of the same endpoint, `POST /v1/projects/{project}/stages/{stage}/agents/{endpointId}`. It takes the same body and refuses a key from another project or stage with `401`.

## Background runs and polling

```bash
curl -X POST "https://gateway.broods.app/v1/runs" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "agent_...", "eventId": "req-002", "conversationKey": "report", "background": true,
        "events": [{ "role": "user", "content": [{ "type": "text", "text": "Write the report." }] }] }'
```

```json
{
  "runId": "run_8c1d4a9e2f1b40d7a3c65e90b7412fda",
  "eventId": "req-002",
  "conversationKey": "report",
  "status": "processing",
  "requestedMode": "steer",
  "statusUrl": "https://gateway.broods.app/v1/runs/run_8c1d4a9e2f1b40d7a3c65e90b7412fda"
}
```

Poll `GET /v1/runs/{runId}` until the status settles. Status records stay readable for 7 days.

| `status`                                      | Meaning                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `accepted`, `queued`, `applied`, `processing` | Not finished                                                       |
| `awaiting_approval`                           | `approvals` lists tool calls waiting for approval                  |
| `awaiting_input`                              | `questions` lists open `ask_questions` prompts                     |
| `completed`                                   | `response` and `result` hold the answer                            |
| `failed`                                      | `error` explains. `stoppedByUser: true` marks a deliberate `/stop` |
| `expired`                                     | Queued work timed out before it ran                                |

Each status also reports `requestedMode`, `appliedMode` and `appliedToEventId`.

## Answer a question

When a run is `awaiting_input`, post the answers on the same route with no `events`. The conversation resumes by itself.

```bash
curl -X POST "https://gateway.broods.app/v1/runs" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "agent_...", "eventId": "req-003", "conversationKey": "my-conversation", "background": true,
        "answers": [{ "statusId": "async_tool_...", "answers": { "deploy_target": ["dev"] } }] }'
```

`statusId` comes from the question. `answers` maps each question `id` to option labels or free text.

## Continue a stopped run

A turn that hits `agent.maxTurn` or a provider fault ends as `failed` with its history intact. `continue: true` appends one "continue" user turn and runs it as a `followup`. It always answers `202`.

```bash
curl -X POST "https://gateway.broods.app/v1/runs" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "agent_...", "eventId": "req-004", "conversationKey": "my-conversation", "continue": true }'
```

## Busy conversations

A second request on a conversation that is already running follows `mode`:

| Mode       | Behavior                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| `steer`    | Joins the live run at its next step. Becomes a follow-up if the run has no step left |
| `followup` | Runs as its own turn after earlier work                                              |
| `collect`  | Queued messages merge into one later turn                                            |
| `reject`   | Refused with `409 conversation_busy`. Nothing is stored                              |

A queued request answers `202` with a `statusUrl` instead of a second SSE stream. Steered output appears on the live run's stream. Each conversation queues up to 100 requests or 1 MiB; beyond that you get `429 ingress_capacity` with `Retry-After`. Queued requests expire after 15 minutes. See [Conversations](../guides/conversations.md).

## Errors

```json
{
  "error": {
    "message": "...",
    "type": "permission_error",
    "code": "public_access_disabled",
    "param": "agentId"
  }
}
```

Branch on `code`, never on `message`. Each response also carries an `X-Request-Id` header. Quote it when reporting a problem.

| Status | `code`                   | Cause                                                                                                          |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`           | Missing or wrong credential, or a key for another scope                                                        |
| 403    | `public_access_disabled` | The agent does not set `publicAccess: true`                                                                    |
| 403    | `run_overrides_disabled` | `system` or `model` sent without `allowRunOverrides: true`                                                     |
| 403    | `status_access_denied`   | The run's status is not readable from this deployment, such as a subagent run started under another deployment |
| 404    | `run_not_found`          | Unknown run id                                                                                                 |
| 409    | `conversation_busy`      | Busy conversation in `reject` mode                                                                             |
| 409    | `idempotency_conflict`   | Same idempotency key, different payload                                                                        |
| 429    | `ingress_capacity`       | Conversation queue is full                                                                                     |

On a streamed run, these arrive as the first SSE `error` frame instead of a JSON body.

## Python example

```python
import json
import requests

response = requests.post(
    url="https://gateway.broods.app/v1/runs",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "agentId": "agent_...",
        "eventId": "req-001",
        "conversationKey": "my-conversation",
        "events": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
    },
    stream=True,
)

for line in response.iter_lines():
    if line.startswith(b"data: "):
        part = json.loads(line[6:])
        if part.get("type") == "text-delta":
            print(part["text"], end="")
```

## WebSocket

Connect to `wss://gateway.broods.app/v1/agents/{endpointId}/ws`, or the scoped form `/v1/projects/{project}/stages/{stage}/agents/{endpointId}/ws`. Send the key as subprotocols, not in the URL:

```text
Sec-WebSocket-Protocol: broods.v1, broods.token.<runtime key>
```

The server answers `broods.v1`. A proxy in front of the gateway must not log request headers. The old `?token=` query parameter still works and is deprecated.

### Client frames

| Frame     | Purpose                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | Starts a run with `agentId`, `sessionId`, `eventId`, `events` or `answers`, optional `mode`, `idempotencyKey`, `system`, `model` |
| `control` | Adds input to the live run with `requestId`, `eventId`, `events`, and `mode`, default `steer`                                    |
| `attach`  | Reattaches to a run with `requestId`, `agentId`, `conversationKey`, `eventId`, `runId`, optional `afterCursor`                   |
| `cancel`  | Stop reading now. The in-flight step's output is dropped                                                                         |

```json
{
  "type": "control",
  "requestId": "r2",
  "eventId": "event-2",
  "idempotencyKey": "op-2",
  "events": []
}
```

### Server frames

| Frame                | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `meta`               | `{ sessionId, taskId }`. The socket is ready                                      |
| `output`             | `{ eventId, cursor, replay, data }`. `data` is one stream part                    |
| `ack`                | A `control` input was durably accepted                                            |
| `status`             | Later state of that input, with `appliedMode` and `appliedToEventId`              |
| `attached`           | Attach accepted, with `replayFromCursor` and `replayThroughCursor`                |
| `replay_unavailable` | The cursor cannot be resumed. Read the final result from `statusUrl`              |
| `question-request`   | The agent asked with `ask_questions`. Answer with an `execute` carrying `answers` |
| `done`, `error`      | The run ended                                                                     |

```json
{ "type": "ack", "requestId": "r2", "eventId": "event-2", "status": "queued" }
{ "type": "status", "requestId": "r2", "eventId": "event-2", "status": "applied", "appliedMode": "steer", "appliedToEventId": "event-1" }
```

### Resume after a disconnect

Output is kept for about 3 minutes, up to 2,000 frames per conversation. Store the `cursor` of the last `output` frame you fully processed, then reconnect and send `attach` with `afterCursor`. Frames up to `replayThroughCursor` carry `replay: true`. Later frames are live. When the cursor is too old or belongs to another event, the server sends `replay_unavailable` and you read the final result from `GET /v1/runs/{runId}`. A busy `execute` that gets queued receives its `ack`, stays open, and streams once its turn starts.

## Channel webhooks

Providers post to one URL per account and channel type. `broods dev` and `broods deploy` print it after each sync. The production and per-stage URL forms are in [Channels](../channels/index.md).

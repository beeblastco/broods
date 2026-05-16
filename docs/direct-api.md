# Direct API

The direct API is the account-authenticated HTTP surface for `harness-processing`. Create an account through `account-manage`, create an agent, then send:

```http
Authorization: Bearer <accountSecret>
```

Direct API state is internally scoped as `acct:<accountId>:agent:<agentId>:api:<key>`, so different accounts and agents can reuse the same public `eventId` or `conversationKey` without colliding.

Direct sync and async POST access is controlled by the service-level `ENABLE_DIRECT_API` environment variable. It defaults to `true`; when set to `false`, `POST /` and `POST /async` return 404 while channel webhooks and internal worker invocations remain available.

Model behavior and tool access come from the selected agent's encrypted config. Workspace tools come from `config.workspace.enabled`; subagent dispatch comes from `config.subagent.enabled`; search/research tools come from `config.tools`; skills are optional and load only when `config.skills.enabled` is true and `config.skills.allowed` has paths. See [`examples/account.config.example.json`](../examples/account.config.example.json) for the supported agent config shape.

> **Notice:** Every model invocation receives a runtime environment system prompt before the selected agent's configured system prompt. It includes the current runtime time as an ISO timestamp and the runtime timezone. Do not add generic current-time context when creating or invoking an agent unless the request needs a user-specific locale, timezone, or business-time rule.

## Endpoint Summary

| Method | Path | Auth | Response | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/` | none | JSON | Health probe |
| `POST` | `/` | account bearer | SSE | Run a sync direct agent turn |
| `POST` | `/async` | account bearer | JSON | Queue an async direct agent turn |
| `GET` | `/status/{eventId}?agentId={agentId}` | account bearer | JSON | Poll async status |
| `POST` | `/webhooks/{accountId}/{agentId}/{channel}` | provider-native | provider-specific | Channel webhooks, documented in [Channels](channels.md) |

All direct API request bodies use public `eventId` and `conversationKey` values. The service scopes them internally by account and agent.

## WebSocket Gateway

The service supports WebSocket connections through a separate gateway when `ENABLE_WEBSOCKET=true`. With WebSocket enabled, `NATS_URL` is required and the Lambda publishes streaming events to NATS during the agent loop, allowing the gateway to forward real-time responses to connected clients.

### Connection Flow

1. Client connects to the WebSocket gateway with `?token=<accountSecret>&connectionId=<unique-id>`
2. Gateway validates the account secret and extracts `accountId`/`agentId`
3. Gateway subscribes to `v1.{accountId}.{agentId}.ws.response.{connectionId}`
4. Gateway invokes `harness-processing` via Lambda Event invocation with `{ kind: "nats-worker", event: {..., connectionId} }`
5. Lambda runs the agent loop and publishes each Vercel AI SDK stream event to `v1.{accountId}.{agentId}.ws.response.{connectionId}`
6. Gateway receives the matching NATS events and forwards them to the WebSocket client

The gateway invokes the Lambda asynchronously (Event mode), so no HTTP connection is held open during streaming. After the async invoke is accepted, the gateway can acknowledge the client while the Lambda publishes directly to NATS and returns 204 when complete.

The gateway should subscribe to the connection-scoped response subject before invoking Lambda. Each WebSocket request must include a non-empty `connectionId`. `ENABLE_WEBSOCKET=true` and `NATS_URL` must both be configured on `harness-processing` for `nats-worker` invocations.

Concurrent WebSocket requests are handled as separate Lambda invocations. Each invocation creates its own NATS publisher connection, so draining one completed request only closes that request's connection and does not stop another user's stream. Use a unique subject-safe `connectionId` per WebSocket connection and keep the `eventId` in the forwarded event envelope so the gateway/client can demultiplex messages if one connection allows overlapping turns. If strict conversation ordering is required, the gateway should serialize turns per `conversationKey`.

### NATS Event Format

Each event wraps a Vercel AI SDK stream chunk with routing headers:

```json
{
  "type": "stream",
  "headers": {
    "accountId": "acct_...",
    "agentId": "agent_...",
    "conversationKey": "conversation-identifier",
    "eventId": "unique-id-for-dedup",
    "connectionId": "ws-connection-id"
  },
  "data": { "type": "text", "text": "Hello" },
  "sequence": 1
}
```

The `data` field contains the raw Vercel AI SDK stream event — `step-start`, `step-finish`, `text`, `tool-call`, `tool-result`, `finish`, `error`, etc. The gateway derives lifecycle state (task boundaries, approval requests, completion) from these events directly.

### NATS Delivery Model

This integration currently uses core NATS, not JetStream. Core `publish()` enqueues the message on the client connection and does not return a per-message server or persistence acknowledgement. The Lambda publisher sends chunks without waiting for an ack per token, then drains the NATS connection when the request finishes so queued outbound messages are sent before that invocation exits.

If this path moves to JetStream later, update the publisher intentionally: JetStream publish acknowledgements, persistence failures, duplicate windows, and async publish backpressure should be handled explicitly instead of relying on the current core NATS drain behavior.

WebSocket enablement is application infrastructure configuration for the gateway and Lambda environment, not an agent config field. When `ENABLE_WEBSOCKET` is not true, the normal direct API operates in SSE-only mode and NATS configuration is ignored.

## Health Probe: `GET /`

Unauthenticated `GET /` is a lightweight probe for the deployed `harness-processing` Function URL. It returns JSON and points callers at the write method:

```json
{
  "status": "ok",
  "method": "POST"
}
```

## Sync API: `POST /`

POST to the deployed `harness-processing` Function URL with Vercel AI SDK-style messages. This path returns an SSE stream:

```json
{
  "agentId": "agent_...",
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "events": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Hello" }
      ]
    }
  ]
}
```

- `eventId` is used for account-scoped deduplication.
- `conversationKey` selects the account-scoped persisted direct conversation.
- `agentId` selects the account-owned agent config to run.
- `events` may contain `user` messages, one-off `system` messages, and AI SDK `tool-approval-response` tool messages.

Direct API callers can inject ephemeral `system` events:

```json
{
  "agentId": "agent_...",
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "events": [
    {
      "role": "system",
      "content": "The next answer should be terse.",
      "persist": false
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is the capital of France?" }
      ]
    }
  ]
}
```

`system` events are supported only on the direct API path and must use `persist: false`. They are request-local: the runtime includes them in the current model run's system prompt, keeps them through any system-prompt refreshes during that run, and does not store them in DynamoDB. Send the same ephemeral system event again on the next request when the instruction should apply again. The direct API rejects caller-supplied `assistant`, `tool-result`, arbitrary `tool` content, and persisted `system` events.

Use ephemeral `system` events for request-local time overrides, for example when the end user is in a different timezone than the Lambda runtime or when a workflow should interpret "today" against a customer-specific calendar.

## Tool Approval

Agents can require user approval before executing selected tools. Enable this in the selected agent config. External tool behavior is covered in [External Tools](tools.md).

```json
{
  "workspace": {
    "enabled": true,
    "needsApproval": true,
    "memory": {
      "enabled": true,
      "namespace": "support"
    },
    "tasks": { "enabled": true }
  },
  "tools": {
    "tavilySearch": { "enabled": true, "needsApproval": true }
  }
}
```

When a tool needs approval, the SSE stream includes the AI SDK `tool-approval-request` event and the assistant approval request is persisted in the conversation. Send a follow-up request with a fresh `eventId`, the same `conversationKey`, and a native AI SDK tool message:

```json
{
  "agentId": "agent_...",
  "eventId": "fresh-id-for-approval-response",
  "conversationKey": "conversation-identifier",
  "events": [
    {
      "role": "tool",
      "content": [
        {
          "type": "tool-approval-response",
          "approvalId": "approval-id-from-stream",
          "approved": true,
          "reason": "User confirmed"
        }
      ]
    }
  ]
}
```

The `approvalId` is required so the AI SDK can match the decision to the pending tool call. Set `approved` to `false` to deny the tool execution, and include `reason` when the model should explain or adjust its next response.

Minimal `curl` request:

```bash
curl -N "$AGENT_SERVICE_URL" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "agentId": "agent_...",
    "eventId": "unique-id-for-dedup",
    "conversationKey": "conversation-identifier",
    "events": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Hello" }
        ]
      }
    ]
  }'
```

## Webhook Callback

The sync API can send a callback after generation completes. Include `webhookUrl` in the JSON body and `X-Webhook-Secret` in the request headers:

```json
{
  "agentId": "agent_...",
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "webhookUrl": "https://example.com/agent-callback",
  "events": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Hello" }
      ]
    }
  ]
}
```

The HTTP response remains the normal SSE stream. The callback is sent as a JSON `POST` and signed with `X-Webhook-Signature: sha256=<hmac>`.

## Async API: `POST /async`

POST the same request shape to `/async` when the caller should not hold an SSE connection open. The request returns after the pending status is stored and the background Lambda self-invocation is accepted:

```json
{
  "statusUrl": "https://your-function-url.lambda-url.../status/unique-id-for-dedup?agentId=agent_..."
}
```

The async worker runs the same account-scoped harness code in the background. If `webhookUrl` and `X-Webhook-Secret` are provided, completion is also delivered to the callback:

```json
{
  "agentId": "agent_...",
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "response": "final response text",
  "success": true
}
```

If the async run stops for tool approval, the callback uses the same approval summary shape as the status API:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "awaiting_approval",
  "approvals": [
    {
      "approvalId": "approval-id-from-stream",
      "toolCallId": "tool-call-id",
      "toolName": "filesystem",
      "input": { "shell": "rm file.txt" }
    }
  ],
  "success": true
}
```

Without a callback, poll the returned status URL.

## Status API: `GET /status/{eventId}?agentId={agentId}`

Status requests require the same account bearer header. Responses are backed by the account-scoped `AsyncAgentResult` DynamoDB record.

Processing response:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "processing"
}
```

Awaiting approval response:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "awaiting_approval",
  "approvals": [
    {
      "approvalId": "approval-id-from-stream",
      "toolCallId": "tool-call-id",
      "toolName": "filesystem",
      "input": { "shell": "rm file.txt" }
    }
  ]
}
```

Completed response:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "completed",
  "response": "final response text"
}
```

Failed response:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "failed",
  "error": "failure details"
}
```

Unknown event response (`404`):

```json
{
  "eventId": "unique-id-for-dedup",
  "status": "not_found"
}
```

## Error Responses

Non-streaming routing and validation failures return JSON:

```json
{
  "error": "Unauthorized"
}
```

Unsupported methods return:

```json
{
  "error": "Method not allowed",
  "method": "PUT",
  "allowedMethods": ["GET", "POST"]
}
```

## Example Scripts

Live probes use `AGENT_SERVICE_URL` and `ACCOUNT_SERVICE_URL` environment variables. Set the matching provider API key, for example `ACCOUNT_GOOGLE_API_KEY` when using the default Google provider. Each script creates a temporary account, runs the probe with that account secret, then deletes the test account:

```bash
# Account management (Create, Update, Delete)
bun examples/account.ts

# Stream SSE with tools
bun examples/stream.ts

# Async endpoint with polling
bun examples/async.ts

# Tool approval flow
bun examples/tool-approval.ts

# Subagent dispatch and SSE continuation
bun examples/subagent.ts
```

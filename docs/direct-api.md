# Direct API

The direct API is account-authenticated. Create an account through `account-manage`, then send:

```http
Authorization: Bearer <accountSecret>
```

Direct API state is internally scoped as `acct:<accountId>:api:<key>`, so different accounts can reuse the same public `eventId` or `conversationKey` without colliding.

Model behavior and tool access come from the account's encrypted config. Workspace tools come from `config.workspace.enabled`; search/research tools come from `config.tools`. See [`examples/account.config.example.json`](../examples/account.config.example.json) for the supported config shape.

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
- `events` may contain `user` messages and one-off `system` messages only.

Direct API callers can inject ephemeral `system` events:

```json
{
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

`system` events are supported only on the direct API path and must use `persist: false`. The direct API rejects caller-supplied `assistant`, `tool`, and persisted `system` events.

Minimal `curl` request:

```bash
curl -N "$AGENT_SERVICE_URL" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
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
  "statusUrl": "https://your-function-url.lambda-url.../status/unique-id-for-dedup"
}
```

The async worker runs the same account-scoped harness code in the background. If `webhookUrl` and `X-Webhook-Secret` are provided, completion is also delivered to the callback:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "response": "final response text",
  "success": true
}
```

Without a callback, poll the returned status URL.

Live probes use `AGENT_SERVICE_URL` and `ACCOUNT_SERVICE_URL` environment variables. Set the matching provider API key, for example `ACCOUNT_GOOGLE_API_KEY` when using the default Google provider. Each script creates a temporary account, runs the probe with that account secret, then deletes the test account:

```bash
# Account management (Create, Update, Delete)
bun examples/account.ts

# Stream SSE with tools
bun examples/stream.ts

# Async endpoint with polling
bun examples/async.ts
```

## Status API: `GET /status/{eventId}`

Status requests require the same account bearer header. Responses are backed by the account-scoped `AsyncResults` DynamoDB record.

Processing response:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "status": "processing"
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

# Agent Gateway Service

Stateless gateway service for deployed agents.

## Run locally

```bash
bun run service:dev
```

## Endpoint

- `POST /v1/agents/:endpointId`
- `Authorization: Bearer sk_live_xxx`
- Default response mode: `text/event-stream` (SSE)
- Set `"stream": false` in body for JSON response.
- Body:

```json
{
  "message": "Hello",
  "sessionId": "optional_session_id",
  "approvals": [
    {
      "approvalId": "apr_xxx",
      "approved": true,
      "reason": "optional"
    }
  ],
  "stream": true
}
```

Notes:
- Initial call uses `message`.
- If approval is required, the service returns/publishes pending approvals.
- Resume by calling again with `sessionId` + `approvals`.

## Required env vars

- `NEXT_PUBLIC_CONVEX_URL`
- `GATEWAY_SHARED_SECRET`
- `AGENT_API_KEY_PEPPER`
- At least one model provider key:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`

## Optional env vars

- `PORT` (default `8787`)

## Type-safe Convex API

The service imports Convex generated API references from:

- `../convex/_generated/api`
- `../convex/_generated/dataModel`

This gives compile-time args/return type checking for gateway calls.

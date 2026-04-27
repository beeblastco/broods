# filthy-panty

Experimental serverless AI chatbot and agent harness on AWS Lambda. The deployed path is one public Lambda Function URL that handles sync and async direct API traffic plus optional Telegram, GitHub, Slack, and Discord webhooks.

The design goal is simple infrastructure for low-volume usage: Bun on Lambda, SST for infra, DynamoDB for conversation state and dedup, S3 for filesystem-backed tool state, and Vercel AI SDK for the agent loop.

## Architecture

One public Lambda is deployed:

- `harness-processing` runs in Lambda response streaming mode and is the only public entrypoint.

```mermaid
flowchart TD
  A["Direct API caller<br/>POST / or POST /async"] --> B["Lambda Function URL"]
  A2["Direct API poller<br/>GET /status/{eventId}"] --> B
  C["Telegram / GitHub / Slack / Discord webhook"] --> B

  subgraph L["AWS Lambda function: harness-processing"]
    D["bootstrap entrypoint<br/>configured as handler: bootstrap"]
    E["startStreamingRuntime()<br/>custom Bun runtime bridge"]
    F["handler.ts export handler()<br/>application-level Lambda handler"]
    G["integrations.ts routeIncomingEvent()"]
    H["Direct API auth + payload validation"]
    HA["Async API status route"]
    HW["Internal async worker invocation<br/>InvocationType: Event"]
    DW["Optional Lambda durable workflow<br/>future durable execution path"]
    I["Webhook auth + adapter parse"]
    J["session.ts"]
    S["status.ts"]
    N["harness.ts"]
    P["Inline tools registry"]
  end

  B --> D
  D --> E
  E --> F
  F --> G
  G --> H
  G --> HA
  G --> I

  H -->|"POST / sync"| J
  H -->|"POST /async: create pending result"| S
  S --> AS["DynamoDB: async results"]
  S --> HW
  S -.-> DW
  HW -->|"self-invoke background payload"| F
  DW -.->|"durable checkpoint / replay"| F
  HA -->|"GET /status/{eventId}"| S

  J --> N
  N --> P
  N --> O["Google Gemini via Vercel AI SDK"]
  N --> Q["SSE response for POST /"]
  N --> WC["Optional direct API webhook callback"]
  N -->|"async final status update"| S

  I --> ACK["Immediate webhook HTTP ack"]
  I --> PR["afterResponse -> processChannelMessage()"]
  PR --> F2["handler.ts handleChannelRequest()"]
  F2 --> J
  N --> R["Channel reply actions"]

  J --> K["DynamoDB: processed events"]
  J --> L2["DynamoDB: conversations"]
  J --> M["S3: MEMORY.md / tool state"]
```

Request path ownership:

- [`functions/harness-processing/bootstrap.ts`](functions/harness-processing/bootstrap.ts): minimal Bun runtime entrypoint
- [`functions/_shared/runtime.ts`](functions/_shared/runtime.ts): custom Lambda Runtime API bridge with response streaming
- [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts): request normalization, channel detection, auth checks, direct API parsing, and `/async` plus `/status/{eventId}` route detection
- [`functions/harness-processing/handler.ts`](functions/harness-processing/handler.ts): thin orchestration for SSE, async self-invocation, commands, leases, and reply flow
- [`functions/harness-processing/session.ts`](functions/harness-processing/session.ts): event deduplication, conversation persistence, prompt context, and memory loading
- [`functions/harness-processing/status.ts`](functions/harness-processing/status.ts): async direct API result persistence for polling
- [`functions/harness-processing/harness.ts`](functions/harness-processing/harness.ts): model execution loop and inline tool orchestration
- [`functions/harness-processing/tools/index.ts`](functions/harness-processing/tools/index.ts): static tool registry so tool files are bundled
- [`functions/_shared/`](functions/_shared/): shared channel adapters, auth helpers, logging, env, and runtime code

### Handler boundary

- AWS invokes `bootstrap`, not `handler.ts`, because SST config sets `handler: "bootstrap"` in [`sst.config.ts`](sst.config.ts).
- [`bootstrap.ts`](functions/harness-processing/bootstrap.ts) starts [`startStreamingRuntime()`](functions/_shared/runtime.ts), which then calls the exported [`handler()`](functions/harness-processing/handler.ts).

### Storage and runtime boundaries

- `Conversations` DynamoDB table stores normalized model messages by `conversationKey`.
- `ProcessedEvents` DynamoDB table stores dedup markers and short-lived conversation lease records.
- `AsyncResults` DynamoDB table stores async direct API state and final results for `/status/{eventId}` polling.
- The S3 filesystem bucket stores `MEMORY.md` and filesystem-backed tool state under per-conversation namespaces.
- Tool execution is inline in `harness-processing`. Async direct API requests use Lambda async self-invocation to run the same harness code in the background; there is no secondary public worker Lambda or queue-based tool runner in the deployed path.
- The async API contract is intentionally compatible with a Lambda durable workflow implementation: `POST /async` starts work and returns a polling URL immediately, while `/status/{eventId}` remains the client-facing result lookup.
- The direct API and webhook traffic share the same Lambda, but use separate `conversationKey` prefixes and routing/auth paths.

## Stack

- Runtime: Bun on Lambda `provided.al2023` with ARM64 binaries built by `scripts/build.ts`
- Infra: SST v4
- Model SDK: Vercel AI SDK `ai`
- Default provider setup: `@ai-sdk/google`
- Persistence: DynamoDB + S3
- Streaming: SSE for sync direct API callers only

## Security Controls

Ingress and state isolation are enforced in code instead of by separate edge services:

- [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts) disables the direct API unless `ENABLE_DIRECT_API=true`, requires `Authorization: Bearer <DirectApiSecret>`, reserves internal/channel key prefixes, and only accepts `user` plus non-persisted `system` direct events.
- Direct API webhook callbacks are signed with `X-Webhook-Signature: sha256=<hmac>` using the caller-provided `X-Webhook-Secret`.
- [`functions/_shared/telegram-channel.ts`](functions/_shared/telegram-channel.ts) and [`functions/_shared/telegram.ts`](functions/_shared/telegram.ts) verify the Telegram webhook secret and enforce `ALLOWED_CHAT_IDS`.
- [`functions/_shared/github-channel.ts`](functions/_shared/github-channel.ts) verifies `x-hub-signature-256` and optionally restricts ingress with `GITHUB_ALLOWED_REPOS`.
- [`functions/_shared/slack-channel.ts`](functions/_shared/slack-channel.ts) verifies the Slack HMAC signature, rejects requests outside a 5-minute replay window, and optionally restricts ingress with `SLACK_ALLOWED_CHANNEL_IDS`.
- [`functions/_shared/discord-channel.ts`](functions/_shared/discord-channel.ts) and [`functions/_shared/discord-signature.ts`](functions/_shared/discord-signature.ts) verify Discord Ed25519 signatures, reject stale signed requests outside a 5-minute replay window, deny Discord DMs, and optionally restrict guild ingress with `DISCORD_ALLOWED_GUILD_IDS`.
- [`functions/harness-processing/session.ts`](functions/harness-processing/session.ts) uses DynamoDB conditional writes for idempotent event claims and short-lived conversation leases so concurrent webhook deliveries do not execute the same turn twice.
- [`functions/_shared/filesystem-namespace.ts`](functions/_shared/filesystem-namespace.ts) derives collision-resistant hashed filesystem namespaces and lease keys from the full conversation key.

## Examples

The bot can run both as a command-driven chat assistant and as a channel-native research bot.

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Copy local config

```bash
cp .env.example .env
```

### 3. Keep `.env` for local SST config only. Use at least these values

```bash
AWS_PROFILE=default
SST_STAGE=dev
```

Do not put deployed secrets in `.env`.

### 4. Set required SST secrets

```bash
bunx sst secret set GoogleApiKey <value>
```

Optional:

```bash
bunx sst secret set TavilyApiKey <value>
```

If you want the public Function URL to accept direct API requests, also enable `ENABLE_DIRECT_API=true` and set:

```bash
bunx sst secret set DirectApiSecret <value>
```

Or bulk load:

```bash
cp secrets.env.example secrets.env
bunx sst secret load ./secrets.env
```

### 5. Run locally or deploy

```bash
bun run dev
bun run check
bun run build
bun run deploy
```

## Direct API Requests

The direct API is disabled by default. To use it, set `ENABLE_DIRECT_API=true`, configure `DirectApiSecret`, and send `Authorization: Bearer <DirectApiSecret>` with each request.

### Sync API: `POST /`

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

- `eventId` is used for deduplication.
- `conversationKey` selects the persisted direct conversation. The service stores direct API conversations under an internal `api:` namespace so they do not collide with webhook-backed threads.
- `events` may contain `user` messages and one-off `system` messages only.

Direct API callers can also inject `system` events:

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

The sync API can also send a webhook after generation completes. Include `webhookUrl` in the JSON body and `X-Webhook-Secret` in the request headers:

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

### Async API: `POST /async`

POST the same request shape to `/async` when the caller should not hold an SSE connection open. The request returns after the pending status is stored and the background Lambda self-invocation is accepted:

```json
{
  "statusUrl": "https://your-function-url.lambda-url.../status/unique-id-for-dedup"
}
```

The async worker runs the same harness code in the background. If `webhookUrl` and `X-Webhook-Secret` are provided, completion is also delivered to the webhook:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "response": "final response text",
  "success": true
}
```

Without a webhook, poll the returned status URL.

Live async probe with `FUNCTION_URL` and `DIRECT_API_SECRET` set:

```bash
bun scripts/manual/async-api-tool-call.ts
```

### Durable Workflow Compatibility

The current deployed implementation uses Lambda async self-invocation for the background worker. The API shape is designed so that worker can be replaced by an AWS Lambda durable function without changing direct API clients:

- `POST /async` stays the entrypoint and returns `202 Accepted` with `statusUrl`.
- The durable function would own the long-running agent workflow, checkpoint model/tool progress, and resume after retries or pauses.
- `AsyncResults` remains the public polling surface unless a future implementation chooses to expose native durable execution status directly.
- Webhook callbacks keep the same signed JSON payload and can be fired from the durable workflow completion step.

This is useful for longer agent runs because Lambda durable functions support checkpoint and replay semantics through the Durable Execution SDK, including waits without holding compute for the full wall-clock duration. See AWS Lambda durable functions and the Durable Execution SDK docs:

- [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [Durable Execution SDK](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk.html)

### Status API: `GET /status/{eventId}`

Status requests require the same `Authorization: Bearer <DirectApiSecret>` header. Responses are backed by the `AsyncResults` DynamoDB table:

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

## Configuration

`sst.config.ts` is the source of truth for infra names, tags, regions, secrets, and integration flags.

Use `.env` for local SST inputs and non-secret toggles:

- `AWS_PROFILE`
- `SST_STAGE`
- `ENABLE_DIRECT_API`
- `ENABLE_TELEGRAM_INTEGRATION`
- `ENABLE_GITHUB_INTEGRATION`
- `ENABLE_SLACK_INTEGRATION`
- `ENABLE_DISCORD_INTEGRATION`
- All other variables can be setup, see [`.env.example`](.env.example).

Use SST secrets for runtime secrets and tokens. See [`secrets.env.example`](secrets.env.example).

Allow-list semantics:

- In `dev`, you may omit the variable or set it to `open` for intentionally unrestricted local testing.
- Outside `dev`, configure an explicit comma-separated list whenever the integration is enabled.
- Set the value to `closed` to deny all resources until explicit IDs or names are configured.

Important repo conventions:

- Extra channel integrations are opt-in.
- GitHub, Slack, and Discord allow-lists must be explicitly configured outside `dev` when those integrations are enabled.
- The system prompt is bundled at build time by `scripts/system-prompt.ts`.

If Discord is enabled, sync slash commands with:

```bash
bun run discord:sync
```

## Extension Points

Add a tool:

- Create `functions/harness-processing/tools/<name>.tool.ts`
- Export a default tool factory
- Put the tool logic inside `execute`
- Register the factory in [`functions/harness-processing/tools/index.ts`](functions/harness-processing/tools/index.ts)

Add a channel:

- Implement `ChannelAdapter` in `functions/_shared/<channel>-channel.ts`
- Wire normalization and routing into [`functions/harness-processing/integrations.ts`](functions/harness-processing/integrations.ts)
- Keep reply formatting and send logic inside that channel module

Add a command:

- Add a new entry to the `commands` array in [`functions/_shared/commands.ts`](functions/_shared/commands.ts)
- Use the channel-agnostic `ChannelActions` interface from shared code

## Deploy and CI

- `bun run deploy` runs `bun run build` first, then `sst deploy`
- GitHub Actions runs CI on pull requests and non-`main` pushes, and deploys on pushes to `main`
- `bun run test` runs the direct API unit tests locally
- `scripts/manual/direct-api-*.ts` and `scripts/manual/async-api-tool-call.ts` are opt-in live probes for a deployed Function URL; they are not part of CI
- Use `gh run list` and `gh run view` to inspect pipeline status

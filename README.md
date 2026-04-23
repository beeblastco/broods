# filthy-panty

Experimental serverless AI agent orchestrator using AWS Lambda as the core runtime layer. Inspired by Anthropic and Pnzu server architectures but stripped down for small team deployment.

It has some quirks, but the goal is cost-optimized (maybe free when usage under free-tier limits) for low usage rather than burning through VPS bills.

## Architecture

Two Lambda functions behind Function URLs, deployed with SST:

- **telegram-integration** — Receives channel webhooks (currently Telegram), parses messages, dispatches commands, and calls the harness for AI processing. Drains the SSE stream and sends the final reply back to the channel.
- **harness-processing** — Streaming Function URL (`RESPONSE_STREAM` invoke mode). Runs the agentic loop: deduplication, DynamoDB conversation history, Vercel AI SDK `streamText` with Google AI (Gemini), tool calling, Google Search grounding, and extended thinking. Emits SSE events back to the caller.

```mermaid
flowchart TD
  A["Channel Webhook (Telegram, etc.)"] --> B["telegram-integration (Function URL)"]
  B --> C["POST to harness-processing (Function URL)"]
  C --> D["Dedup (DynamoDB)"]
  D --> E["Load conversation history (DynamoDB)"]
  E --> F["streamText() with tools + thinking"]
  F --> G["SSE stream back"]
  G --> H["Accumulate text deltas"]
  H --> I["Reply to channel"]
```

## Request Format

POST to the harness-processing Function URL:

```json
{
  "eventId": "unique-id-for-dedup",
  "conversationKey": "conversation-identifier",
  "content": [
    { "type": "text", "text": "Hello" }
  ]
}
```

`content` follows the Vercel AI SDK `UserContent` type — accepts a plain string or an array of content parts (`text`, `image`, `file`) for multimodal input.

`eventId` prevents duplicate processing (e.g., webhook retries). `conversationKey` identifies which DynamoDB conversation to load/persist.

## Stack

- **Runtime:** Bun on Lambda `provided.al2023` (ARM64)
- **AI:** Vercel AI SDK v6 — any provider supported by the SDK works. Demo uses Gemma 4 31B IT via `@ai-sdk/google` (free tier)
- **Infra:** SST v4 for IaC, AWS serverless stack DynamoDB, Lambda, S3, all covered through free-tier.
- **Streaming:** Lambda Function URL response streaming with SSE

## Development

```bash
bun install
bun run dev        # SST dev mode
bun run build      # Compile all functions to ARM64 binaries
bun run deploy     # Build + deploy
bun run check      # Type-check
```

## Configuration

Most runtime environment variables in this project are injected by SST in `sst.config.ts`, not read from a root `.env` file at runtime.

### Injected By SST

The `harness-processing` Lambda gets these values from the `environment` block in `sst.config.ts`:

- `GOOGLE_API_KEY`
- `GOOGLE_MODEL_ID`
- `CONVERSATIONS_TABLE_NAME`
- `PROCESSED_EVENTS_TABLE_NAME`
- `DEFAULT_SYSTEM_PROMPT`
- `SLIDING_CONTEXT_WINDOW`
- `MAX_AGENT_ITERATIONS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `ALLOWED_CHAT_IDS`
- `TELEGRAM_REACTION_EMOJI`
- `TAVILY_API_KEY`
- `AWS_S3_BUCKET`

In addition, `AWS_REGION` is provided by the Lambda runtime in AWS. The repo currently deploys to `eu-central-1` in `sst.config.ts`.

### What Goes In `.env`

For normal SST usage, keep `.env` limited to local CLI settings such as:

- `AWS_PROFILE`
- `SST_STAGE`

Use `.env.example` as the template for that local file.

### Set SST Secrets

This repo defines these SST secrets in `sst.config.ts`:

- `GoogleApiKey`
- `TavilyApiKey`
- `TelegramBotToken`
- `TelegramWebhookSecret`
- `AllowedChatIds`

Set them one by one with the SST CLI:

```bash
sst secret set GoogleApiKey <value>
sst secret set TavilyApiKey <value>
sst secret set TelegramBotToken <value>
sst secret set TelegramWebhookSecret <value>
sst secret set AllowedChatIds <comma-separated-chat-ids>
```

SST secrets are stage-specific. If you are not running `sst dev`, run `sst deploy` after setting them so the deployed app picks up the new values.

### Bulk Load Secrets

If you prefer a dotenv-style file for secrets, copy `secrets.env.example` to `secrets.env`, fill in your values, and load them with:

```bash
sst secret load ./secrets.env
```

The SST CLI supports loading a dotenv-formatted file this way.

## Adding Things

- **New tool:** Create `functions/harness-processing/tools/<name>.tool.ts`, export a default tool factory that returns one or more AI SDK tools with their logic in `execute`, then import that factory in `functions/harness-processing/tools/index.ts`.
- **New channel:** Implement `ChannelAdapter` in `functions/_shared/<channel>-channel.ts` and register it in the `channels` array in `functions/telegram-integration/handler.ts`.
- **New command:** Add entry to `commands` array in `functions/_shared/commands.ts`.

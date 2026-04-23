# filthy-panty

Experimental serverless AI agent orchestrator using AWS Lambda as the core runtime layer. Inspired by Anthropic and Pnzu server architectures but stripped down for small team deployment.

It has some quirks, but the goal is cost-optimized (maybe free when usage under free-tier limits) for low usage rather than burning through VPS bills.

## Architecture

One public Lambda Function URL, deployed with SST:

- **harness-processing** — Streaming Function URL (`RESPONSE_STREAM` invoke mode). Accepts both direct API calls and supported channel webhooks, verifies and normalizes inbound requests in `functions/harness-processing/integrations.ts`, deduplicates events, loads DynamoDB conversation history, runs the Vercel AI SDK `streamText` loop, and emits SSE only for direct API callers.

```mermaid
flowchart TD
  A["Direct API caller"] --> B["harness-processing Function URL"]
  C["Telegram / GitHub / Slack / Discord webhook"] --> B
  B --> D["Normalize + verify in integrations.ts"]
  D --> E["Dedup (DynamoDB)"]
  E --> F["Load conversation history (DynamoDB)"]
  F --> G["streamText() with tools + thinking"]
  G --> H["SSE for direct callers"]
  G --> I["Channel reply actions for webhook callers"]
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
- `SLIDING_CONTEXT_WINDOW`
- `MAX_AGENT_ITERATIONS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `ALLOWED_CHAT_IDS`
- `TELEGRAM_REACTION_EMOJI`
- `GITHUB_WEBHOOK_SECRET` when `ENABLE_GITHUB_INTEGRATION=true`
- `GITHUB_APP_ID` when `ENABLE_GITHUB_INTEGRATION=true`
- `GITHUB_PRIVATE_KEY` when `ENABLE_GITHUB_INTEGRATION=true`
- `GITHUB_ALLOWED_REPOS` when `ENABLE_GITHUB_INTEGRATION=true`
- `SLACK_BOT_TOKEN` when `ENABLE_SLACK_INTEGRATION=true`
- `SLACK_SIGNING_SECRET` when `ENABLE_SLACK_INTEGRATION=true`
- `SLACK_ALLOWED_CHANNEL_IDS` when `ENABLE_SLACK_INTEGRATION=true`
- `DISCORD_BOT_TOKEN` when `ENABLE_DISCORD_INTEGRATION=true`
- `DISCORD_PUBLIC_KEY` when `ENABLE_DISCORD_INTEGRATION=true`
- `DISCORD_ALLOWED_GUILD_IDS` when `ENABLE_DISCORD_INTEGRATION=true`
- `TAVILY_API_KEY`
- `AWS_S3_BUCKET`

In addition, `AWS_REGION` is provided by the Lambda runtime in AWS. The repo currently deploys to `eu-central-1` in `sst.config.ts`.

The system prompt is bundled from `SYSTEM.md` at build time and is not injected as a Lambda environment variable.

### What Goes In `.env`

For normal SST usage, keep `.env` limited to local CLI settings such as:

- `AWS_PROFILE`
- `SST_STAGE`
- `ENABLE_GITHUB_INTEGRATION`
- `ENABLE_SLACK_INTEGRATION`
- `ENABLE_DISCORD_INTEGRATION`

Use `.env.example` as the template for that local file.

### Set SST Secrets

This repo defines these SST secrets in `sst.config.ts`:

- `GoogleApiKey`
- `TavilyApiKey`
- `TelegramBotToken`
- `TelegramWebhookSecret`
- `AllowedChatIds`
- `GitHubWebhookSecret`
- `GitHubAppId`
- `GitHubPrivateKey`
- `SlackBotToken`
- `SlackSigningSecret`
- `DiscordBotToken`
- `DiscordPublicKey`

Set them one by one with the SST CLI:

```bash
bunx sst secret set GoogleApiKey <value>
bunx sst secret set TavilyApiKey <value>
bunx sst secret set TelegramBotToken <value>
bunx sst secret set TelegramWebhookSecret <value>
bunx sst secret set AllowedChatIds <comma-separated-chat-ids>
bunx sst secret set GitHubWebhookSecret <value>
bunx sst secret set GitHubAppId <value>
bunx sst secret set GitHubPrivateKey < private-key.pem
bunx sst secret set SlackBotToken <value>
bunx sst secret set SlackSigningSecret <value>
bunx sst secret set DiscordBotToken <value>
bunx sst secret set DiscordPublicKey <value>
```

SST secrets are stage-specific. If you are not running `sst dev`, run `sst deploy` after setting them so the deployed app picks up the new values.

### Integration Flags And Allow Lists

The extra integrations are opt-in in `sst.config.ts`. Set these in your local `.env` before `sst dev` or `sst deploy`:

- `ENABLE_GITHUB_INTEGRATION=true`
- `ENABLE_SLACK_INTEGRATION=true`
- `ENABLE_DISCORD_INTEGRATION=true`

Optional allow lists are read from the SST config environment and default to `open`:

- `GITHUB_ALLOWED_REPOS`
- `SLACK_ALLOWED_CHANNEL_IDS`
- `DISCORD_ALLOWED_GUILD_IDS`

### Bulk Load Secrets

If you prefer a dotenv-style file for secrets, copy `secrets.env.example` to `secrets.env`, fill in your values, and load them with:

```bash
sst secret load ./secrets.env
```

The SST CLI supports loading a dotenv-formatted file this way.

## Adding Things

- **New tool:** Create `functions/harness-processing/tools/<name>.tool.ts`, export a default tool factory that returns one or more AI SDK tools with their logic in `execute`, then import that factory in `functions/harness-processing/tools/index.ts`.
- **New channel:** Implement `ChannelAdapter` in `functions/_shared/<channel>-channel.ts` and wire it into `functions/harness-processing/integrations.ts`.
- **New command:** Add entry to `commands` array in `functions/_shared/commands.ts`.

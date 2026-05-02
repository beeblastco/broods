# Operations

## Configuration

`sst.config.ts` is the source of truth for infra names, tags, region, Lambda resources, DynamoDB tables, S3 bucket, and SST secrets.

Use `.env` for local SST inputs only:

- `AWS_PROFILE`
- `SST_STAGE`

There is no `phicks` stage for deployment; use `dev` unless another real stage is intentionally added.

Runtime secrets are SST secrets:

```bash
bunx sst secret set GoogleApiKey <value>
bunx sst secret set TavilyApiKey <value>
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
```

`AdminAccountSecret` authenticates admin account-management requests. `AccountConfigEncryptionSecret` encrypts account config payloads in DynamoDB. Treat both as stable production secrets; rotating the encryption secret requires a re-encryption migration for existing account configs.

Provider integration secrets are no longer global SST secrets. Channel credentials and account-specific model provider keys live in each account's encrypted config. Shared runtime API keys such as `GoogleApiKey` and `TavilyApiKey` remain SST secrets; account config chooses which model/tools may use them.

Public account creation is throttled by `ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR`, currently set to `5` in `sst.config.ts`.

## Local Setup

Install dependencies:

```bash
bun install
```

Copy local config:

```bash
cp .env.example .env
```

Keep `.env` for local SST config only. Do not put deployed secrets in `.env`.

## Run, Build, and Deploy

```bash
bun run dev
bun run check
bun run build
bun run deploy
```

`bun run deploy` runs `bun run build` first, then `sst deploy`.

Deploy outputs include:

- `accountManageUrl`
- `harnessProcessingUrl`
- DynamoDB table names
- `filesystemBucketName`

## Post-Deploy Account Setup

Create an account:

```bash
curl -X POST "$ACCOUNT_MANAGE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Customer support agent for Company A",
    "config": {}
  }'
```

Store the returned `accountSecret`. Use it for:

- `account-manage` self-service calls.
- `harness-processing` direct API calls.
- `/async` and `/status/{eventId}` calls.

Configure provider webhooks with the returned `accountId`:

```text
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/telegram
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/github
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/slack
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/discord
```

Then patch the account config with the provider credentials needed for each channel, plus any model/tool settings. See [Account management](account-management.md#account-config) for the supported config shape.

CI/CD configures the default Telegram account after deploy. It creates or updates the `telegram-default` account config from Telegram GitHub Actions secrets, then registers Telegram to `/webhooks/{accountId}/telegram`.

## Default Telegram Account

The deploy workflow runs:

```bash
bun run scripts/configure-telegram-account.ts
```

The script requires `ADMIN_ACCOUNT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `ALLOWED_CHAT_IDS`. It also writes the account runtime config used by the harness: `ACCOUNT_MODEL_PROVIDER` defaults to `google`, `ACCOUNT_MODEL_ID` defaults to `gemma-4-31b-it`, and the matching provider API key must be present, for example `ACCOUNT_GOOGLE_API_KEY` for Google. `ACCOUNT_TOOLS_JSON`, `ACCOUNT_MODEL_OPTIONS_JSON`, and `ACCOUNT_PROVIDER_CONFIG_JSON` can override the generated defaults. It reads `ACCOUNT_MANAGE_URL` and `HARNESS_PROCESSING_URL` from environment overrides when present, otherwise from `.sst/outputs.json`.

The Discord, GitHub, Slack, and Telegram configure scripts all use the same runtime config helper. Each script upserts by its integration account username, writes channel credentials into encrypted account config, and preserves the generated model/provider/tools config in the same encrypted payload.

## Live Probes

Manual direct API scripts accept optional URL overrides:

```bash
export FUNCTION_URL=<harnessProcessingUrl>
export ACCOUNT_MANAGE_URL=<accountManageUrl>
export ACCOUNT_GOOGLE_API_KEY=<googleApiKey>
```

If either variable is omitted, the scripts read the corresponding value from `.sst/outputs.json`.

Each script creates a temporary account through `ACCOUNT_MANAGE_URL/accounts`, including the same generated model/provider/tools config used by CI-created channel accounts, runs the probe with the returned account secret, then deletes the test account through `DELETE /accounts/me` in a cleanup step.

Confirm the harness URL is live:

```bash
curl "$FUNCTION_URL"
```

Expected response:

```json
{
  "status": "ok",
  "method": "POST"
}
```

Run:

```bash
bun scripts/manual/account-lifecycle.ts
bun scripts/manual/direct-api-stream.ts
bun scripts/manual/direct-api-tool-call.ts
bun scripts/manual/direct-api-multi-turn.ts
bun scripts/manual/async-api-tool-call.ts
```

## Discord Command Sync

`bun run discord:sync` remains a manual utility. It still reads Discord app credentials from local environment variables for command registration and is separate from account runtime config.

## CI

- GitHub Actions runs CI on pull requests and non-`main` pushes, and deploys on pushes to `main`.
- Deploy requires repository secrets `SST_SECRET_GOOGLEAPIKEY`, `SST_SECRET_TAVILYAPIKEY`, `SST_SECRET_ADMINACCOUNTSECRET`, and `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`.
- Default Telegram account configuration prefers repository secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_ALLOWED_CHAT_IDS`. The deploy workflow also accepts the existing `SST_SECRET_TELEGRAMBOTTOKEN`, `SST_SECRET_TELEGRAMWEBHOOKSECRET`, and `SST_SECRET_ALLOWEDCHATIDS` GitHub secret names as compatibility inputs; these values are written into account config, not loaded as SST runtime secrets.
- `bun run test` runs unit tests locally.
- Use `gh run list` and `gh run view` to inspect pipeline status.

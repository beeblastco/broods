# Operations

## Configuration

`sst.config.ts` is the source of truth for infra names, tags, region, Lambda resources, DynamoDB tables, S3 bucket, and SST secrets.

Use `.env` for local SST inputs only:

- `AWS_PROFILE`
- `SST_STAGE`

Runtime secrets are SST secrets. Generate your own secret and set

```bash
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
```

- `AdminAccountSecret` - Authenticates admin account-management requests.
- `AccountConfigEncryptionSecret` - Encrypts account config payloads in DynamoDB.

Treat `AdminAccountSecret` and `AccountConfigEncryptionSecret` as stable production secrets; rotating the encryption secret requires a re-encryption migration for existing account configs.

Provider API keys are account-specific, not global SST secrets. Each account configures their own provider API key in `config.provider.<provider>.apiKey`. Similarly, tool API keys like Tavily are configured per account in `config.tools.<tool>.apiKey`. This allows different users to use their own API keys.

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

Then patch the account config with the provider credentials needed for each channel, plus any model/tool settings. See the example config file at [`examples/example.account.config.json`](../../examples/example.account.config.json) for the supported config shape.

## CI/CD Account Setup

After deploy, the GitHub workflow optionally runs configure scripts if credentials are provided. Skip by not setting the channel-specific secrets.

```bash
# Optional: run only if TELEGRAM_BOT_TOKEN and all other TELEGRAM_* is token set
bun run scripts/configure-telegram-account.ts

# Optional: run only if DISCORD_BOT_TOKEN and all other DISCORD_* token is set  
bun run scripts/configure-discord-account.ts

# Optional: run only if SLACK_BOT_TOKEN and all SLACK_* token is set
bun run scripts/configure-slack-account.ts

# Optional: run only if GITHUB_APP_ID and all GITHUB_* token is set
bun run scripts/configure-github-account.ts
```

Each script uses `ADMIN_ACCOUNT_SECRET` for auth.

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

## CI

- GitHub Actions runs CI on pull requests and non-`main` pushes, and deploys on pushes to `main`.
- Deploy requires repository secrets `SST_SECRET_ADMINACCOUNTSECRET` and `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`.

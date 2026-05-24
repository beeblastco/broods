# Deployment

`sst.config.ts` is the source of truth for infra names, tags, region, Lambda resources, DynamoDB tables, S3 bucket, and SST secrets.

## Local Setup

```bash
bun install
cp .env.example .env
```

Keep `.env` for local SST inputs only:

- `AWS_PROFILE`
- `SST_STAGE`
- `ENABLE_DIRECT_API`
- `ENABLE_WEBSOCKET`
- `NATS_URL`

Runtime secrets are SST secrets:

```bash
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
```

Provider and tool API keys are account-specific. Store them in the encrypted agent config under fields such as `config.provider.<provider>.apiKey` and `config.tools.<tool>.apiKey`.

## Build and Deploy

```bash
bun run check
bun run build
bun run deploy
```

`bun run deploy` runs `bun run build` first, then `sst deploy`.

Deploy outputs include:

- `accountServiceUrl`
- `agentServiceUrl`
- DynamoDB table names
- `filesystemBucketName`

## Account Setup

After deploy, create an account through the account-management Function URL and store the returned `accountSecret`.

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Company A account"
  }'
```

Use that account secret for account self-service calls, direct API calls, async requests, and `/status/{eventId}` polling.

Provider webhooks use the deployed harness-processing URL:

```text
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/telegram
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/github
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/slack
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/discord
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/pancake
```

See [`examples/account.config.example.json`](../examples/account.config.example.json) for a complete agent config shape.

## Live Probes

```bash
export AGENT_SERVICE_URL=<agentServiceUrl>
export ACCOUNT_SERVICE_URL=<accountServiceUrl>
export ACCOUNT_GOOGLE_API_KEY=<googleApiKey>
export ACCOUNT_TAVILY_API_KEY=<tavilyApiKey>
```

```bash
curl "$AGENT_SERVICE_URL"
bun examples/account.ts
bun examples/stream.ts
bun examples/async.ts
```

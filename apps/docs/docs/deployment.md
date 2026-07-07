# Deployment

You have two deployment paths:

1. **Managed service** (recommended) — the platform at `gateway.broods.app` handles all infrastructure. You only run `broods deploy`.
2. **Self-hosted** — deploy the full serverless stack to your own AWS account with SST.

Both paths use the same CLI and SDK workflow.

---

## Managed Service

The fastest path. No infrastructure to manage.

```bash
broods init      # create broods/ project
broods login     # authenticate with the dashboard
broods dev       # sync to development, watch for changes
broods deploy    # sync to production
```

The CLI handles everything: compiling resources, bundling tools, uploading skills, syncing environment variables, and generating typed runtime references. See [Getting Started](getting-started.md) for the full walkthrough.

---

## Self-Hosted

Deploy the full serverless infrastructure to your own AWS account for complete control.

`sst.config.ts` is the source of truth for infra names, tags, region, Lambda resources, DynamoDB tables, S3 bucket, and SST secrets.

### Prerequisites

- [Bun](https://bun.sh/) installed
- An AWS account with CLI access configured
- [SST](https://sst.dev/) (installed by `bun install` as a project dependency; commands use `bunx sst`)

### Local Setup

```bash
bun install
cp apps/core/.env.example apps/core/.env
```

Keep `.env` for local SST inputs only:

- `AWS_PROFILE`
- `SST_STAGE`
- `AWS_ACCOUNT_ID`, `PROJECT_NAME`, `PROJECT_OWNER_EMAIL` (required — no in-source defaults)
- `ENABLE_DIRECT_API` (deploys as `false` unless set to `true`)
- `ENABLE_WEBSOCKET`
- `NATS_URL` (transport by scheme: `wss://` WebSocket / `nats://` core TCP)
- `NATS_TOKEN` (optional; token-auth credential for the NATS server)
- `OPA_BASE_URL` (optional; OPA policy decision endpoint, for example `http://127.0.0.1:8181` for a sidecar or `http://opa.beeblast.svc.cluster.local:8181` for the k3s service)

Runtime secrets are SST secrets:

```bash
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
bunx sst secret set DaytonaApiKey <daytona-api-key>
```

`DaytonaApiKey` has no fallback — `sst deploy` fails without it.

Provider and tool API keys are account-specific. Store them in the encrypted agent config under fields such as `config.provider.<provider>.apiKey` and `config.tools.<tool>.apiKey`.

Agent policies use the Broods structured document shape and are evaluated by OPA at `/v1/data/broods/authz/decision`. The runtime defaults to `http://127.0.0.1:8181` for a colocated sidecar, or uses `OPA_BASE_URL` when an external/shared OPA service is configured. OPA errors fail closed in `enforce` mode and are logged without blocking in `audit` mode.

### Build and Deploy

```bash
bun run check
bun run build
bun run deploy
```

`bun run deploy` runs `bun run build` first, then `sst deploy`.

Deploy outputs include:

- DynamoDB table names (dev/community stages; `undefined` on production, which stores config domains in Convex)
- `filesystemBucketName`, `skillsBucketName`, `toolBundlesBucketName`
- `cronScheduleGroupName`, `cronSchedulerTargetArn`, and `cronSchedulerRoleArn`

### Using the CLI with Self-Hosted

After self-hosted deploy, use the same CLI workflow but point it at your deployment:

```bash
export BROODS_BASE_URL="https://gateway.your-domain.example"
broods init
broods login --dashboard-url https://your-dashboard.example.com
broods dev
broods deploy
```

### Account Setup (Self-Hosted)

Create an account through the gateway with the admin secret:

```bash
curl -X POST "$BROODS_BASE_URL/accounts" \
  -H "Authorization: Bearer $ADMIN_ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "username": "company-a", "description": "Company A account" }'
```

Store the returned `secret` securely.

Provider webhooks use the deployed gateway URL:

```text
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/telegram
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/github
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/slack
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/discord
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/pancake
{BROODS_BASE_URL}/webhooks/{accountId}/{agentId}/zalo
```

Reference the [API Reference](/api-reference) for the complete agent config shape.

## Live Probes

Each demo script reads its environment from its own folder — copy the matching `.env.example` and fill in `BROODS_BASE_URL` plus your model/tool keys.

```bash
curl "$BROODS_BASE_URL"
cd packages/demos/account && bun index.ts
cd packages/demos/stream && bun index.ts
cd packages/demos/async && bun index.ts
```

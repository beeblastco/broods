# Self-hosting

This page covers running Broods on your own AWS account and cluster. Most users should use the managed service at `gateway.broods.app` and never need this; see the [quickstart](../quickstart.md). The CLI and SDK work the same against either.

A deployment has three parts:

- The AWS data plane (S3 buckets, IAM roles, the MicroVM sandbox prerequisites, the mcp-runner Lambda, the sandbox log forwarder), provisioned by SST from `apps/core/sst.config.ts`.
- The Convex backend, `packages/convex`. `packages/convex/schema.ts` is the source of truth for tables.
- The containers: core, the gateway, the dashboard, and the Discord and Matrix forwarders. They run on k8s and are deployed from the infra repo. See [operations](operations.md).

## Prerequisites

- [Bun](https://bun.sh/)
- An AWS account with CLI access
- A Convex deployment, cloud or self-hosted
- A k8s cluster for the containers, plus NATS with JetStream and an OPA endpoint if you want WebSocket streaming and policies
- SST comes with `bun install`. Commands use `bunx sst`.

## Local setup

```bash
bun install
cp apps/core/.env.example apps/core/.env
```

`apps/core/.env` holds inputs for `sst.config.ts` only. Never put deployed runtime secrets in it.

| Variable                      | Required | Notes                                                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `AWS_PROFILE`                 | local    | AWS CLI profile                                                                           |
| `SST_STAGE`                   | yes      | For example `dev`, or `production-eu-west-1`                                              |
| `AWS_REGION`                  | yes      | Core region                                                                               |
| `AWS_ACCOUNT_ID`              | yes      | No in-source default; used for role ARNs and bucket policies                              |
| `PROJECT_NAME`                | yes      | Resource naming prefix                                                                    |
| `PROJECT_OWNER_EMAIL`         | yes      | Resource tags                                                                             |
| `CONVEX_URL`                  | yes      | Convex endpoint                                                                           |
| `CONVEX_DEPLOY_KEY`           | yes      | Convex deploy key, or the self-hosted admin key                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | Collector for logs and traces                                                             |
| `OTEL_EXPORTER_OTLP_HEADERS`  | no       | `Authorization=Basic ...`. Also enables the sandbox log forwarder for the stage           |
| `MCP_TENANT_ISOLATION`        | no       | `true` runs the mcp-runner Lambda in tenant isolation mode. AWS must enable tenancy first |

Runtime secrets are not SST secrets. They are container env, carried by the k8s release files in the infra repo and by the Convex deployment env.

## Deploy the data plane

```bash
cd apps/core
bun run check
bun run deploy   # bun run build, then sst deploy
```

Outputs include `filesystemBucketName`, `skillsBucketName` and `toolBundlesBucketName`, plus the MicroVM artifact bucket and roles. Production stages set `removal: "retain"` and `protect: true`.

Add every new stage to the matrix in `.github/workflows/drift-cleanup.yaml`, or the nightly reconcile never sees it. See [CI/CD](ci-cd.md#drift-cleanup).

## Core container env

Core reads its configuration from the container environment.

| Variable                                                                                       | Notes                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONVEX_URL`, `CONVEX_DEPLOY_KEY`                                                              | Required                                                                                                                                      |
| `ACCOUNT_CONFIG_ENCRYPTION_SECRET`                                                             | Required. Encrypts agent and sandbox config. Must match the value existing data was encrypted with; changing it makes that data undecryptable |
| `ADMIN_ACCOUNT_SECRET`                                                                         | Authenticates `POST /v1/accounts`                                                                                                             |
| `SERVICE_AUTH_SECRET`, `STAGE_TICKET_SECRET`, `TERMINAL_TICKET_SECRET`, `MEDIA_TICKET_SECRET`  | Required. See [service secrets](operations.md#service-secrets)                                                                                |
| `PUBLIC_BASE_URL`                                                                              | Public gateway URL. Background jobs call back to it                                                                                           |
| `FILESYSTEM_BUCKET_NAME`, `SKILLS_BUCKET_NAME`                                                 | From the SST outputs                                                                                                                          |
| `SANDBOX_MOUNT_ROLE_ARN`                                                                       | Role assumed for prefix-scoped mount credentials                                                                                              |
| `MICROVM_EXECUTION_ROLE_ARN`, `MICROVM_LOG_GROUP_NAME`, `MICROVM_EGRESS_NETWORK_CONNECTOR_ARN` | `lambda` provider. Without the connector, `deny-all` MicroVMs fail to launch                                                                  |
| `WORKDIR_URL`, `WORKDIR_API_KEY`                                                               | `sandbox` provider                                                                                                                            |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_ORGANIZATION_ID`, `DAYTONA_TARGET`              | Fallbacks for `daytona` configs that omit them                                                                                                |
| `E2B_API_KEY`; `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                           | Fallbacks for `e2b` and `vercel` configs                                                                                                      |
| `ENABLE_DIRECT_API`                                                                            | Default `true`. `false` makes `POST /v1/runs` answer `404`                                                                                    |
| `ENABLE_WEBSOCKET`, `NATS_URL`, `NATS_TOKEN`                                                   | WebSocket streaming. `NATS_URL` scheme picks the transport: `wss://` or `ws://` out of cluster, `nats://` or `tls://` in cluster              |
| `OPA_BASE_URL`, `OPA_API_TOKEN`                                                                | Policy decisions. Defaults to `http://127.0.0.1:8181` for a sidecar                                                                           |
| `MAX_INPROCESS_WORKERS`, `REQUEST_TIMEOUT_BUDGET_MS`                                           | In-process async worker cap; invocation deadline, default 10 minutes                                                                          |
| `MCP_BATCH_WINDOW_MS`, `MCP_BATCH_MAX`, `MCP_TENANT_ISOLATION`                                 | Hosted MCP batching (10 ms, 8) and tenant isolation                                                                                           |
| `ALLOW_PRIVATE_STORAGE_ENDPOINTS`                                                              | `true` (on core and Convex) allows private BYO-bucket endpoints such as MinIO on the cluster network                                          |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`                                    | Logs and traces                                                                                                                               |

Model provider and tool API keys are per account, never deployment-wide. Accounts set them in agent config (`provider.<name>.apiKey`) or as env vars referenced with `env("NAME")`.

## Policies

Agent policies are evaluated by OPA at `/v1/data/broods/authz/decision`. When an agent has no policies attached, no decision is requested. When it has some, core posts the action, resource context and sanitized tool-call details (`toolName`, `mcpId`, `tool.input.*`). Each policy carries its own `mode`: `audit`, the default, records decisions without blocking; `enforce` lets its deny rules refuse, switches the places it is attached to over to default-deny, and fails closed when OPA is unreachable. Policies with different modes can be attached to the same place.

Hosted stages use `https://opa.beeblast.co` with a bearer token. `http://127.0.0.1:8181` only works against a local or sidecar OPA.

## Point the CLI at your deployment

```bash
export BROODS_BASE_URL="https://gateway.your-domain.example"
broods login --dashboard-url https://dashboard.your-domain.example
broods dev
broods deploy
```

`broods login` records the base URL in `.env.local`, so later commands, `broods run` and SDK clients in the project reach the same deployment. A runtime key only works on the deployment that issued it; pointing a client elsewhere fails with `401`.

## Create an account

The dashboard creates accounts through Convex against a WorkOS organization. For tests or a headless setup, create one directly with the admin secret:

```bash
curl -X POST "$BROODS_BASE_URL/v1/accounts" \
  -H "Authorization: Bearer $ADMIN_ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "username": "company-a", "description": "Company A account" }'
```

The response holds the account `secret` once. It creates a standalone Convex account with an admin-owned synthetic org id.

## Webhook URLs

Production stages take the bare form. Any other stage uses its endpoint id, which `broods dev` prints after a sync:

```text
{BROODS_BASE_URL}/v1/webhooks/{accountId}/{channel}
{BROODS_BASE_URL}/v1/webhooks/{accountId}/dev/{endpointId}/{channel}
```

The difference matters when two stages share a provider app. The bare URL picks a receiving agent from whichever credentials verify, so a second stage holding the same bot token competes for the same traffic. The stage URL is delivered only to the stage it names.

Discord regular messages and all Matrix traffic also need the forwarders running. See [operations](operations.md).

## Smoke test

```bash
curl "$BROODS_BASE_URL"
# {"status":"ok","method":"POST"}
```

Then run a demo. Each reads its env from its own folder:

```bash
cd packages/demos/basic-stream && bun index.ts
cd packages/demos/basic-async && bun index.ts
```

## Historical note: Convex-only storage cutover

Issue #32 removed the legacy DynamoDB tables and adapters. The Convex runtime tables started empty; DynamoDB-only conversation and operational rows were not copied. `usageTasks` was replaced by `taskUsage` without migrating rows, and deprecated tool and hook identifiers stopped being accepted. A deployment still on the old tables should review retention and export needs before applying the infrastructure diff, then recreate affected accounts or resources.

# Self-hosting

How to run Broods on your own AWS account and cluster, in the order the pieces depend on each other. Most users should use the managed service at `gateway.broods.app` instead. See the [quickstart](../quickstart.md). The CLI and SDK work the same against either.

To try the stack on one machine first, skip to [Run it locally](#run-it-locally).

## What you deploy

```mermaid
flowchart LR
  Client((Client, CLI,<br/>chat providers)) --> Traefik
  Traefik -->|runtime paths| Core[core]
  Traefik -->|config paths| Site["Convex HTTP actions<br/>*.convex.site"]
  Traefik -->|WebSockets| Gateway[gateway]
  Gateway --> Core
  Dashboard[dashboard] --> Convex[(Convex)]
  Site --- Convex
  Core --> Convex
  Core --> AWS[("AWS data plane<br/>S3, IAM, MicroVM, tool-runner")]
  Core --> NATS[(NATS JetStream)]
  Core --> OPA[OPA]
  Gateway --> NATS
  DFwd[discord-forwarder] --> Traefik
  MFwd[matrix-forwarder] --> Traefik
  Core -->|Matrix sends| MFwd
  Convex -->|cron trigger, in-cluster| Core
```

| Piece                       | Source                                           | Runs as                                                           |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| AWS data plane              | `apps/core/sst.config.ts`                        | SST deploy into your AWS account                                  |
| Convex backend              | `packages/convex`                                | Convex Cloud, or the self-hosted `convex-backend` image           |
| core                        | `apps/core/Dockerfile`                           | Container, port 3000, cluster-internal only                       |
| Traefik                     | upstream, routes from `apps/edge`                | The only public door                                              |
| gateway                     | `apps/gateway/Dockerfile`                        | Container, port 3000, WebSockets behind Traefik                   |
| dashboard                   | `apps/dashboard/Dockerfile`                      | Container, port 3000                                              |
| discord-forwarder           | `apps/discord-forwarder/Dockerfile`              | Container, one replica. Only for Discord agents                   |
| matrix-forwarder            | `apps/matrix-forwarder/Dockerfile`               | Container, one replica, persistent volume. Only for Matrix agents |
| NATS with JetStream         | upstream                                         | Needed for WebSocket runs and live logs                           |
| OPA                         | upstream, with `apps/core/opa/broods_authz.rego` | Needed for agent policies                                         |
| OTel collector, Loki, Tempo | upstream                                         | Optional. Log and trace history                                   |

The managed service runs all of this on k3s. Its release files are in the infra repo under `kubernetes/charts/releases/`. They are `core.yaml`, `gateway.yaml`, `dashboard.yaml`, `convex-prod.yaml`, `nats.yaml`, `opa.yaml`, `loki.yaml`, `tempo.yaml`, the two forwarders, and `-dev` variants. Images are published to `ghcr.io/beeblastco/broods-{core,gateway,dashboard,discord-forwarder,matrix-forwarder}`, or build them from the Dockerfiles at the repo root with `docker build -f apps/core/Dockerfile .`.

## Prerequisites

- Bun at the version in `.bun-version`, 1.4.2 or newer.
- An AWS account and credentials that can create S3, IAM, Lambda and CloudWatch resources.
- A Kubernetes cluster, or any container host, for the five images.
- A Convex deployment, on Convex Cloud or self-hosted.
- Nothing for sign-in. A self-hosted dashboard signs the admin in with `ADMIN_ACCOUNT_SECRET`, like the Convex self-hosted dashboard's admin key. No identity provider, and nothing on the internet.

## 1. Deploy the AWS data plane

```bash
bun install --ignore-scripts
cp apps/core/.env.example apps/core/.env   # fill it in
cd apps/core
bun run deploy                             # scripts/build.ts, then sst deploy
```

`sst.config.ts` reads only these inputs. Runtime secrets are not SST secrets.

| Variable                      | Required | Notes                                                                                                                                                                                                                 |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`              | yes      | Role ARNs, bucket policies, resource names. No default                                                                                                                                                                |
| `PROJECT_NAME`                | yes      | Name prefix: `<stage>-<project>-<service>-<account>-<region>`; production stages drop the stage                                                                                                                       |
| `PROJECT_OWNER_EMAIL`         | yes      | Resource tags                                                                                                                                                                                                         |
| `AWS_REGION`                  | CI only  | Defaults to `eu-west-1` locally; required when `CI` is set                                                                                                                                                            |
| `AWS_PROFILE`                 | local    | Ignored when `CI` is set                                                                                                                                                                                              |
| `SST_STAGE`                   | yes      | `dev`, `production-eu-west-1`, ... `production` and `production-*` are treated as production                                                                                                                          |
| `CONVEX_URL`                  | yes      | The deploy fails without it                                                                                                                                                                                           |
| `CONVEX_DEPLOY_KEY`           | yes      | Deploy key, or the self-hosted admin key                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | Collector for the sandbox log forwarder. Default `https://otel.beeblast.co`, so set it                                                                                                                                |
| `OTEL_EXPORTER_OTLP_HEADERS`  | no       | `Authorization=Basic ...`. Unset skips the sandbox log forwarder, MicroVM logs stay in CloudWatch                                                                                                                     |
| `MCP_TENANT_ISOLATION`        | no       | Default off: the `tool-runner` Lambda shares environments across accounts. `true` creates `mcp-runner` in per-tenant mode. AWS must enable tenancy for the AWS account first, and the mode cannot change after create |
| `SANDBOX_IMAGE_READY`         | no       | `true` imports the existing sandbox ECR repo instead of creating it                                                                                                                                                   |

Stack outputs, which the containers and Convex need:

| Output                                                                                                             | Feeds                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `filesystemBucketName`                                                                                             | core and Convex `FILESYSTEM_BUCKET_NAME`                                    |
| `skillsBucketName`                                                                                                 | core and Convex `SKILLS_BUCKET_NAME`                                        |
| `toolBundlesBucketName`                                                                                            | core and Convex `TOOL_BUNDLES_BUCKET_NAME`                                  |
| `toolRunnerFunctionName`                                                                                           | core `TOOL_RUNNER_FUNCTION_NAME`                                            |
| `microvmArtifactsBucketName`, `microvmBuildRoleArn`, `microvmExecutionRoleArn`, `microvmEgressNetworkConnectorArn` | core `MICROVM_*`                                                            |
| `coreRuntimeUserName`                                                                                              | mint an access key for core: `aws iam create-access-key --user-name <name>` |
| `convexAwsRoleArn`                                                                                                 | Convex `CONVEX_AWS_ROLE_ARN`                                                |
| `convexBootstrapUserName`                                                                                          | mint the Convex `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`               |

Two values are not outputs but follow fixed names. `SANDBOX_MOUNT_ROLE_ARN` is the role `<stage>-<project>-sandbox-s3mount-<account>-<region>`, without `<stage>-` on production, and `MICROVM_LOG_GROUP_NAME` is `/broods/<stage>/microvms`.

Production stages keep their buckets on removal and protect them. Add every long-lived stage to the matrix in `.github/workflows/drift-cleanup.yaml`, or the nightly reconcile never sees it. See [CI/CD](ci-cd.md).

## 2. Configure and deploy Convex

Set the deployment env with `bunx convex env set NAME value` from `packages/convex`:

| Variable                                                                   | Required  | Notes                                                                                                                                              |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_CONFIG_ENCRYPTION_SECRET`                                         | yes       | Same value as core. Wraps each account's data key; comma-separated list                                                                            |
| `ADMIN_ACCOUNT_SECRET`                                                     | yes       | Same value as core. Admin bearer for the account admin routes                                                                                      |
| `SERVICE_AUTH_SECRET`                                                      | yes       | Same value as core. Cron trigger and service calls                                                                                                 |
| `STAGE_TICKET_SECRET`                                                      | yes       | Same value as core. Signs `bdts_` tickets                                                                                                          |
| `BROODS_ACCOUNT_MANAGE_URL`                                                | yes       | Core's in-cluster URL, for example `http://core.<ns>.svc.cluster.local`. Never the public gateway: core refuses the service token there            |
| `AWS_REGION`                                                               | yes       | The data plane region                                                                                                                              |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                               | yes       | The bootstrap user's key. It can only assume `ConvexAwsRole`                                                                                       |
| `CONVEX_AWS_ROLE_ARN`                                                      | yes       | `convexAwsRoleArn` output                                                                                                                          |
| `CONVEX_AWS_EXTERNAL_ID`                                                   | no        | Default `broods-convex`                                                                                                                            |
| `FILESYSTEM_BUCKET_NAME`, `SKILLS_BUCKET_NAME`, `TOOL_BUNDLES_BUCKET_NAME` | yes       | Stack outputs                                                                                                                                      |
| `MICROVM_ARTIFACTS_BUCKET_NAME`                                            | no        | Also refuses that bucket as a workspace's own storage                                                                                              |
| `ALLOW_PRIVATE_STORAGE_ENDPOINTS`                                          | no        | `true` accepts a private workspace `storage.endpoint`, such as MinIO. Set the same on core                                                         |
| `BROODS_SESSION_JWKS`                                                      | dashboard | `{"keys":[...]}` holding the public half of `BROODS_SESSION_SIGNING_KEY`. Convex then trusts the dashboard's admin session and needs no `WORKOS_*` |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET`              | no        | The managed service's WorkOS AuthKit login. Leave unset when self-hosting                                                                          |
| `DASHBOARD_ORIGIN`                                                         | billing   | Allowed origin for Stripe return URLs. Falls back to the origin of `NEXT_PUBLIC_WORKOS_REDIRECT_URI`                                               |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`        | no        | Billing. Leave unset without it                                                                                                                    |
| `STRIPE_PRO_PAYMENT_LINK`                                                  | no        | Stripe Payment Link that Upgrade opens, so Stripe owns the price and trial. Unset falls back to a Checkout Session for `STRIPE_PRO_PRICE_ID`       |

Then deploy the functions:

```bash
cd packages/convex
CONVEX_DEPLOY_KEY=... bun run deploy
# self-hosted backend instead:
CONVEX_SELF_HOSTED_URL=https://convex.example.com CONVEX_SELF_HOSTED_ADMIN_KEY=... bun run deploy
```

Deploy Convex before core. Core calls functions that must already exist. CI enforces the same order.

## 3. Shared services

- NATS with JetStream, for WebSocket runs and the live log and trace stream. Core creates its streams (`WS_RESPONSES`, `OBSERVABILITY`) on first use. `nats://` or `tls://` is core TCP for in-cluster clients, `wss://` or `ws://` for clients outside.
- OPA, loaded with `apps/core/opa/broods_authz.rego`. Core posts to `/v1/data/broods/authz/decision`. Only agents with policies attached call it. `opa-policy-check.yaml` shows how to check a deployed OPA serves the same rego.
- An OTel collector with Loki and Tempo, optional. Core exports to `OTEL_EXPORTER_OTLP_ENDPOINT`; the gateway reads history from `LOKI_URL` and `TEMPO_URL`. Without them the dashboard shows only the live window NATS keeps.

## 4. Run the containers

Every image listens on port 3000 and answers `GET /healthz`.

### core

Refuses to start without the four service secrets. Keep it cluster-internal; Traefik is the only public door.

| Variable                                                                                                                                                | Required               | Notes                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `CONVEX_URL`, `CONVEX_DEPLOY_KEY`                                                                                                                       | yes                    | Deploy key or self-hosted admin key                                                                  |
| `ACCOUNT_CONFIG_ENCRYPTION_SECRET`                                                                                                                      | yes                    | Same value as Convex. Comma-separated list; rotate it as [operations](operations.md) describes       |
| `SERVICE_AUTH_SECRET`, `STAGE_TICKET_SECRET`                                                                                                            | yes                    | Same values as Convex                                                                                |
| `TERMINAL_TICKET_SECRET`, `MEDIA_TICKET_SECRET`                                                                                                         | yes                    | Comma-separated lists. See [operations](operations.md)                                               |
| `ADMIN_ACCOUNT_SECRET`                                                                                                                                  | no                     | Enables `POST /v1/accounts`                                                                          |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                                                                                              | yes                    | The core runtime user's key                                                                          |
| `FILESYSTEM_BUCKET_NAME`, `SKILLS_BUCKET_NAME`, `TOOL_BUNDLES_BUCKET_NAME`, `TOOL_RUNNER_FUNCTION_NAME`                                                 | yes                    | Stack outputs                                                                                        |
| `PUBLIC_BASE_URL`                                                                                                                                       | yes                    | The public gateway URL. Sandbox job callbacks and status URLs use it                                 |
| `SANDBOX_MOUNT_ROLE_ARN`                                                                                                                                | for mounts             | Role assumed for prefix-scoped workspace mount credentials                                           |
| `MICROVM_IMAGE_IDENTIFIER`, `MICROVM_EXECUTION_ROLE_ARN`, `MICROVM_LOG_GROUP_NAME`, `MICROVM_EGRESS_NETWORK_CONNECTOR_ARN`                              | for `lambda` sandboxes | Without the connector, `deny-all` MicroVMs fail to launch                                            |
| `WORKDIR_URL`, `WORKDIR_API_KEY`                                                                                                                        | for `sandbox`          | The workdir control plane                                                                            |
| `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_API_KEY`                                                                                                  | for `cloudflare`       | The `apps/cloudflare-sandbox` bridge Worker and its `SANDBOX_API_KEY` secret                         |
| `CLOUDFLARE_MCP_URL`, `CLOUDFLARE_MCP_API_KEY`                                                                                                          | for Cloudflare MCP     | The [Dynamic Workers runtime](../guides/cloudflare-mcp.md) for hosted MCP. Unset keeps all on Lambda |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_ORGANIZATION_ID`, `DAYTONA_TARGET`; `E2B_API_KEY`; `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | no                     | Fallbacks for sandbox configs that omit their own                                                    |
| `ENABLE_WEBSOCKET`, `NATS_URL`, `NATS_TOKEN`                                                                                                            | for WebSocket          | `ENABLE_WEBSOCKET=true` needs `NATS_URL`                                                             |
| `OPA_BASE_URL`, `OPA_API_TOKEN`                                                                                                                         | for policies           | Default `http://127.0.0.1:8181`                                                                      |
| `MATRIX_FORWARDER_URL`                                                                                                                                  | for Matrix             | In-cluster URL of the matrix-forwarder                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVICE_NAME`, `DEPLOYMENT_ENVIRONMENT`                                                   | no                     | Logs and traces. No endpoint means no export                                                         |
| `ENABLE_DIRECT_API`                                                                                                                                     | no                     | Default `true`. `false` turns `POST /v1/runs` off                                                    |
| `ALLOW_PRIVATE_STORAGE_ENDPOINTS`                                                                                                                       | no                     | Same as on Convex                                                                                    |
| `BROODS_CONTAINER_RUNTIME`                                                                                                                              | no                     | `1` in a deployed pod, enables isolate prewarm. Leave unset locally                                  |

The tuning knobs and their defaults are `REQUEST_TIMEOUT_BUDGET_MS` 600000, `WORKER_TIMEOUT_BUDGET_MS` 600000, `MAX_INPROCESS_WORKERS` 8, `MODEL_FIRST_CHUNK_TIMEOUT_MS` 300000, `MODEL_CHUNK_TIMEOUT_MS` 300000, `SHUTDOWN_DEADLINE_MS` 25000, `MCP_BATCH_WINDOW_MS` 10, `MCP_BATCH_MAX` 8, `ISOLATE_POOL`, `ISOLATE_WORKER_POOL_SIZE` 4, `ISOLATE_MEMORY_LIMIT_MB`, `ISOLATE_RUNNER_TIMEOUT_SECONDS`, `SANDBOX_SWEEP_INTERVAL_SECONDS`, and the `WORKSPACE_SANDBOX_*` limits in `apps/core/src/shared/sandbox.ts`.

Model and tool API keys are never deployment-wide. Accounts set them in agent config or as stage env vars.

### Traefik

Traefik routes each request on the public host to core, the config plane or the gateway, and sets CORS. Generate its file-provider config from the route table, with each upstream's base URL, then the hostnames your dashboard is served from (`*.` for subdomains; the default is the broods.app ones and localhost):

```bash
bun run --filter @broods/edge generate file \
  http://core:3000 https://your-deployment.convex.site http://gateway:3000 \
  agents.example.com localhost > edge.yaml
```

Set the same hostnames in the gateway's `GATEWAY_ALLOWED_ORIGINS`, which guards WebSocket upgrades.

Load it with `--providers.file.filename=edge.yaml` on an entry point named `web`, and put TLS in front. Regenerate it when you upgrade Broods: a new route that is missing lands on the wrong plane. This file has no per-address rate limits, since a self-hosted install mostly serves its owner. The managed service's limits are the `rateLimit` middlewares in `apps/edge/src/traefik.ts` if you want them.

### gateway

The gateway serves only health checks and the four WebSockets.

| Variable                                                                                                                                             | Required               | Notes                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `BROODS_CORE_URL`                                                                                                                                    | yes                    | Core's URL, for socket token checks, agent runs and the machine relay                                         |
| `TERMINAL_TICKET_SECRET`                                                                                                                             | yes                    | Same list as core                                                                                             |
| `NATS_URL`, `NATS_TOKEN`                                                                                                                             | for WebSocket and logs | Connected on first use                                                                                        |
| `LOKI_URL`, `TEMPO_URL`                                                                                                                              | no                     | Log and trace history for the dashboard and `broods logs`                                                     |
| `GATEWAY_ALLOWED_ORIGINS`                                                                                                                            | no                     | WebSocket origin allow list. Default `broods.app`, `*.broods.app`, `localhost`, `127.0.0.1`. Set your domains |
| `GATEWAY_MAX_CONNECTIONS`, `GATEWAY_MAX_PAYLOAD_BYTES`, `GATEWAY_BACKPRESSURE_BYTES`, `GATEWAY_IDLE_TIMEOUT_SECONDS`, `GATEWAY_RUN_START_TIMEOUT_MS` | no                     | Per-pod limits. See `apps/gateway/.env.example`                                                               |
| `GATEWAY_AUTH_FAILURES_PER_MINUTE`                                                                                                                   | no                     | Failed socket logins per client address. Default 20                                                           |

The gateway is stateless. Scale it with replicas.

### dashboard

The build-time values are `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_BROODS_BASE_URL`, the public gateway, and `NEXT_PUBLIC_WORKOS_REDIRECT_URI`, whose origin is the dashboard's own (`https://dashboard.example.com/auth/callback`). The runtime values are `ADMIN_ACCOUNT_SECRET`, the key the admin signs in with, `BROODS_SESSION_SIGNING_KEY`, a private ES256 JWK that signs the session, and `CONVEX_SITE_URL`, since a self-hosted Convex has no derivable `.convex.site` host. Make the key pair once:

```bash
bun -e 'const { privateKey } = require("node:crypto").generateKeyPairSync("ec", { namedCurve: "P-256" }); const jwk = { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "broods-self-host", use: "sig" }; const { d, ...pub } = jwk; console.log("BROODS_SESSION_SIGNING_KEY=" + JSON.stringify(jwk)); console.log("BROODS_SESSION_JWKS=" + JSON.stringify({ keys: [pub] }))'
```

The first line goes to the dashboard, the second to Convex. See `apps/dashboard/.env.example`.

### Forwarders

Run these only for Discord or Matrix agents. Each is one release for every Convex deployment you run, never one per stage. See [operations](operations.md#forwarders) for why.

| Variable                     | Forwarder | Notes                                                                                                      |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `BROODS_CONFIG_PLANES`       | both      | JSON array of `{ "name", "convexUrl", "webhookBaseUrl" }`. `webhookBaseUrl` is that plane's public gateway |
| `CONVEX_DEPLOY_KEY_<NAME>`   | both      | One key per plane, named after it upper-cased: plane `dev` reads `CONVEX_DEPLOY_KEY_DEV`                   |
| `DISCORD_BACKOFF_CEILING_MS` | discord   | Default 300000                                                                                             |
| `DISCORD_IDENTIFY_LIMIT`     | discord   | Default 500, half of Discord's 1000 per 24 hours                                                           |
| `MATRIX_STORE_DIR`           | matrix    | Required. Must be a persistent volume                                                                      |

Run each with one replica and `strategy: Recreate`.

### Cloudflare MCP runtime (optional)

Runs [hosted MCP servers on Cloudflare Workers](../guides/cloudflare-mcp.md). The runtime is `apps/cloudflare-mcp`, a Worker with a `LOADER` [Worker Loader](https://developers.cloudflare.com/dynamic-workers/) binding. Dynamic Workers needs a Workers Paid plan.

1. Create the R2 bucket `broods-mcp-bundles` (the `BUNDLES` binding), ideally with a 30-day expiry rule.
2. Set the Worker secret `MCP_API_KEY` and the var `BUNDLE_ORIGIN`: the exact `https://` origin of your tool-bundles S3 bucket's presigned URLs.
3. Deploy the Worker with Wrangler.
4. Set core's `CLOUDFLARE_MCP_URL` to `https://<worker-host>/mcp` and `CLOUDFLARE_MCP_API_KEY` to the same secret.

Until `CLOUDFLARE_MCP_URL` is set, every server runs on Lambda.

## 5. Create an account

With the dashboard, sign in with the admin key and the account is provisioned for your organization. Without it, create one with the admin secret:

```bash
curl -X POST "$BROODS_BASE_URL/v1/accounts" \
  -H "Authorization: Bearer $ADMIN_ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "username": "company-a", "description": "Company A account" }'
```

The response holds the account `secret` once. That account belongs to an admin-owned synthetic org, not a WorkOS organization, so it has no dashboard login. Drive it with the account API or `BroodsAccountClient`.

## 6. Point the CLI at it

The CLI logs in through the dashboard, which hands it the API base URL in the login callback:

```bash
broods login --dashboard-url https://dashboard.example.com
broods dev
```

`login` records `BROODS_BASE_URL` in `.env.local`, so `broods run`, `broods logs` and SDK clients in the project reach the same deployment. A runtime key only works on the deployment that issued it; pointing a client elsewhere answers `401`. In CI, set `BROODS_TOKEN` to a project key and `BROODS_BASE_URL` instead.

## Webhook URLs

Production stages take the bare form. Other stages use their endpoint id, which `broods dev` prints after a sync:

```text
{BROODS_BASE_URL}/v1/webhooks/{accountId}/{channel}
{BROODS_BASE_URL}/v1/webhooks/{accountId}/dev/{endpointId}/{channel}
```

The bare URL picks a receiving agent from whichever credentials verify. A second stage holding the same bot token competes for the same traffic. The stage URL reaches only the stage it names.

## Smoke test

```bash
curl https://gateway.example.com/healthz
# {"status":"ok","activeWebSockets":0,"maxWebSockets":10000}
```

Then run a demo against it. Build the SDK once, then from the demo folder:

```bash
bun run --filter broods build
cd packages/demos/basic-stream
echo 'BROODS_BASE_URL=https://gateway.example.com' >> .env.local
bun install && bun run dev && bun run start
```

`basic-async` does the same with `background: true` and polling. `packages/demos/README.md` lists the rest.

## Run it locally

`bun run local:up` starts a self-hosted Convex and Traefik in Docker plus core and gateway as watched Bun processes, with generated secrets. State, ports and logs live under `~/.broods-local/<instance>/`, keyed by worktree, so parallel checkouts get separate stacks.

```bash
bun run local:up        # --fresh wipes the instance first
bun run local:verify    # admin-creates an account and agent, runs it through Traefik, polls the run
bun run local:status
bun run local:down      # --purge deletes the instance state
```

`verify` passes without a model key. The run fails at the provider call, which still proves routing, auth, config encryption and the Convex round trips. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for a full run. The local stack has no AWS data plane or NATS, so it covers the config plane and runs without sandboxes or WebSocket.

`bun run local:up -- --dashboard` also serves the dashboard on the stack, self-hosted: no WorkOS and nothing on the internet. Each stack serves it on its own port, which `up` prints. Sign in with the admin key `bun run local:status -- --key` prints. The signed-in browser suites run the same way, with no account to set up:

```bash
cd apps/dashboard
E2E_ADMIN_KEY=$(bun ../../scripts/local-stack.ts status --key) E2E_BASE_URL=<dashboard URL> bun run test:app
```

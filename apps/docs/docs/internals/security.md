# Security

This page covers what Broods stores, how secrets are protected, and how untrusted code is contained. Who can do what in the dashboard and CLI is in the user-facing [security guide](../guides/security.md). This is an early product, and the model is simple on purpose. It keeps provider secrets out of plaintext Convex rows, but it is not a final production-grade secrets system.

## What is stored

```mermaid
flowchart TD
  Account["account"] --> Meta["plain metadata<br/>accountId, username, status"]
  Account --> Hash["secretHash"]
  Account --> Agent["agents"]
  Agent --> Config["encrypted config blob<br/>model, tools, sandboxes, subagents,<br/>channel credentials"]
  Account --> Env["encrypted env vars<br/>+ SHA-256 digest"]
  Account --> S3["S3 objects<br/>workspaces, skills, bundles"]
```

- The account key is never stored. It is returned once on create or rotation; only `secretHash` is kept.
- Provider credentials must be usable at runtime, so they cannot be hashed. They live inside encrypted agent config or encrypted env vars.
- Env vars store a SHA-256 digest beside the encrypted value, so `broods env sync` and `broods diff` can compare local and remote values without revealing either.
- Sandbox config, including `envVars`, is encrypted at rest.
- The workspace, skills, tool-bundles and MicroVM artifact buckets block public access. `denyUnlessProjectPrincipal()` in `apps/core/sst.config.ts` denies `s3:*` to every principal except the stage's `sandbox-s3mount`, `microvm-build` and `microvm-execution` roles, the `core-runtime` IAM user the core pods use, the `convex-aws` role the config plane assumes, the GitHub Actions deploy roles, and the account root.

## Config encryption

```mermaid
sequenceDiagram
  participant API as config plane
  participant Crypto as AES-256-GCM
  participant CVX as Convex
  participant Core as core

  API->>Crypto: encrypt with ACCOUNT_CONFIG_ENCRYPTION_SECRET
  Crypto->>CVX: ciphertext + iv + auth tag
  Core->>CVX: load the selected agent
  Core->>Crypto: decrypt
  Core->>Core: verify webhooks, call providers
```

- AES-256-GCM encrypts config before the Convex write. The key is the SHA-256 of `ACCOUNT_CONFIG_ENCRYPTION_SECRET` (`src/shared/domain/agent-config.ts`); the config plane writes the same blob with Web Crypto.
- `ACCOUNT_CONFIG_ENCRYPTION_SECRET` is plain runtime env on core and on the Convex deployment, and both must hold the same value. Rotating it needs a re-encryption migration.
- Core decrypts only when it needs a selected agent's runtime settings.

Reads recursively redact secret-like field names such as `token`, `secret`, `privateKey` and `apiKey` as `********`, including inside tool config. Sending `********` back in a patch keeps the stored value.

Logs go through one redaction chokepoint. See [observability](observability.md#security).

## Credentials

| Prefix     | Credential           | Scope                                                                                          |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `ask_`     | Account key          | Whole tenant                                                                                   |
| `fp_cli_`  | CLI login token      | An org owner or admin. Re-checked against current membership on every request                  |
| `sk_`      | Runtime key          | One account, project, stage and endpoint. Encrypted at rest and recoverable by the owning user |
| `pdk_`     | Project key          | One project and stage                                                                          |
| `fp_role_` | Role                 | Never used directly. Exchanged for a session                                                   |
| `fp_sts_`  | Role session         | The role's policy. Default TTL 1 hour, max 12. Only the hash is stored                         |
| `fp_dts_`  | Stage session ticket | Fifteen minutes, signed by Convex with `STAGE_TICKET_SECRET`                                   |

Core resolves a bearer in a fixed order in `resolveBearerAuth()` (`apps/core/src/shared/auth.ts`). `fp_sts_` and `fp_dts_` are routed by prefix and resolve as that kind or not at all. The admin secret and service token are compared next. An `ask_` or `sk_` token then goes straight to its one hash lookup, and any other token takes both lookups below, which is how a key minted under an earlier prefix keeps working until it is rotated:

```mermaid
flowchart TD
  Bearer["Authorization: Bearer token"] --> Sts{"fp_sts_ prefix?"}
  Sts -->|yes| Role["roleSessions hash lookup<br/>kind: role"]
  Sts -->|no| Dts{"fp_dts_ prefix?"}
  Dts -->|yes| Ticket["open with STAGE_TICKET_SECRET<br/>kind: deployment, stageTicket"]
  Dts -->|no| Admin{"equals ADMIN_ACCOUNT_SECRET?"}
  Admin -->|yes| AdminCtx["kind: admin"]
  Admin -->|no| Svc{"equals SERVICE_AUTH_SECRET<br/>and no x-broods-via-gateway?"}
  Svc -->|yes| SvcCtx["account from X-Account-Id<br/>kind: account, viaServiceToken"]
  Svc -->|no| Key{"sha256 in agentDeployments?"}
  Key -->|yes| Deploy["runtime key<br/>kind: deployment"]
  Key -->|no| Acct{"secretHash in accounts?"}
  Acct -->|yes| AcctCtx["kind: account"]
  Acct -->|no| Deny["null, 401"]
```

Every branch that names an account also requires it to be `active`, except the account key on `DELETE /v1/account`, which accepts a disabled account so the owner can retry a deletion. `fp_cli_` and `pdk_` never reach core; the Convex config plane checks them in `packages/convex/cli/http.ts`, and `fp_cli_` also in `config/routes/roles.ts`.

Rules the code enforces:

- The runtime key is meant to sit in a frontend, so it is limited further. It reaches only agents of its own stage, and another stage's `agentId` answers `404`. It needs `publicAccess: true` on the agent. It cannot send `system` or `model` overrides unless the agent sets `allowRunOverrides: true`, and gets `403 run_overrides_disabled` otherwise. With `continue: true` it re-enters only conversations the direct API opened, never a channel session. It cannot open the observability socket, because logs and traces carry every end user's chats and tool payloads.
- A member's stage ticket (`fp_dts_`) is the dashboard's credential. It reaches every agent of its stage, `publicAccess` or not, and its `continue: true` re-enters channel sessions too, so Continue on a failed Telegram task answers back in Telegram.
- A project key syncs its own stage only. Skills and hooks are account-wide by name, so a project key whose manifest names one that another stage manages is refused instead of replacing it. The account key and a login token may move a name between stages. `--prune` leaves other stages' rows alone and fails when an agent or channel record still lists a policy it would remove.
- A project key can set and list env vars but never read a value back. `broods env get` needs a login token or the account key, and every reveal is recorded in `environmentVariableReveals`.
- `broods login` binds the one-time code to the CLI process with S256 PKCE, so a code caught by another local listener cannot be exchanged.
- Sessions cannot mint new sessions, rotate the account key, or touch `/v1/roles`. A runtime key may assume only roles pinned to its own project and stage. `status: "disabled"` on a role kills every live session.
- Webhook signing secrets and env var values are write-only in the dashboard.

## Hosted MCP servers

Account-uploaded MCP bundles are untrusted code and never run in the core process. They run on the tool-runner Lambda, a plain Node.js function outside a VPC, so egress is open internet.

The call path from core through the Lambda to the child is drawn in [tools and MCP](tools-and-mcp.md#hosted-servers).

- Today the function is `tool-runner`, and accounts share warm execution environments. The separation is the child process, plus a sweep before each spawn that kills any process of the function's user left behind by an earlier bundle.
- `MCP_TENANT_ISOLATION=true`, on both the SST deploy and core, creates the function as `mcp-runner` with `tenancyConfig: { tenantIsolationMode: "PER_TENANT" }`. Every invoke then carries the account id as its tenant id, and Lambda never reuses an execution environment across accounts. It is off because AWS rejects tenancy config for this AWS account; turn it on once AWS enables it.

- Inside an environment, each bundle runs in a child process with a scrubbed environment and a fresh per-invocation `TMPDIR`. The child is containment, not a trust boundary. It runs as the same OS user as the function and can read the function's environment.
- These protections hold. The execution role grants only CloudWatch Logs. The bundle arrives through a presigned URL valid for 120 s, reaches the child over a dedicated pipe on fd 3, and is imported from memory without touching disk. The child checks its sha256 before importing it. The function holds no S3 or data-plane access. A child only receives calls for the one `accountId + sha256` it was spawned for.
- A changed bundle always gets a fresh process. A retiring child is reaped as a process group, and because `setsid` can escape the group, the function also kills every other process running as its user before each new child.
- Warm reuse is bounded at 64 invokes and 300 s idle per child, set by `MCP_CHILD_MAX_CALLS` and `MCP_CHILD_IDLE_SECONDS`. `MCP_CHILD_REUSE=0` turns reuse off. A timeout, rejected payload or unhandled rejection retires the child. Reuse gives up a clean process per call within one tenant's bundle. Module-level state persists across its own calls, like any long-lived MCP server, while `HOME` and `TMPDIR` are re-pointed at fresh scratch dirs per invocation. The calls of one batch share that scratch dir.
- An invocation gets 30 s and 16 MiB of output, set in `apps/lambda/handler.mjs`. The child aborts 2 s earlier so the run settles before the handler's SIGKILL. Bundles are capped at 50 MB, or 10 MB inline in a request body.

Treat anything the function can reach as reachable by tenant code.

## Code hooks

Inline [code hooks](../guides/hooks.md) run in a V8 `isolated-vm` isolate. Bun cannot load `isolated-vm`, so core spawns Node runners (`src/harness/isolate/runner/runner.mjs`) and talks to them over the NDJSON frame protocol in `src/harness/frames.ts`.

- By default a pool of 4 long-lived workers, set by `ISOLATE_WORKER_POOL_SIZE`, keeps a warm isolate per tenant with a fresh context per call. Idle workers are reaped after 120 s, set by `ISOLATE_WORKER_IDLE_SECONDS`. `ISOLATE_POOL=0` falls back to one runner process per call, at most 8 at once, set by `ISOLATE_RUNNER_CONCURRENCY`.
- Each isolate gets 128 MB (`ISOLATE_MEMORY_LIMIT_MB`) and 30 s (`ISOLATE_RUNNER_TIMEOUT_SECONDS`). A runner receives only `PATH` and those isolate settings from core's environment, never core's secrets. Output is capped at 1 MiB on top of the request size.
- There is no filesystem and no npm or native imports. Network goes only through `ctx.fetch`, the SSRF-guarded pinned fetch in `runner/pinned-fetch.mjs`. It resolves the name, rejects private, loopback and metadata ranges, connects to the address it validated, and caps bodies at 5 MB, requests at 30 s and redirects at 5. The same fetch backs channel attachment downloads.
- Handlers are serialized with `.toString()`, so the SDK rejects bundles that use imports, `require`, `node:` modules or closure variables.
- A hook that throws or times out is skipped, so a hook deny is best effort. Anything that must hold belongs in an enforced policy, which fails closed.

## Sandboxes

- Runs start from a cleared environment. Only declared `envVars` and the image's reserved vars reach them.
- No account key enters a sandbox. Background jobs authenticate their callback with a per-job token.
- Workspace mounts get one-hour STS credentials whose session policy allows only the workspace's key prefix. The `sandbox-s3mount` role itself can also read the skills bucket, but no session core mints for a sandbox includes it; skills reach a sandbox as staged copies in the workspace.
- File tools normalize paths and reject traversal before a command reaches a provider.
- E2B, Daytona and Vercel run outside the AWS boundary. Give them isolated mounts, minimal env vars, provider-side egress controls, and no secrets a workload does not need.

More detail is in [sandboxes](sandboxes.md#security-review-notes-2026-09).

## Outbound requests

Core checks user-supplied URLs before it sends credentials to them. That covers MCP `url` and OAuth `tokenUrl`, lifecycle webhook `url`, channel `apiUrl` overrides, and storage `endpoint`. They must be public `https`, and private, loopback, link-local and metadata addresses are refused. MCP and webhook delivery do not follow redirects.

## Audit ledger

Every account has one append-only ledger in Convex (`auditEvents`, written only through `appendAuditEvent` in `packages/convex/model/auditEvents.ts`). It holds config mutations from the config plane, dashboard and CLI sync, plus two runtime rows: `run.completed` and `tool.denied`. A run is audited once, when it finishes: the usage write (`internal.usage.recordTaskUsage`) appends the `run.completed` row (status, `startedAt`, duration, step and tool counts, token totals) in the same mutation, so the per-turn Convex call budget is unchanged. There is no `run.started` row, and a run cut off at pod shutdown writes no usage row and no ledger row (the ingress settle runs on every run, so it cannot tell a cut-off apart without a flag). `tool.denied` is appended by core when an enforcing policy stops a tool. Rows never carry tool input, config blobs or secrets; `detailsJson` is capped at 8 KB.

```mermaid
flowchart LR
  Head["auditChainHeads<br/>seq, hash"] -->|read, then patch| Append["appendAuditEvent"]
  Append -->|seq+1, prevHash = head.hash| Row["auditEvents row<br/>hash = sha256(canonical JSON)"]
  Row -->|GET /v1/audit?since| Reader
  Row -->|every 10 min, HMAC signed| Sink["auditSinks webhook"]
  Sink -->|2xx| Watermark["exportedSeq"]
  Row -->|older than auditRetentionDays| Prune["pruneExpired"]
  Watermark -->|floor when a sink exists| Prune
```

- Chain: each row stores `seq` (per account, gapless at append), `prevHash` and `hash`. The hash is sha256 over the canonical JSON (keys sorted by UTF-16 code unit, no whitespace) of every row field but `hash`: `accountId`, `seq`, `prevHash`, `at`, `actor`, `action`, `resource`, `summary`, `detailsJson`, `projectId`, `stageId` and `traceId`. An optional field the row does not have is left out of the JSON, never written as `null`. The head row is read and patched in the same mutation, so Convex OCC serializes concurrent appends and two writers cannot take the same `seq`.
- Verify: `GET /v1/audit/verify` (internal query `audit.ledger.verifyChain`) recomputes every hash and link over a range, 1000 rows per call, and `ok` covers only `checkedFrom` to `checkedTo`. Stored rows are gapless from the oldest kept row to the head, so a row missing at the start of a range is reported at its `seq`, while rows below the oldest kept row are a pruned prefix and are not. Without `toSeq` the last row must match the head, so a deleted tail is reported at the first missing `seq`. Editing a row breaks its own hash; re-hashing it breaks the next row's `prevHash`.
- Export: `PUT /v1/audit/sink` stores one webhook per account, the secret encrypted with the agent-config codec. The `export audit events` cron posts the rows past `exportedSeq` as JSON arrays of up to 200, at most 10 batches per sink per tick, each with `X-Broods-Signature: sha256=<hmac>`, the same shape as lifecycle webhooks, and advances the watermark on each 2xx. Sinks export side by side with a 10 second timeout, so one receiver cannot hold up another account's export. The url is held to public `https` by the same `assertPublicHttpsUrl` the rest of the config plane uses.
- Retention: `pruneExpired` sweeps every account with a ledger and deletes rows older than the account's `auditRetentionDays` (90 by default, settable through `PATCH /v1/account`). When the account has a sink, `exportedSeq` is a floor: a row the sink has not exported is never dropped, however old. The head row is never deleted, and rows go oldest first with no gap, so the kept range always verifies from its oldest row to the head.
- Access: the account secret, or a role with `audit:read` for the ledger and `audit:write` for the sink. Setting `auditRetentionDays` takes `audit:write` on top of `account:write`, since it decides when rows are deleted.

## Limits

- Upload URLs for hosted MCP bundles and workspace files are capped at 20 open grants per account per hour. Blobs uploaded but never registered are deleted after a day. A workspace file's size is read from the stored blob, never the client, and refused over 512 KB.
- Anyone with `ACCOUNT_CONFIG_ENCRYPTION_SECRET` and table access can decrypt config. This protects against accidental table-read exposure, not compromised application code.

## Why it is this simple

- No Secrets Manager object per account.
- No KMS decrypt call on every config read.
- Account metadata and runtime config stay in Convex without per-provider secret resources.

Revisit this when Broods needs per-tenant keys or key rotation without a migration.

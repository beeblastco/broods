# Observability & Realtime Logs / Traces / Usage — Working Plan (Handoff)

> Status: **Phases 1–3 IMPLEMENTED on the `dev` working tree (uncommitted). Phase 4 = deploy + verify.**
> This doc is the single source of truth for the next agent.
> Repo: `filthy-panty` monorepo. Infra repo: sibling `../infra` (K8s + Terraform).
>
> **Phased delivery:**
> - **Phase 1 — Foundation + core (DONE):** Convex revert + `usageTasks`/rollups + `usage.recordTask`; shared `observability-contracts`; `UsageStore` (convex + dynamo); core `otel.ts` + `log.ts` redaction/dual-emit; harness spans + usage metering (all-provider cache-write, cgroup CPU); `POST /v1/internal/observability-scope`; `sst.config` OTLP env. `bun run check` + `bun run test` green; `bun run build` green.
> - **Phase 2 — Consumers (DONE):** gateway observability WS + Loki/Tempo backfill; dashboard Logs + Tracing tabs (`useObservabilityStream`); CLI `logs`; stale-doc fixes. All typechecks green.
> - **Phase 3 — Refinements + infra wiring (DONE):** CLI `dev` now sync+watch **and** live-tails logs (like `convex dev`); dashboard self-serve "Generate viewing key" so a dashboard-first user streams without the CLI; confirmed span model (root `agent.task` = one request→final answer, tool/subagent calls are children, interrupt finalizes + next request = new span); `../infra` Loki retention 720h→2160h, Tempo 168h→2160h, gateway `LOKI_URL`/`TEMPO_URL` env.
> - **Phase 4 — Deploy + verify (PENDING, requires the user):** see §12.

---

## 1. Goal

Move logs / traces / token-usage **off CloudWatch pulling** onto a self-hosted
**OpenTelemetry + Loki + Tempo + Grafana** stack, with **NATS** for realtime
streaming to the dashboard and the CLI. ClickHouse is intentionally **off the
critical path**. Convex is **not** a log store — it holds only reactive
usage/metrics.

Priorities (user): realtime/instant logs for development, cheap to operate, no
data loss, no overengineering. **Logs + tracing first; tier/limit enforcement
later** (§8.2).

---

## 2. Phase 0 — Infrastructure (DONE, verified live in `beeblast-prod`)

K8s namespaces `observability`, `nats`, `beeblast`:

| Component | State | Notes |
| --- | --- | --- |
| OTel Collector (deployment + daemonset) | ✅ | OTLP receive; traces→Tempo, logs→Loki (OTLP native) |
| Loki | ✅ | filesystem, retention **720h (~30d)** → **bump to 3 months** |
| Tempo | ✅ | retention **168h (~7d)** → **bump to 3 months** |
| Grafana | ✅ | `grafana.beeblast.co`, Loki+Tempo datasources, `trace_id` correlation |
| External OTLP ingress | ✅ | `https://otel.beeblast.co` (HTTP/4318 only, Traefik basic-auth; 401 unauth) |
| NATS + WebSocket gateway | ✅ | `nats` ns; **single shared token auth** (`nats-auth` secret, key `token`). NO per-tenant JWT/nkey accounts. WS ingress `nats.beeblast.co`. |
| **`apps/gateway`** (`@filthy-panty/gateway`) | ✅ | In-cluster Bun service at **`app.beeblast.co`** (ns `beeblast`). Holds the privileged `NATS_TOKEN`; authenticates public clients by bearer; relays NATS to browser/CLI. **This is the realtime keystone — see §5.** |
| ClickHouse | off path | operator-only Grafana datasource |

**Infra TODO:** bump Loki + Tempo retention to **3 months** in
`../infra/kubernetes/charts/releases/{loki,tempo}.yaml`.

**Correction to the original written plan:** the ADOT Lambda layer exports
traces/metrics only — **NOT stdout logs**. The harness (AWS Lambda, outside the
cluster) must **push** logs/spans via OTLP to `otel.beeblast.co` (durable) AND
publish to NATS (live). In-cluster pods are already scraped by the daemonset.

---

## 3. Grounded facts that reshape the plan (discovered this session)

1. **The gateway already does browser/CLI → NATS, authenticated, in production.**
   `apps/gateway/src/index.ts` accepts a WS with a bearer token, forwards it to
   core for auth, then relays the matching NATS subject back to the client. The
   browser **never** speaks NATS directly. `useAgentChat.ts` already connects to
   `wss://app.beeblast.co/.../ws?token=<apiKey>` for agent testing.
   → **We extend this gateway for logs/traces. We do NOT build NATS JWT minting.**

2. **One credential covers both clients.** The environment **runtime API key**
   (`fp_...`, aka `FILTHY_PANTY_API_KEY`): the CLI stores it; the dashboard
   already fetches it into the browser for agent-test. Logs/traces reuse it.
   → Resolves user Q8: share the same key, gateway enforces scope.

3. **NATS is single-shared-token only** (`infra/docs/nats.md`). Per-tenant
   isolation is enforced **at the gateway** (it subscribes only the caller's
   authorized subjects), not by NATS subject permissions. No NATS auth change.

4. **`dev` is now Convex.** `sst.config.ts` uses
   `useConvexStorage = Boolean(CONVEX_URL && CONVEX_DEPLOY_KEY)` → Convex on ANY
   stage that supplies both (CI `deploy.yaml` passes `secrets.CONVEX_URL` /
   `CONVEX_DEPLOY_KEY`). User confirms dev runs Convex; DynamoDB not deployed for
   dev. → **Stale:** `apps/core/CLAUDE.md` + memory `runtime-api-key-model` still
   say "dev = DynamoDB"; fix them.

5. **Existing NATS subject (agent-test, keep as-is):**
   `v1.<accountId>.<agentId>.ws.response.<base64url(conversationKey)>`, captured by
   the `WS_RESPONSES` JetStream stream. Logs/traces use **separate subject trees**
   (§6) — satisfies "agent-test and logs must not share a subject."

6. **Sandbox exec already measures wall-clock.** `kubernetes-executor.ts` tracks
   `durationMs = Date.now() - startedAt` per exec. True CPU-seconds would need
   metrics-server/cAdvisor — see open decision §9.1.

7. **Usage write currently bypasses `StorageProvider`.** `_shared/telemetry.ts`
   writes straight to Convex (`getConvexClient` + `internal.telemetry.record`),
   guarded by `STORAGE_PROVIDER === "convex"`. DynamoDB has no usage path yet —
   see open decision §9.3.

---

## 4. Code state (this repo, uncommitted on `dev`)

Built under the earlier "Convex hot table" design; partly superseded. Keep usage
pieces, revert the Convex-logs pieces.

| File / change | Keep or revert |
| --- | --- |
| `packages/convex/schema.ts` — `usageRollups` table | **KEEP + EXPAND** (§6c) |
| `packages/convex/schema.ts` — `telemetryEvents` table | **REVERT** (logs leave Convex) |
| `packages/convex/telemetry.ts` — `record` usage upsert | **KEEP** (drop event-insert half) |
| `packages/convex/telemetry.ts` — `pruneOldEvents` + `crons.ts` prune | **REVERT** |
| `packages/convex/logs.ts` — `fetchUsageStats` reactive query | **KEEP** |
| `packages/convex/logs.ts` — `fetchForProject`/`fetchForCli`/`cliEntries` | **REVERT** → logs now from gateway (Loki + NATS) |
| `packages/convex/logsHelpers.ts` — `projectEndpointIds`, `getCliEndpointIds` | **KEEP** (scope Loki/NATS by endpointId) |
| `packages/convex/package.json` — drop `@aws-sdk/client-cloudwatch-logs` | **KEEP** |
| `apps/core/.../{session,integrations,handler}.ts` — thread `endpointId` | **KEEP** (usage scope + NATS subject) |
| `apps/core/functions/_shared/telemetry.ts` — `recordTelemetry` | **KEEP usage path; drop event path** |
| `apps/core/.../harness.ts` — telemetry write at invocation boundary | **KEEP usage; move logs/spans to NATS+OTLP** |
| `apps/dashboard/.../MonitoringPanel.tsx` — `useQuery` logs | **REVERT** → gateway poll + NATS live tail |
| `apps/dashboard/.../TokensUsagePanel.tsx` — `useQuery` usage | **KEEP** |
| `apps/dashboard/package.json` — drop cloudwatch dep | **KEEP** |
| `packages/filthy-panty/src/sync.ts` + `cli/index.ts` — `CliLogEntry` shape | **KEEP shape; logs now stream via gateway** |

---

## 5. The gateway is the single keystone (auth + transport)

**`apps/gateway` already does this for agent-test; extend it for logs/traces.**

```
 browser / CLI ──bearer = env runtime API key (fp_…)──▶ GATEWAY (app.beeblast.co, in-cluster)
                                                          │  • validates bearer via core → {accountId, project, env, endpointIds}
                                                          │  • holds privileged NATS_TOKEN (server-side only)
                                                          │  • reaches Loki/Tempo cluster services (no public ingress)
                                                          ▼
                                          NATS subscribe (live)  +  Loki/Tempo query (backfill)
                                          scoped to caller's subjects only → relayed back over the client WS/HTTP
```

- **No NATS JWT minting, no separate "doorway" service.** The gateway is both the
  live relay AND the Loki/Tempo read doorway (it's in-cluster, the only thing
  besides Grafana that can reach them).
- **Tenant isolation = gateway-enforced.** It subscribes/queries only the subjects
  and label-filters the caller is authorized for; the shared `NATS_TOKEN` and the
  unauthenticated Loki never leave the cluster.
- **New core endpoint:** "resolve scope for this API key" → returns
  `{accountId, projectSlug, environmentSlug, endpointIds[]}` so the gateway knows
  what to subscribe/query. (Mirrors how agent-test core auth already returns
  `{nats:{accountId, agentId, ...}}`.)

---

## 6. Components in detail

### 6a. Subjects (project/environment aware — user Q6)

| Stream | Subject | Wildcard a dashboard tab / CLI env subscribes |
| --- | --- | --- |
| Agent test (existing) | `v1.<acct>.<agentId>.ws.response.<b64(convKey)>` | unchanged |
| **Logs** (new) | `v1.<acct>.<project>.<env>.logs.<endpointId>` | `v1.<acct>.<project>.<env>.logs.>` |
| **Traces** (new) | `v1.<acct>.<project>.<env>.traces.<endpointId>` | `v1.<acct>.<project>.<env>.traces.>` |

Logs/traces are **separate subject trees** from agent-test (`…ws.response…`).
`<project>`/`<env>` are the deployment's slugs (already on `AgentDeploymentRecord`).

### 6b. Durable logs/traces (Loki / Tempo) — everything, 3 months

- Harness `_shared/log.ts` dual-emits: stdout (CloudWatch fallback) **+** OTLP push
  to `otel.beeblast.co` (basic-auth header as SST secret; `http/protobuf`, 4318).
- New `_shared/otel.ts` inits the OTel SDK; `harness.ts` adds spans at the existing
  hook points (`model.invocation.started/finished`, `model.step.finished`,
  `tool.call.*`). **Root span = one task request to the agent** (user Q5).
- Per-tenant isolation is a **log/span attribute** (`account_id`, `project`,
  `environment`, `endpoint_id`), filtered in Loki/Tempo — single shared harness Lambda.
- **Loki/Tempo get EVERYTHING** including DEBUG (for developers maintaining the app).
- **Secret redaction at the log boundary (single chokepoint in `log.ts`)** runs
  **before** anything reaches OTLP/Loki **or** NATS: scrub known-sensitive fields
  (API keys, bearer/auth headers, account-config secret values, env-var values).
  User prompts and tool args still flow (needed for debugging). Repo is public, so
  this is a hard requirement, not optional.

### 6c. Live logs/traces (NATS, via gateway)

- `log.ts` also publishes **INFO / WARN / ERROR only** (NOT DEBUG — user Q5) to
  `…logs.<endpointId>`, best-effort/non-blocking. Loki is the non-lossy backstop.
- Harness publishes **spans** to `…traces.<endpointId>` (each agent task → one root
  span with child steps/tool calls) so the dashboard Tracing tab is realtime.
- Reuse the existing NATS connection path (`_shared/nats.ts`, `LiveNatsPublisher`);
  for logs/traces use plain core pub/sub (no JetStream — durability is Loki/Tempo).
- **Durable (OTLP) and live (NATS) are separate paths** so a NATS hiccup never loses
  durable data.

### 6d. Usage + compute metering (Convex + DynamoDB)

**Store raw counts; price in the UI.** Convex/DynamoDB hold only token/cache/compute
**counts** — never a dollar amount. The dashboard computes price at render from a
**hardcoded shared pricing table** (importable by both core and dashboard, keyed by
`provider/modelId`, with explicit **cache-write and cache-read** rates). Trade-off the
user accepted: changing a rate retroactively shifts historical totals.

- **Tokens, per `model.step.finished`:** read `usage` + `providerMetadata` from the
  Vercel AI SDK, **including cache fields** (cached/read input tokens, cache writes).
  Accumulate across steps → **finalize at task done** (`model.invocation.finished`).
- **Compute metering (meter now; tier/limit enforcement later — user Q2):**
  - **Harness Lambda:** GB-seconds = `memorySize × billedDurationMs` (from Lambda ctx).
  - **Sandbox:** **actual CPU consumed**, NOT allocated CPU (allocation auto-scales, so
    it isn't a fair base — user clarification). Measure the **cgroup CPU-time delta**
    around each exec: read `/sys/fs/cgroup/cpu.stat` (`usage_usec`, cgroup v2) in the
    in-pod wrapper before/after the command; `Δusage_usec` = CPU-seconds billed. No
    metrics-server dependency. Keep the existing wall-clock `durationMs` as a secondary
    metric.
- **DynamoDB parity (user Q4):** add a usage store to **both** storage adapters; each
  deployment writes to its **active** provider (no dual-write). Convex usage is reactive
  (`useQuery`); DynamoDB usage is read via polling and serves OSS/self-host + future
  limit checks. This means lifting usage out of the current Convex-only bypass in
  `_shared/telemetry.ts` into the `StorageProvider` interface (new `usage`/`metering`
  store with `dynamo/` + `convex/` implementations).
- **Two grains (user Q):** write **one usage record per finished task**
  (tokens/cache/Lambda-GB-s/sandbox-CPU-s, finalized at task done) so the dashboard
  shows per-task cost, **AND** keep the 5-min `usageRollups` (folded per
  endpoint/model) for charts. Both stored per `(account, project, environment,
  endpoint)`.

### 6e. Consumers

- **Dashboard Logs tab:** initial backfill = one authenticated GET to the gateway
  (Loki, tenant-filtered) → then WS subscribe `…logs.>` for live. **Optimistic
  merge** (never clear+spinner; splice new rows in place).
- **Dashboard Tracing tab:** **each span = one task request** (user Q5). On open,
  gateway queries **Tempo** for recent traces (tenant-filtered backfill) → then WS
  subscribe `…traces.>` for live (user Q-tracing). Same optimistic-merge pattern as logs.
- **Dashboard Usage panel:** Convex `useQuery` (true reactive push).
- **Dashboard Agent-test:** existing gateway WS on `…ws.response…` (unchanged).
- **CLI `filthy-panty dev`:** continuously **streams logs live** from connect-time
  (gateway WS, same keystone), scoped to the **whole project/environment**
  (`…logs.>`, all endpoints — user Q). Shows logs + errors inline.
- **CLI `filthy-panty logs`:** **truncated window, default 100 lines** (user Q7):
  gateway Loki backfill → then live tail. Has a **WARNING/ERROR-only filter**
  (user Q5).

---

## 7. Build order (status)

1. ✅ **Revert Convex log pieces** (§4): drop `telemetryEvents`, prune cron, reactive
   log queries; keep usage tables/queries + `endpointId` threading + `logsHelpers`.
2. ✅ **Core durable + live:** `_shared/otel.ts` + `log.ts` OTLP push (→Loki/Tempo) AND
   NATS publish of INFO+ logs and spans on the new subjects. SST: ADOT layer + OTLP
   env + basic-auth secret (no default values — inject via CI).
3. ✅ **Gateway extension (keystone):** add (a) a log/trace **subscribe** WS mode
   (validate bearer→scope via core, subscribe `…logs.>`/`…traces.>`, relay), and
   (b) **backfill HTTP** routes that query Loki/Tempo with the tenant label filter.
4. ✅ **Usage metering** (§6d): per-step token+cache accumulation, Lambda GB-seconds +
   sandbox cgroup CPU-seconds, stored as **raw counts** in a new `usage` store on the
   `StorageProvider` (Convex + DynamoDB, active-provider write). Pricing lives in a
   shared hardcoded table consumed by the dashboard at render — not stored.
5. ✅ **Dashboard:** Logs tab (backfill + NATS live + optimistic merge), Tracing tab
   (per §9.2), keep Usage `useQuery`.
6. ✅ **CLI:** `dev` live stream + `logs` truncated(100) with WARN/ERROR filter, via
   the gateway.

**Remaining follow-ups (NOT yet done):**

- **Infra TODO (separate `../infra` repo — do not edit here):** bump Loki retention
  from `720h` to `2160h` (90 days / ~3 months) in
  `../infra/kubernetes/charts/releases/loki.yaml`, and bump Tempo retention from
  `168h` to `2160h` in `../infra/kubernetes/charts/releases/tempo.yaml`.
- **Runtime verification:** smoke-test the full path against the live `beeblast-prod`
  cluster after the `dev` changes are committed and deployed.
- **Review:** security + load review of the gateway observability WS path before
  promoting to `main`.

---

## 8. Resolved decisions (user answers — folded in)

1. **Pricing:** hardcoded in code; cache-write AND cache-read prices provided. (§6d)
2. **Tiers/limits:** **later.** Now: make logs + tracing flawless. Usage is
   meter+display only for now. (§6d)
3. **Compute billing:** sandbox billed on **CPU usage**; Lambda on **GB-seconds**. (§6d)
4. **Dev = Convex** already (DynamoDB not deployed for dev). Also add a **DynamoDB
   usage path** so DynamoDB-mode deployments meter too, kept in sync with Convex.
   Verify CI sets Convex for dev. (§3.4, §9.3)
5. **NATS levels = INFO/WARN/ERROR** (no DEBUG). Loki/Grafana = everything. CLI has a
   **WARNING/ERROR-only filter**. Dashboard **also receives span tracing** → Tracing
   tab, **each span = one task request**. (§6b/§6c/§6e)
6. **Subjects carry project + environment** (each dashboard tab differs per
   project/env). (§6a)
7. **`filthy-panty logs` truncation default = 100 lines.** (§6e)
8. **NATS auth = reuse the existing API key via the gateway** (shared by CLI +
   dashboard); the gateway enforces scope. No separate creds flow. (§5)

---

## 8b. Resolved decisions (this session — second round)

1. **Sandbox CPU = actual consumed**, via cgroup `cpu.stat` delta around each exec
   (NOT allocated CPU; allocation auto-scales). Lambda = GB-seconds. (§6d)
2. **Tracing tab = NATS live `traces.*` + Tempo backfill on open.** (§6e)
3. **DynamoDB usage parity built now**, active-provider write, lifted into a
   `StorageProvider` usage store (Convex reactive, DynamoDB polled). (§6d)
4. **Pricing = store raw counts, price in the UI** from a hardcoded shared table;
   no dollar amount persisted (rate changes shift historical totals — accepted). (§6d)

Standing decision (low-risk, taken unless you object): the **browser reuses the
environment runtime API key** for the logs/traces gateway WS — identical to what
agent-test already does, so zero new exposure.

---

## 8c. Resolved decisions (this session — third round)

1. **Redact secrets at the `log.ts` boundary** before OTLP/Loki and NATS emit;
   prompts/tool args still flow. Hard requirement (public repo). (§6b)
2. **`filthy-panty dev` streams the whole project/environment** (`…logs.>`). (§6e)
3. **Store per-task usage rows AND 5-min rollups** — per-task for line-item cost,
   rollups for charts. (§6d)

---

## 8d. Resolved decisions (this session — fourth round)

1. **Cache-write metering = all major providers** (Anthropic + OpenAI + Bedrock +
   Google). Build a per-provider `providerMetadata` → cache-write extractor (§10d.1).
2. **DynamoDB/OSS usage = coarser `account + agent` scope** (no new DDB deployment
   table; per-env scoping stays Convex-only) (§10a).

---

## 9. Status: ready for handoff

All architecture, product, and security decisions are resolved (§8 / §8b / §8c / §8d).
The annex (§10) gives concrete schema, WS protocol, and tracing/error logic. Decisions
taken in-code (no product call): Lambda GB-seconds = wall-clock × memory proxy
(§10d.2); single combined logs+traces WS endpoint (§10b); CLI `logs` default INFO+ with
a `--errors`/WARN+ filter; secret-redaction starter deny-list (`Authorization`,
`x-api-key`, `apiKey`, `secret`, `token`, `password`, env-var values, account/provider
secrets).

---

## 10. Implementation annex (concrete shapes, grounded in current code)

### 10a. Usage store — schema + interface

Grounded in `harness.ts onFinish`, which **already** flushes once per task via
`flushTelemetry(..., usageToDelta(totalUsage, stepCount))` (`totalUsage` = the
accumulated cross-step total). So a per-task row is a natural extension.

**Convex — new `usageTasks` (per finished task) + expand `usageRollups`:**
```
usageTasksFields = {
  accountId: id(accounts), endpointId: string,
  agentId: string, conversationKey: string, taskId: string /* = session.eventId */,
  modelProvider: string, modelId: string,
  finishedAt: number, durationMs: number, status: "completed" | "failed",
  // tokens — RAW counts only (price computed in the UI, §6d)
  inputTokens, outputTokens, reasoningTokens,
  cachedInputTokens /* cache READ */, cacheWriteTokens /* cache CREATION */, totalTokens,
  // compute
  lambdaMs, lambdaMemoryMb, sandboxCpuUsec,
  stepCount, toolCallCount,
}
// indexes: by_endpointId_and_finishedAt, by_accountId_and_finishedAt
```
`usageRollups` (KEEP) gains `cacheWriteTokens`, `lambdaMs`, `sandboxCpuUsec` (same
ADD-fold as the existing token fields).

**StorageProvider gains a `usage` store** (lifts usage OFF the current Convex-only
bypass in `_shared/telemetry.ts`):
```
interface UsageStore { recordTask(input: UsageTaskInput): Promise<void>; } // row + rollup fold
// StorageProvider.usage: UsageStore
```
- `convex/usage.ts` → `internal.usage.recordTask` (full endpoint/project/env scope).
- `dynamo/usage.ts` → **coarser `account + agent` scope** (decision §8d; DDB has no
  endpoint/project/env): per-task `PK=ACCOUNT#<id>, SK=TASK#<finishedAt>#<taskId>`
  (agentId as attribute); rollup `PK=ACCOUNT#<id>, SK=ROLLUP#<agentId>#<modelId>#<bucketStart>`
  via atomic `ADD`. `endpointId` is Convex-only.
- `recordTelemetry` becomes **usage-only**, calls `getStorage().usage.recordTask(...)`;
  its event path is deleted (events now go to NATS+OTLP, §10c). `UsageTaskInput` carries
  optional `endpointId`/`project`/`environment` (Convex uses them; DDB ignores them).

### 10b. Gateway log/trace subscribe — WS protocol

Extends `apps/gateway` (today only `{type:"execute"}`/`{type:"cancel"}` on
`/v1/.../ws`). Logs/traces use a **separate path + message types** — never mixed
with agent-test.
```
WS  wss://app.beeblast.co/v1/<project>/<env>/observability/ws?token=<env apiKey>

client → gateway:
  { type:"subscribe",   stream:"logs"|"traces", backfill?:number, minLevel?:"INFO"|"WARN"|"ERROR" }
  { type:"unsubscribe", stream:"logs"|"traces" }
gateway → client:
  { type:"ready" }
  { type:"backfill", stream, entries:[ LogEntry | SpanRow ] }   // Loki / Tempo
  { type:"log",  entry: LogEntry }                              // live, from NATS
  { type:"span", entry: SpanRow }
  { type:"error", error }
```
1. Gateway validates `token` → core `POST /v1/internal/observability-scope` →
   `{accountId, projectSlug, environmentSlug, endpointIds[]}`. **Scope comes from the
   token, never the client**; client params may only *narrow* within scope.
2. `backfill>0` → gateway queries Loki/Tempo in-cluster, label-filtered
   `{account_id,project,environment}`, limit=backfill → `backfill` msg.
3. Gateway core-NATS `subscribe` (live, NOT JetStream) to
   `v1.<acct>.<project>.<env>.logs.>` / `…traces.>`, relays as `log`/`span`;
   `minLevel` filtered server-side. CLI `logs` = subscribe+backfill:100 then drain;
   `dev` keeps it live.

### 10c. Tracing + error logic

- **One OTel traceId per task**, minted at run start in `_shared/otel.ts`, stamped on
  the root span AND every log line (the `traceId` field already exists on the event /
  `CliLogEntry`) → logs↔traces cross-link in Grafana and the dashboard.
- **Span tree (root = one task — user Q5),** from hooks that already exist:
  root `agent.task` (`model.invocation.started`→`onFinish`/`onError`); child
  `model.step` (`experimental_onStepStart`→`onStepFinish`); child `tool.call`
  (`experimental_onToolCallStart`→`experimental_onToolCallFinish`).
- **Errors = three coordinated signals:** (1) `ERROR` log line (redacted) → NATS+Loki;
  (2) span status `error` + `recordException` → Tempo (red root in Tracing tab);
  (3) `usageTasks.status="failed"` row still written (the task still consumed tokens).
- **Finalize-once (gap to fix):** `onFinish` may NOT run on a hard `streamText` throw.
  Wrap the run in `try/finally` and finalize usage in `finally`, idempotent by
  `taskId`, so every task meters exactly once.

### 10d. Risks / gaps to define before coding

1. **Cache-write tokens are NOT in normalized `usage`.** `usageToDelta` reads only
   `cachedInputTokens` (cache *read*). Cache *write* lives in `providerMetadata`,
   named per-provider — build a small extractor covering **all four** (decision §8d):
   Anthropic `cacheCreationInputTokens`; OpenAI prompt-cache fields (no separate
   cache-write bill → 0); Bedrock (Anthropic-on-Bedrock cache-creation); Google
   (cached-content tokens). Accumulate from each `onStepFinish.providerMetadata` into a
   task-scoped counter, included at finalize. Keep the map in the shared pricing module
   so UI pricing and extraction agree on field names.
2. **Lambda GB-seconds is in-process-approximate** (real billedDuration is the very
   CloudWatch metric we're leaving). Use `durationMs × AWS_LAMBDA_FUNCTION_MEMORY_SIZE`.
3. **Sandbox CPU must bubble tool→task.** Add `cpuUsec` to the executor result
   (cgroup `cpu.stat usage_usec` delta inside `#wrapShell`, stripped from user
   stderr); accumulate into a task-scoped counter read at finalize. Persistent-pod
   concurrent execs can double-count pod-cgroup CPU → serialize or read per-exec.
4. **NATS publish volume:** every INFO+ line = one publish from Lambda over `wss`.
   Reuse the per-invocation connection (LiveNatsPublisher memoizes); cold starts pay a
   connect. Fine at current scale; revisit if hot.
5. **Backfill auth:** the Loki/Tempo label filter is built from the validated token
   scope, never raw client input.

---

## 11. Key files reference

**Gateway (keystone)** (`apps/gateway/src/`): `index.ts`
**Convex** (`packages/convex/`): `schema.ts`, `telemetry.ts`, `logs.ts`, `logsHelpers.ts`, `crons.ts`
**Core** (`apps/core/functions/`): `_shared/{log,telemetry,nats}.ts`, NEW `_shared/otel.ts`,
`harness-processing/{harness,handler,integrations,session}.ts`,
`harness-processing/sandbox/kubernetes-executor.ts` (compute metering), `sst.config.ts`
**Dashboard** (`apps/dashboard/app/`): `(main)/[projectId]/dashboard/components/{MonitoringPanel,TokensUsagePanel,TracingPanel}.tsx`,
`hooks/useAgentChat.ts` (gateway WS pattern to copy), `lib/coreEndpoint.ts`
**CLI/SDK** (`packages/filthy-panty/src/`): `sync.ts`, `cli/index.ts`
**Infra** (`../infra/kubernetes/charts/releases/`): `loki.yaml`, `tempo.yaml`, `gateway.yaml`,
`nats.yaml`, `otel-collector*.yaml`; `infra/docs/nats.md`

**Verified facts:** OTLP ingress `otel.beeblast.co` (401-gated, HTTP/4318); gateway
`app.beeblast.co` (in-cluster, holds NATS token, already relays agent-test);
NATS = single shared token (no per-tenant JWT); Loki/Tempo have NO public ingress
and NO per-tenant auth (gateway is the doorway); `dev` runs Convex storage.

---

## 12. Phase 4 — Deploy + verify (the only thing left)

Code is complete and green (`bun run check`, `bun run test` 594/0, `bun run build`,
dashboard + gateway `tsc`). What remains is config injection + a deploy + a live
smoke test. None of this is done locally; it needs the cluster + CI secrets.

**a. Inject config (no defaults in code — per the secrets rule):**
- Core (SST / GitHub Actions secrets used by `deploy.yaml`): `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.beeblast.co`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(user:pass)>` (the `otlp-basic-auth` cred), and confirm `NATS_URL`/`NATS_TOKEN` reach `harness-processing` (already wired in `sst.config.ts`; CI must pass them).
- Gateway (`../infra/.../gateway.yaml`): `LOKI_URL`/`TEMPO_URL` added — **verify the service names** with `kubectl get svc -n observability` before rollout (degrades to skip-backfill if wrong; live still works).

**b. Apply infra:** roll out the updated `loki.yaml` / `tempo.yaml` (retention) and `gateway.yaml` (env), then redeploy the gateway image (`ghcr.io/beeblastco/filthy-panty-gateway`) built from the new `apps/gateway`.

**c. Deploy:** push `dev` → CI deploys core Lambda + the dashboard image (which runs `convex deploy`, applying the `usageTasks`/`usageRollups` schema). 

**d. Smoke test the whole path** (one real request, e.g. a Telegram message):
1. Dashboard Monitoring tab streams the request's INFO+ logs live; Tracing tab shows exactly **one `agent.task` span** for the request with tool/subagent calls as children; an interrupt closes that task and the next request opens a new span.
2. CLI `filthy-panty dev` (and `logs`) tails the same lines; `--errors` filters to WARN+.
3. Grafana shows the same logs/traces durably with `trace_id` log↔trace correlation.
4. `usageTasks` gets one row per finished task (tokens incl. cache-write, `lambdaMs`, `sandboxCpuUsec`); `usageRollups` folds; Tokens tab renders priced totals.
5. Confirm redaction: no `Authorization`/secret values appear in any emitted log.

# Handoff — CLI logs, error surfacing, env-var warning, and reactive-logs design

Branch: `codex/harden-cli-managed-resources` (working tree, **nothing committed/pushed**).
Date: 2026-06-14. Region note: dev = `eu-central-1`, prod = `ap-southeast-1`. AWS_PROFILE=default (account 403012596812).

---

## TL;DR of where we are

Three problems the user reported (all confirmed real) + one new design request:

1. **Silent drop** — running the sandbox-stateless demo produced *zero* output and exit 0 when the
   MiniMax key wasn't set. ✅ **FIXED** (SDK now throws on stream `error` parts).
2. **No warning when a referenced env var isn't set** — renaming `env.ACCOUNT_MINIMAX_API_KEY` →
   `env.MINIMAX_API_KEY` silently no-op'd into an unresolved `${MINIMAX_API_KEY}`. ✅ **CODE DONE**,
   but the Convex half only goes live after a **Convex deploy** (not done — don't deploy unprompted).
3. **Logs not visible in the CLI** (wants `convex dev`-like behavior). ✅ **DONE via polling**
   (`logs`, `logs -f`, `dev` auto-tail). This is the pull baseline.
4. **NEW design request (open):** replace polling with **push / pub-sub** ("more reactive, less
   resource-constrained", mentioned using "the SNS/NAS services I already have"). ⏳ **NOT STARTED** —
   needs an architecture decision (see "Open decision" below).

Status checks: `bun run check` (core + convex + SDK) = **all green**. Demo runs end-to-end.

---

## Root cause that started it all

The demo's `agents.ts` referenced `env.MINIMAX_API_KEY`, but only `ACCOUNT_MINIMAX_API_KEY` was set
server-side. Env refs compile to a `${NAME}` placeholder resolved at runtime from the environment's
stored vars (Convex `environmentVariables` table). An unset name stays unresolved → empty API key →
MiniMax **HTTP 401** `authentication_error`. The AI SDK emitted a `{type:"error"}` stream part, and
the demo loop only printed `text-delta` parts → total silence.

Fixed the immediate state by running (already done this session):
`printf '%s\n' "$KEY" | bun .../cli/index.ts env set MINIMAX_API_KEY` (value copied from
`packages/demos/.env` `ACCOUNT_MINIMAX_API_KEY`) then `deploy`. Demo now works.

---

## Changes made (uncommitted) — file by file

### 1. SDK surfaces stream errors — `packages/filthy-panty/src/client.ts`

- In `stream()`, parse each SSE part; if `part.type === "error"`, **throw**
  `Agent run failed: <formatStreamError(part.error)>` instead of yielding/swallowing.
- Added `formatStreamError()` helper: handles AI SDK `APICallError` shape
  (`data.error.message` → `message` → `responseBody` → JSON), prefixes `name`, appends `(HTTP <code>)`.
- This makes silent drops impossible for ANY consumer, including the demo loop that only reads
  `text-delta`.

### 2. Deploy-time missing-env warning — Convex + SDK + CLI

- `packages/convex/cliSync.ts`:
  - `syncAgentResources` options now take `missingEnv: Set<string>`; inside the agent loop, every
    referenced env name not present in `envValues` is added to it (sits right above the
    `runtimeVariables` filter that previously dropped them silently).
  - Added `warningsValidator = v.object({ missingEnv: v.array(v.string()) })`.
  - `syncManifestBySecretHash`: `returns` now includes `warnings: warningsValidator`; handler builds
    `const missingEnv = new Set<string>()`, passes it down, returns
    `warnings: { missingEnv: [...missingEnv].sort() }`.
- `packages/convex/cliHttp.ts`: the manifest `PUT` handler returns `refreshed` (re-read from DB,
  which has NO warnings), so I merge warnings back in:
  `return json({ ...(refreshed ?? {...}), warnings: result.warnings })`.
- `packages/filthy-panty/src/sync.ts`: `RemoteManifestResponse.warnings?: { missingEnv?: string[] }`.
- `packages/filthy-panty/src/cli/index.ts`: `printSyncWarnings(result)` prints
  `⚠ N env var(s) referenced in agent config but not set: ...` plus a `filthy-panty env set <NAME>`
  line per var. Called in both `deploy()` and `syncDev()`.
- **Ran `bun run --filter @filthy-panty/convex codegen`** (it pushed functions to the dev deployment
  during typegen). Generated diffs are part of the working tree.
- ⚠️ **Verification gap:** the live warning did NOT fire when tested, because the dashboard proxy
  hits the **deployed** Convex functions (old code). Logic is correct + typechecks; it will work once
  Convex is properly deployed (per repo rule, Convex deploys via the dashboard image build —
  do not deploy unprompted). Verified by code inspection only.

### 3. CLI logs (polling baseline) — `packages/filthy-panty/src/cli/index.ts` + `sync.ts`

- `sync.ts`: `logs()` now takes `lookbackMs`, returns typed `{ logs: CliLogEntry[] }`; exported
  `CliLogEntry` interface (timestamp/message/level/logGroup/logStream/functionName/requestId).
  NOTE: the Convex `/logs` route already accepted `lookbackMs` — **no Convex change needed for tail.**
- `cli/index.ts`:
  - `logs` command: `--error`/`--errors`, `--limit <n>` (default 50), `--json` (raw), and
    `-f`/`--follow` (live tail). Default output is pretty: `HH:mm:ss.SSS LEVEL message`.
  - `formatLogEntry()`, `delay(ms, signal)`, `tailLogs(client, project, env, {errorOnly, intervalMs, signal})`.
    `tailLogs` polls every 3s over a rolling `max(interval*4, 30s)` lookback window, dedupes by
    `timestamp|requestId|message`, prints new lines, bounds the seen-set to 2000.
  - `dev` watch mode now starts a background tail via `startDevLogTail(args, signal)` (compiles once
    for project/env, reuses auth), abortable with `--no-logs`; SIGINT aborts the `logController` and
    closes the watcher.
  - HELP text updated for `logs [-f]`, `--no-logs`, `-f/--follow`, `--error`, `--limit`, `--json`.

### 4. Pre-existing (from earlier in session, still uncommitted)

- `packages/filthy-panty/src/resources.ts`: `env` is a Proxy supporting BOTH `env.NAME` and
  `env("NAME")` (the `EnvAccessor` interface with `readonly [name: string]: EnvRef`).
- `packages/demos/sandbox-stateless/filthypanty/agents.ts`: uses `env.MINIMAX_API_KEY`.
- `packages/demos/sandbox-stateless/index.ts`: demo runner (unchanged logic; only prints `text-delta`
  — now safe because the SDK throws on errors).

Diff stat (core code, excludes the unrelated demo deletions in `git status`):

```text
cliHttp.ts   11 ++   |  cliSync.ts   23 ++   |  cli/index.ts  140 ++
client.ts    35 ++   |  resources.ts  4 ++   |  sync.ts        22 ++
```

> The many `D packages/demos/*` deletions and `?? packages/demos/*` new dirs in `git status` are
> a pre-existing demo reorg from before this session — **not mine**, leave them / handle separately.

---

## Backend facts learned (for the reactive-logs work)

- Logs come from **CloudWatch** via `packages/convex/logs.ts`:
  - `fetchForCli` (internalAction) and `fetchForProject` (action) both call `FilterLogEventsCommand`
    on `/aws/lambda/<fn>` log groups — **on-demand pull, NOT reactive.**
  - The harness log group comes from Convex env `FILTHY_PANTY_HARNESS_LOG_GROUP`.
- **The dashboard ALSO polls** — `MonitoringPanel.tsx` uses `useAction(api.logs.fetchForProject)` on a
  timer. There is **no reactive `logEvents` table** anywhere (confirmed via schema grep).
- CLI → dashboard `/api/cli/[...path]` (transparent proxy) → Convex `cliHttp.ts` HTTP actions.
- Run streaming already uses **SSE** (`client.ts` openStream + `readSseStream`) — reusable plumbing.

---

## Open decision — reactive/push logs (the user's latest ask)

**Key constraint to convey:** a CLI can't *receive* a push (no public endpoint). "Push" = the CLI
holds open ONE stream (SSE/WebSocket) to a server that is itself reactive. **SNS alone doesn't solve
it** — SNS can't deliver to a laptop; `CW→SNS→SQS→CLI` is still the CLI polling SQS. SNS is only
useful as ingest fan-out.

I presented 4 options (user interrupted before answering, wants to clarify the questions first):

- **A. Convex-reactive + SSE (recommended):**
  `Lambda → CloudWatch subscription filter → forwarder λ → Convex logEvents table (TTL/cron prune)
   → reactive query → SSE endpoint → CLI (logs -f / dev) AND dashboard MonitoringPanel`.
  Reuses Convex reactivity + existing SSE. ~1–2s latency. Keep the poller as fallback.
  Spans: SST infra (subscription filter + forwarder + IAM), Convex (table + HTTP ingest + reactive
  query + SSE), CLI/dashboard consumers. Adds cost + a deploy.
- **B. Harness writes log events directly to Convex** as it runs (CloudWatch secondary). Most
  reactive/near-instant, but bigger harness change + tighter coupling.
- **C. Optimize polling only** — server-side `since=<lastTs>` cursor + adaptive interval/backoff.
  Smallest change, no new infra, still pull.
- **D. Hold** — keep the polling tail as-is.

**Next step:** user wants to *clarify the question* first. When resuming, ask what they want to
clarify (e.g. acceptable latency target, whether "SNS" was literal, cost tolerance, whether dashboard
should switch off polling too), then re-pose A–D and proceed with their pick.

---

## TODO checklist for the next session

- [ ] Resume the reactive-logs decision (clarify → pick A/B/C/D → build).
- [ ] Decide whether/when to **commit** these changes and push to `dev` (memory: small changes → dev,
      no PR; never commit/push unprompted). Suggested commit split:
      (1) SDK error surfacing, (2) missing-env deploy warning, (3) CLI log tail.
- [ ] **Deploy Convex** so the missing-env warning + any new log functions go live (currently only the
      dev deployment got a codegen-time push; the dashboard-served deployment may be stale).
- [ ] Original **Issue 3 still unaddressed:** the dashboard graph/flow tab shows no arrows between
      services (account-manage ↔ harness) for the env/account. Needs a separate apps/dashboard
      investigation — not touched this session.
- [ ] Polish: the polling tail prints raw CloudWatch `platform.*` lifecycle JSON lines (noisy);
      consider filtering lifecycle noise / parsing structured JSON `message` for cleaner output.
- [ ] Security backlog (from memory): rotate dev/prod `fp_svc_…` service tokens and CONVEX_DEPLOY_KEY
      values that appeared in earlier transcripts.

## Quick verify commands

```text
bun run check                                   # core + convex + SDK typecheck (currently green)
cd packages/demos/sandbox-stateless && bun index.ts          # demo (works; key is set)
bun ../../filthy-panty/src/cli/index.ts logs --limit 8       # pretty logs
bun ../../filthy-panty/src/cli/index.ts logs -f              # live tail (Ctrl+C)
```

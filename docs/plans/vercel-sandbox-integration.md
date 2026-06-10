# Vercel Sandbox Integration — Plan & Research

> Status: **planned** (not started). Confirmed scope: **(1)** adopt two provider-agnostic
> concepts — *lifecycle hooks* (`onCreate`/`onResume`) and a *normalized network policy* —
> **(2)** add a 5th `vercel` provider backed by `@vercel/sandbox`, **lazily imported**, and
> **(3)** a separate research track on **targeted lazy-loading** to reduce harness cold
> start / RAM (analysis in §3 — read it; the conclusion is counter-intuitive because of the
> `bun --compile` build).
>
> **Decisions locked (§7):** hooks named `onCreate`/`onResume`; **hard-replace** the
> `internet` boolean with `network` (no back-compat shim); **vercel background jobs ship in
> v1**; the lazy-import pass is a **separate follow-up** with its own cold-start measurement;
> unset `network` defaults to **`deny-all`** (secure by default); **no legacy compat** — the
> repo is pre-release, existing dev records are updated directly in DynamoDB + Convex;
> lambda maps `restricted` to the **net-off slot** (fail closed, no infra changes).
>
> Read §2 for the feature mapping, §3 for the cold-start truth, §4 for the design, §6 for
> the change list, §7 for the resolved decisions.
>
> **Drift check 2026-06-10** (rebased against dev through `246e4d6`): still relevant, no
> conflicting feature. Adjustments folded in below: reservation identity is now
> `reservationKey ?? namespace` (use `sandboxReservationKey()` from `sandbox/utils.ts`);
> a third `internet` touchpoint appeared (`tools/custom-tool-executor.ts`
> `customToolExecutorConfig()`); `SandboxExecutor` grew optional `prewarm`/
> `execInReservedPod` (vercel: prewarm cheap+optional, execInReservedPod skipped — pod-only,
> custom tools are hardcoded to kubernetes); `ephemeralHome` interacts with the `onCreate`
> marker (note in §4-A).

---

## 1. Request

Fold the *new, useful* parts of Vercel Sandbox (persistent sandboxes, tags, snapshots,
drives, firewall) into the existing `filthy-panty` sandbox/workspace system **without**
bloating the `harness-processing` Lambda (cold start / RAM are hard constraints). Keep the
current concept; adopt only what is genuinely missing or better.

## 2. Research conclusion — we already have most of it

The account-scoped **sandbox** (compute) + **workspace** (persistent filesystem) split,
persistent reservation, idle scale-to-0, hard-expiry, and release-on-delete already match
Vercel's two-level model. Mapping:

| Vercel feature | Existing equivalent | Verdict |
| --- | --- | --- |
| **Persistent sandboxes** (auto-snapshot/resume) | `SandboxConfig.persistent` + `instance-store.ts` + `lifecycle` + `release()`; auto-resume via e2b `connect` / daytona `start` / k8s scale `0→1` | **Have it.** No core change. |
| **Lifecycle hooks** (`onCreate`/`onResume`) | none — only static `envVars` | **ADOPT** (§4-A). |
| **Drives** (mounted persistent storage) | the **Workspace** (S3 mount, RO mode, multi-mount, k8s home PVC) | **Have it.** Vercel FS = first non-S3 storage backend (§4-D). |
| **Firewall** (egress control) | coarse only (`internet` bool; daytona block/allow) | **ADOPT egress subset** (§4-B). Creds-brokering / proxying / TLS-termination → skip. |
| **Snapshots** (manual/fork/retention) | daytona `snapshot`; persistence covers "skip setup"; retention ≈ `lifecycle` | **Skip.** |
| **Tags** | `name`/`description` on records | **Skip** (referenced by id). vercel provider still passes its own tags for traceability. |
| **Vercel as compute** (`@vercel/sandbox`) | 4 providers (lambda/e2b/daytona/k8s) | **ADD** 5th provider, lazily imported (§4-C). |

## 3. Cold start / RAM — the real picture (`bun --compile`)

**Measured:** `dist/harness-processing/bootstrap` is **109 MB**; `account-manage` is 98 MB.
node_modules culprits: `@kubernetes/client-node` **57 MB**, `@daytona/sdk` 22 MB, AWS SDK
clients 14–18 MB each, `ai` 7.5 MB, `e2b` 2 MB.

**The build is `bun build --compile`** (one standalone binary per function, Bun runtime
embedded). This changes the lazy-loading math from the usual Node/esbuild assumptions:

- **Lazy `import()` does NOT shrink the binary.** Under `--compile`, every module is
  embedded regardless. So lazy loading gives **no win on the binary-download/extract slice
  of cold start** — and for a 109 MB artifact, that slice is significant.
- **What lazy `import()` *does* buy:** it defers a module's **evaluation** (top-level code:
  AWS SDK client construction, provider-registry building, regex compilation) to first use.
  → lower **init-eval time** and lower **baseline RAM** for requests that never touch that
  module. Real, but the smaller of the two cold-start components.
- **A large fraction of 109 MB is the embedded Bun runtime itself** (fixed `--compile`
  cost), not your deps. Adding `@vercel/sandbox` (a thin HTTP SDK) barely moves the number.

**Therefore — two distinct levers, don't conflate them:**

1. **To cut binary size / download cold start** (the big slice): *don't bundle* rarely-used
   heavy deps into the hot Lambda. Highest-impact candidate: **`@kubernetes/client-node`
   (57 MB node_modules, by far the heaviest)** is only used by the k8s sandbox provider.
   Moving the k8s executor behind its **own Lambda** (invoked over the wire, exactly like the
   existing lambda-sandbox functions) removes it from the harness binary entirely. This is a
   bigger refactor and is **out of scope for this change**, but it is the single biggest
   cold-start lever and is recorded here as the recommended follow-up.
2. **To cut init-eval time / RAM** (the smaller slice): **targeted lazy `import()`** of
   conditional, init-heavy modules. This *is* in scope as the research track. Where it pays:
   - **Sandbox provider SDKs** — defer e2b/daytona/k8s/vercel until a sandbox actually runs.
     Pure-chat requests (no sandbox) then never evaluate any provider SDK. **Best ROI.**
   - **Channel adapters** — `integrations.ts` statically imports all six (discord, github,
     pancake, slack, telegram, zalo); an inbound webhook matches exactly **one**. Lazy-load
     the matched adapter; defer the other five.
   - **Conditional AWS clients** — `ssm` (k8s-kubeconfig only), `lambda` (sandbox-invoke
     only). Defer; keep `dynamodb` eager (always used).
   - **Not worth it:** core path (runtime, handler, integrations router, session, harness
     loop, storage factory, active model provider) — used every request; lazy-loading only
     adds a first-call penalty.

**Expectation to set:** targeted lazy-loading lowers RAM and the eval-slice of cold start;
it will **not** shrink the 109 MB artifact. For that, do lever #1 (split out k8s) or use
**provisioned concurrency** (Lambda **SnapStart is not available for `provided.al2023`
custom runtimes**, so it's not an option here). **Measure init duration in CloudWatch
before/after** — don't assume magnitudes.

**Recommended sequencing:** ship §4 (hooks + network + vercel provider, with the vercel SDK
lazily imported) first; do the channel-adapter + provider-SDK lazy-import pass as a second,
isolated change with before/after init-duration numbers; treat "split k8s into its own
Lambda" as a separate proposal.

## 4. Design

### 4-A. Lifecycle hooks — `onCreate` / `onResume`

Command lists (not JS — config is JSON in the store), persistent-only:

```ts
interface SandboxConfig {
  onCreate?: string[];   // run ONCE on first create of a reserved sandbox (clone, install)
  onResume?: string[];   // run on EVERY reconnect (restart services, rehydrate caches)
}
```

(Extensible later to `{ cmd, cwd?, env? }[]` if per-command context is needed; start with
plain string commands.)

- **Validation** (`storage/sandbox-config.ts`): non-empty array of non-empty strings; both
  require `persistent: true` (mirror the `lifecycle` guard). Not secret.
- **Native support reality** (researched): **only Vercel** has true per-call lifecycle
  callbacks (`getOrCreate({ onCreate, onResume })`). **e2b and daytona have no callback
  hooks** — their native "setup" path is baking into a **template** (e2b `start_cmd`) /
  **snapshot** (daytona Dockerfile), plus running commands after create via the SDK. So:
  - **vercel** → use native `getOrCreate({ onCreate, onResume })`.
  - **e2b / daytona / kubernetes** → run the command lists ourselves through each executor's
    existing shell path: `onResume` on every successful reconnect; `onCreate` only on a
    fresh create, guarded by an idempotency marker `<workDir>/.fp-setup-done`.
    *`ephemeralHome` caveat:* with `ephemeralHome: true` (no durable home PVC) the marker
    does not survive scale-to-0, so `onCreate` re-runs on each resume. `ephemeralHome` is
    runtime-only (`SandboxExecutorConfig`), not settable from account config, and its only
    setter (the hardcoded custom-tool config) has no hooks — so no validation rule; add a
    code comment at `customToolExecutorConfig()` noting the constraint.
  - **lambda** → N/A (ephemeral; hooks require `persistent`, which lambda can't set).
- **Threading**: add `onCreate?`/`onResume?` to `SandboxExecutorConfig` (`sandbox/types.ts`)
  and populate at the `SandboxConfig → SandboxExecutorConfig` build sites.

### 4-B. Normalized network policy (egress)

Needs **both** domain and CIDR allowlists (Vercel does both; daytona is IP/CIDR; k8s
NetworkPolicy is IP/CIDR):

```ts
interface SandboxConfig {
  // REPLACES the old `internet?: boolean` (removed — see D2). Optional; when unset,
  // normalize defaults it to { mode: "deny-all" } — secure by default (D5).
  network?: {
    mode: "allow-all" | "deny-all" | "restricted";
    allowDomains?: string[];   // restricted only
    allowCidrs?: string[];     // restricted only
  };
}
```

> **Default-behavior note (D5 = deny-all):** unset `network` normalizes to `deny-all`.
> For lambda this matches the old implicit-off behavior exactly. For e2b/daytona/k8s it is
> an intentional tightening: a sandbox that installs packages (pip/npm) must now state
> `network: { mode: "allow-all" }` explicitly. Existing dev-stage records get this field
> added during the record update (see the removal bullet below). The hardcoded
> `customToolExecutorConfig()` sets `network: { mode: "allow-all" }` explicitly (it needs
> npm install + the HTTP result callback).

- **Per-provider mapping** (researched):

  | provider | native? | allow-all | deny-all | restricted |
  | --- | --- | --- | --- | --- |
  | **vercel** | ✅ | `networkPolicy:"allow-all"` | `"deny-all"` | `{ allow:[...domains], ipRanges }` |
  | **daytona** | ✅ (IP/CIDR) | `networkBlockAll:false` | `networkBlockAll:true` | `networkAllowList: allowCidrs.join(",")` (domains unsupported → ignored + warn) |
  | **kubernetes** | ✅ via **NetworkPolicy** CRD | no policy | empty-egress policy | egress `ipBlock` per CIDR; **domains need Cilium `toFQDNs`/proxy → out of scope** |
  | **lambda** | ⚙️ slots | net-on fn | net-off fn | net-off fn (fail closed — see note below) |
  | **e2b** | ❌ none | allowed | **validation-rejected** | **validation-rejected** |

- **Lambda = slot selection only, no infra change.** The 4 deployed slots are shared across
  all accounts; net-off is enforced by the deploy-time `SandboxNoNetSecurityGroup` (egress =
  NFS-only) in the sandbox VPC (fck-nat on non-prod). Per-sandbox-config domain/CIDR
  allowlists cannot be expressed in a shared security group, so `restricted` picks the
  **net-off slot** (fail closed) and the executor logs a warning that the allowlists are not
  enforceable on lambda. The `../lambda-sanbdox` runtime and `sst.config.ts` are untouched.
- **e2b has no SDK egress control at all**, so `deny-all`/`restricted` would be silent lies.
  `normalizeSandboxConfig` rejects them for provider e2b with a clear error ("e2b cannot
  enforce egress restrictions; set network.mode to 'allow-all' explicitly"). Combined with
  the deny-all default, every e2b config must therefore state `allow-all` explicitly —
  honest secure-by-default.

- **Kubernetes = native `NetworkPolicy`, NOT OPA.** OPA/Gatekeeper is an *admission
  controller* (validates the K8s API request at create time); it does not filter runtime
  egress. Apply a `NetworkPolicy` object next to the Sandbox: deny-all = policyTypes:[Egress]
  with empty `egress`; restricted = `egress.to.ipBlock.cidr` per CIDR. Domain-based egress
  requires an FQDN-aware CNI (Cilium) or egress proxy — deferred.
  **Pre-implementation check:** the cluster is k3s, which enforces `NetworkPolicy` via its
  embedded kube-router controller *unless* started with `--disable-network-policy` — verify
  that flag is absent in `../infra` before relying on enforcement (execution step E1).
- **`internet` removal (D2 = hard-replace)**: delete `internet` from `SandboxConfig`,
  `SandboxExecutorConfig`, the lambda/daytona executor reads, and all tests. Three concrete
  touchpoints beyond validation:
  - `lambda-executor.ts` `#functionName(...)` currently reads `this.#config.internet === true`
    to choose the net-on/off slot → switch to `network.mode` (`allow-all` ⇒ net-on; anything
    else ⇒ net-off).
  - **`functions/_shared/workspaces.ts`** builds the read-only `readMount` as
    `{ provider: "lambda", internet: false }` (one literal, ~line 114) → change to
    `{ provider: "lambda", network: { mode: "deny-all" } }`.
  - **`functions/harness-processing/tools/custom-tool-executor.ts`**
    `customToolExecutorConfig()` sets `internet: true` (~line 521) →
    `network: { mode: "allow-all" }`.
  - **Record update (no legacy compat — the repo is pre-release)**: no shim, no backfill
    code. Existing dev-stage `sandboxConfigs` records are updated **directly in DynamoDB and
    Convex** as a deploy step: remove `internet`, add `network: { mode: "allow-all" }` where
    the old behavior was internet-on (and to e2b records, which now require it explicitly).

### 4-C. The `vercel` provider executor

New `functions/harness-processing/sandbox/vercel-executor.ts` implementing `SandboxExecutor`,
mirroring the e2b structure.

- **Auth** (off-Vercel ⇒ no OIDC): `config.options.{token,teamId,projectId}` (token is
  secret-shaped ⇒ already redacted), env fallback `VERCEL_TOKEN/TEAM_ID/PROJECT_ID`.
- **runtime**: `config.options.runtime` (`"node24"` default) → SDK `runtime`.
- **Ephemeral** (no namespace): `Sandbox.create({ ...auth, runtime, timeout, networkPolicy,
  env, persistent:false })` → `runCommand({ cmd:"bash", args:["-lc", code], cwd, env })` →
  adapt → `stop()` in `finally`.
- **Persistent**: reservation identity is **`sandboxReservationKey(request)`**
  (`sandbox/utils.ts` — resolves `request.reservationKey ?? request.namespace`; this
  replaced the old namespace-only keying). Reserve one sandbox per key via the
  **`instance-store`** pattern (`getSandboxExternalId("vercel", key)` → `Sandbox.get({ name })`
  to resume, else `getOrCreate({ name, onCreate, onResume })` then `claimSandboxInstance`,
  loser deletes its sandbox — mirror e2b's `#acquire`). Sandbox `name` = slug of the key.
- **Result adapter**: SDK `CommandFinished` has `.exitCode:number` and **async**
  `.stdout()`/`.stderr()` — await + truncate to `outputLimitBytes`, `ok = exitCode===0`,
  `provider:"vercel"`.
- **`release`**: signature is `release({ namespace?, reservationKey? })` (current
  `SandboxExecutor` contract) — `Sandbox.get({name}).delete()` (ignore gone errors) +
  `deleteSandboxInstance("vercel", sandboxReservationKey(request))`.
- **Background jobs (D3 = include in v1)**: implement `runBackground`/`jobStatus`/`jobLogs`/
  `stopJob`, reusing the provider-agnostic `jobs.ts` scripts (`launchScript`/`statusScript`/
  `logsScript`/`stopScript`) exactly like the e2b executor. Persistent-only: require a
  reservation (key or namespace); jobs dir under the reservation workDir (`.fp-jobs`), marker
  files on the sandbox's own persistent disk. The detached process is launched via
  `runCommand` of the launch script; status/logs/stop are `runCommand` of the respective
  scripts. Mirror e2b's `#jobContext` (reconnect by stored name, derive jobsDir).
- **Optional capabilities (new since the original draft)**: the `SandboxExecutor` interface
  now also has optional `prewarm` and `execInReservedPod`.
  - `prewarm` — cheap for vercel (`getOrCreate` + claim, then return); implement it so the
    executor stays at parity with e2b/daytona/k8s. Today it is only invoked by the
    custom-tool path, which is hardcoded to kubernetes, so it's parity, not a requirement.
  - `execInReservedPod` — **skip**. It is the pod-level streaming channel for the resident
    in-pod tool worker (k8s-only; e2b/daytona don't implement it either, and the contract
    says "absent for non-pod providers"). Account-uploaded custom tools therefore never run
    on vercel — `customToolExecutorConfig()` pins `provider: "kubernetes"`. No conflict.
- **Lazy import**: `import type { Sandbox } from "@vercel/sandbox"` at top; value via
  `await import("@vercel/sandbox")` inside methods (§3 — defers eval, not size).

### 4-D. Workspace storage backends (the "Vercel FS" caveat, reframed)

A vercel-backed workspace stores files in **Vercel's persistent FS**, not S3 — it doesn't
`mount-s3`. This is the **first non-S3 storage backend**, matching the roadmap (Google
Drive, GCS, Azure, Cloudflare R2, arbitrary S3-compatible). So:

- Grow `WorkspaceConfig.storage.provider` from `"s3"`-only to an **open enum** now:
  `"s3" | "vercel"` (+ future `gdrive | gcs | azure | r2 | s3-compatible`).
- A `storage.provider:"vercel"` workspace is self-contained on Vercel: read/glob/grep/edit
  run through the sandbox bash (always present), not the S3 `readMount`; not shared with
  other-provider sandboxes; not served by S3-direct reads. **Documented, intentional.**
- The full multi-backend **mount abstraction** (a `WorkspaceStorageAdapter` interface) is a
  later workstream; this change only opens the enum and wires the vercel case.

## 5. Out of scope

Credentials brokering, request proxying, TLS termination, manual snapshots / forking,
tags-as-a-feature, mounting S3 inside the Vercel VM, k8s FQDN egress, **splitting the k8s
executor into its own Lambda** (recorded as the top cold-start follow-up in §3), and the
full `WorkspaceStorageAdapter` abstraction.

## 6. Execution steps (ordered)

**E1 — Pre-checks.**
- In `../infra`, verify the k3s server is NOT started with `--disable-network-policy`
  (kube-router is the embedded NetworkPolicy enforcer). If it is disabled, re-enable it
  there first; the k8s `network` mapping depends on it.
- Vercel credentials (needed for E14's live dry-test; unit tests mock the SDK): a Vercel
  account/team (`teamId`), a project in it — an empty one is fine, sandboxes are
  project-scoped (`projectId`) — and an access token from Account Settings → Tokens
  (`token`). The Hobby plan includes a Sandbox usage allotment, so dry-testing needs no
  paid plan. These land in the sandbox config `options.{token,teamId,projectId}`
  (encrypted) with `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` env fallback.

**E2 — Config + validation** (`functions/_shared/storage/sandbox-config.ts`):
add `"vercel"` to the provider union + `SANDBOX_PROVIDERS`; add `onCreate`/`onResume`
(non-empty string arrays, require `persistent: true`, mirror the `lifecycle` guard); add
`network` (default `{ mode: "deny-all" }` when unset; `allowDomains`/`allowCidrs` only valid
with `mode: "restricted"`; reject `deny-all`/`restricted` for provider e2b); **delete
`internet`** (field, assertion, normalize spread); allow vercel `options` keys
(`token`/`teamId`/`projectId`/`runtime`); confirm `token` falls under the existing
secret-shape redaction.

**E3 — Remaining `internet` deletions:**
- `functions/harness-processing/sandbox/types.ts` — remove `internet?`; add
  `onCreate?`/`onResume?`/`network?` to `SandboxExecutorConfig`; add `"vercel"` to
  `SandboxProvider`.
- `functions/_shared/workspaces.ts` — `readMount` literal (~line 114) →
  `{ provider: "lambda", network: { mode: "deny-all" } }`.
- `functions/harness-processing/tools/custom-tool-executor.ts` —
  `customToolExecutorConfig()` `internet: true` → `network: { mode: "allow-all" }`, plus the
  `ephemeralHome`+`onCreate` code comment (§4-A).
- `sandbox/lambda-executor.ts` — `#functionName` picks the slot from `network.mode`
  (`allow-all` ⇒ net-on; `deny-all`/`restricted` ⇒ net-off, warn-log when `restricted`
  carries allowlists); drop the `internet` read.

**E4 — Hooks + network in existing executors**
(`sandbox/{e2b,daytona,kubernetes}-executor.ts`): run `onResume` on every successful
reconnect and `onCreate` on fresh create guarded by `<workDir>/.fp-setup-done`, through each
executor's existing shell path; map `network` — daytona `networkBlockAll`/`networkAllowList`
(CIDRs, warn on domains), kubernetes `NetworkPolicy` object next to the Sandbox CR, e2b
nothing at runtime (validation already restricted it to `allow-all`).

**E5 — Workspace storage enum** (`functions/_shared/storage/workspace-config.ts`):
open `storage.provider` to `"s3" | "vercel"` (§4-D).

**E6 — Vercel executor** (`functions/harness-processing/sandbox/vercel-executor.ts`, new):
implement §4-C exactly — `sandboxReservationKey()` identity, instance-store claim/reconnect,
native `getOrCreate({onCreate,onResume})`, `CommandFinished` async-stdout adapter,
background jobs via `jobs.ts`, `prewarm`, `release`, lazy `await import("@vercel/sandbox")`;
register the branch in `sandbox/index.ts`; add `@vercel/sandbox` to `package.json` and
verify `bun run build` (ARM64 `--compile`) succeeds.

**E7 — Cleanup** (`functions/account-manage/cleanup.ts`): add `"vercel"` to the
persistent-provider iteration in `releaseReservedSandboxes` /
`releaseSandboxConfigInstances` / `releaseFromConfigs`.

**E8 — Mapping sites** (`tools/filesystem-utils.ts`, `tools/bash.tool.ts`,
`tools/async-status.tool.ts`, `tools/custom-tool-executor.ts`): ensure
`onCreate`/`onResume`/`network` flow from `SandboxConfig` into `SandboxExecutorConfig` at
every build site (fix any field-by-field site to carry the new fields).

**E9 — Tests** (`tests/`): sandbox-config validation (deny-all default; e2b rejection of
non-allow-all; allowlists-require-restricted; hooks-require-persistent; `internet` now
rejected as unknown); vercel-executor unit test mocking `@vercel/sandbox` (focus the
async-stdout adapter and the create-vs-resume hook paths); update every existing test that
sets `internet`.

**E10 — Docs** (focused, diagrams/tables): `docs/workspace/sandbox/index.md` (network +
hooks tables, provider diagram update), new `docs/workspace/sandbox/vercel.md` (auth, FS
caveat, jobs), `docs/api-reference/openapi.yaml` (`onCreate`/`onResume`/`network` schema,
provider enum, workspace storage enum).

**E11 — Examples** (`examples/`, mirror the `sandbox-e2b.ts` shape — account → sandbox →
agent → `streamSSE` real model inference → cleanup):
- New `examples/sandbox-vercel.ts` — vercel provider end-to-end: persistent sandbox with
  `onCreate`/`onResume` (assert the hook side-effects are visible from bash) and
  `network: { mode: "restricted", allowDomains: [...] }`, auth via
  `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` env, plus one background job
  launch/status round-trip.
- Update existing sandbox examples (`sandbox-e2b.ts`, `sandbox-workspace-daytona.ts`,
  `sandbox-{kubernetes,persistent-kubernetes,workspace-kubernetes}*.ts`,
  `sandbox-workspace-lambda.ts`, `sandbox-stateless.ts`, `workspace-sandbox-override.ts`)
  to set `network: { mode: "allow-all" }` explicitly — required for e2b (validation) and
  for any example that installs packages (deny-all default).

**E12 — Local verification gates** (before push, in order): `bun run check` (tsc),
`bun test` (the repo has no separate lint script — `check` + `test` are the gates), then
`bun run build` to confirm the ARM64 `--compile` binaries still build with
`@vercel/sandbox` embedded.

**E13 — Record update (deploy step, dev stage only).** Update existing `sandboxConfigs`
records directly in DynamoDB and Convex: remove `internet`; add
`network: { mode: "allow-all" }` to records that had `internet: true` and to all e2b
records; leave the rest to the deny-all default.

**E14 — Post-deploy live dry-test.** After CI/CD finishes (`gh run list` / `gh run view`
to confirm the pipeline is green and the dev stage deployed), run the example scripts
against the deployed stack with real model inference: `examples/sandbox-vercel.ts` (new
behavior), plus `examples/sandbox-workspace-lambda.ts` and one kubernetes example to
confirm the `network` slot/NetworkPolicy mapping didn't regress existing providers.

**Separate follow-up (not in this change):** the lazy-import pass — dynamic `import()` for
`sandbox/index.ts` provider selection, `integrations.ts` channel selection, and the
`ssm`/`lambda` AWS clients, with before/after CloudWatch init-duration numbers (§3).

## 7. Decisions (all resolved — no open items)

- **D1 — hook naming**: ✅ `onCreate` / `onResume` (Vercel parity).
- **D2 — `internet` field**: ✅ **hard-replace** with `network`; no shim, no backfill code —
  dev-stage records updated directly in DynamoDB + Convex (E13).
- **D3 — vercel background jobs**: ✅ **include in v1** via the shared `jobs.ts` scripts (§4-C).
- **D4 — lazy-load pass**: ✅ **separate follow-up** with before/after CloudWatch
  init-duration numbers; this change ships only with the vercel SDK lazily imported.
- **D5 — `network` default**: ✅ **`deny-all`** (secure by default). Matches lambda's old
  implicit-off; tightens e2b/daytona/k8s (E13 adds explicit `allow-all` where needed).
- **D6 — legacy compat**: ✅ **none** — pre-release repo; direct record update (E13).
- **D7 — lambda `restricted`**: ✅ **net-off slot, fail closed** + warn log. No changes to
  the `../lambda-sanbdox` runtime, `sst.config.ts`, or the shared security groups.
- **D8 — e2b non-allow-all**: ✅ **validation-rejected** (e2b has no egress control; a
  silent no-op would misrepresent the policy).

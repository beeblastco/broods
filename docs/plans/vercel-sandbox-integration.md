# Vercel Sandbox Integration — Plan & Research

> Status: **planned** (not started). Confirmed scope: **(1)** adopt two provider-agnostic
> concepts — *lifecycle hooks* (`onCreate`/`onResume`) and a *normalized network policy* —
> **(2)** add a 5th `vercel` provider backed by `@vercel/sandbox`, **lazily imported**, and
> **(3)** a separate research track on **targeted lazy-loading** to reduce harness cold
> start / RAM (analysis in §3 — read it; the conclusion is counter-intuitive because of the
> `bun --compile` build).
>
> **Decisions locked (§7):** hooks named `onCreate`/`onResume`; **hard-replace** the
> `internet` boolean with `network` (no back-compat shim — migrate); **vercel background
> jobs ship in v1**; the lazy-import pass is a **separate follow-up** with its own cold-start
> measurement.
>
> Read §2 for the feature mapping, §3 for the cold-start truth, §4 for the design, §6 for
> the change list, §7 for the resolved decisions.

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
  - **lambda** → N/A (ephemeral; hooks require `persistent`, which lambda can't set).
- **Threading**: add `onCreate?`/`onResume?` to `SandboxExecutorConfig` (`sandbox/types.ts`)
  and populate at the `SandboxConfig → SandboxExecutorConfig` build sites.

### 4-B. Normalized network policy (egress)

Needs **both** domain and CIDR allowlists (Vercel does both; daytona is IP/CIDR; k8s
NetworkPolicy is IP/CIDR):

```ts
interface SandboxConfig {
  // REPLACES the old `internet?: boolean` (removed — see D2). Optional; when unset,
  // normalize defaults it to { mode: "allow-all" } so behavior is uniform across providers.
  network?: {
    mode: "allow-all" | "deny-all" | "restricted";
    allowDomains?: string[];   // restricted only
    allowCidrs?: string[];     // restricted only
  };
}
```

> **Default-behavior note:** the lambda provider previously treated *unset* `internet` as
> **off** (net-off slot). With `network` defaulting to `allow-all`, a lambda sandbox that
> relied on the implicit-off must now set `network: { mode: "deny-all" }` explicitly. This
> is the one intentional behavior change from the hard-replace; call it out in the migration
> note and docs.

- **Per-provider mapping** (researched):

  | provider | native? | allow-all | deny-all | restricted |
  | --- | --- | --- | --- | --- |
  | **vercel** | ✅ | `networkPolicy:"allow-all"` | `"deny-all"` | `{ allow:[...domains], ipRanges }` |
  | **daytona** | ✅ (IP/CIDR) | `networkBlockAll:false` | `networkBlockAll:true` | `networkAllowList: allowCidrs.join(",")` (domains unsupported → ignored + warn) |
  | **kubernetes** | ✅ via **NetworkPolicy** CRD | no policy | empty-egress policy | egress `ipBlock` per CIDR; **domains need Cilium `toFQDNs`/proxy → out of scope** |
  | **lambda** | ⚙️ slots | net-on fn | net-off fn | net-off fn (no per-domain filtering; documented) |
  | **e2b** | ❌ none | — | — | documented no-op |

- **Kubernetes = native `NetworkPolicy`, NOT OPA.** OPA/Gatekeeper is an *admission
  controller* (validates the K8s API request at create time); it does not filter runtime
  egress. Apply a `NetworkPolicy` object next to the Sandbox: deny-all = policyTypes:[Egress]
  with empty `egress`; restricted = `egress.to.ipBlock.cidr` per CIDR. Domain-based egress
  requires an FQDN-aware CNI (Cilium) or egress proxy — deferred.
- **`internet` removal (D2 = hard-replace)**: delete `internet` from `SandboxConfig`,
  `SandboxExecutorConfig`, the lambda/daytona executor reads, and all tests. Two concrete
  touchpoints beyond validation:
  - `lambda-executor.ts` `#functionName(...)` currently reads `this.#config.internet === true`
    to choose the net-on/off slot → switch to `network.mode` (`allow-all` ⇒ net-on; anything
    else ⇒ net-off).
  - **`functions/_shared/workspaces.ts`** builds the read-only `readMount` as
    `{ provider: "lambda", internet: false }` (two spots) → change to
    `{ provider: "lambda", network: { mode: "deny-all" } }`.
  - **Migration**: existing stored sandbox records still carry `internet` (records are
    persisted post-normalize, not re-normalized on read). Add a one-time backfill (or a
    read-time shim in the store's `getById/list`) that maps a legacy `internet` to `network`
    so old records keep working after the field is dropped. Note this in the change list.

### 4-C. The `vercel` provider executor

New `functions/harness-processing/sandbox/vercel-executor.ts` implementing `SandboxExecutor`,
mirroring the e2b structure.

- **Auth** (off-Vercel ⇒ no OIDC): `config.options.{token,teamId,projectId}` (token is
  secret-shaped ⇒ already redacted), env fallback `VERCEL_TOKEN/TEAM_ID/PROJECT_ID`.
- **runtime**: `config.options.runtime` (`"node24"` default) → SDK `runtime`.
- **Ephemeral** (no namespace): `Sandbox.create({ ...auth, runtime, timeout, networkPolicy,
  env, persistent:false })` → `runCommand({ cmd:"bash", args:["-lc", code], cwd, env })` →
  adapt → `stop()` in `finally`.
- **Persistent** (namespace): reserve one sandbox per namespace via the **`instance-store`**
  pattern (`getSandboxExternalId("vercel", ns)` → `Sandbox.get({ name })` to resume, else
  `getOrCreate({ name, onCreate, onResume })` then `claimSandboxInstance`). Sandbox `name` =
  slug of the namespace.
- **Result adapter**: SDK `CommandFinished` has `.exitCode:number` and **async**
  `.stdout()`/`.stderr()` — await + truncate to `outputLimitBytes`, `ok = exitCode===0`,
  `provider:"vercel"`.
- **`release`**: `Sandbox.get({name}).delete()` (ignore gone errors) +
  `deleteSandboxInstance("vercel", ns)`.
- **Background jobs (D3 = include in v1)**: implement `runBackground`/`jobStatus`/`jobLogs`/
  `stopJob`, reusing the provider-agnostic `jobs.ts` scripts (`launchScript`/`statusScript`/
  `logsScript`/`stopScript`) exactly like the e2b executor. Persistent-only: require a
  reserved sandbox + namespace; jobs dir under the namespace workDir (`.fp-jobs`), marker
  files on the sandbox's own persistent disk. The detached process is launched via
  `runCommand` of the launch script; status/logs/stop are `runCommand` of the respective
  scripts. Mirror e2b's `#jobContext` (reconnect by stored name, derive jobsDir).
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

## 6. Change list (file by file)

**Config + validation**

- `functions/_shared/storage/sandbox-config.ts` — add `"vercel"` to provider union +
  `SANDBOX_PROVIDERS`; add `onCreate`/`onResume` (require `persistent`) + `network`
  (`allowDomains`/`allowCidrs` require `mode:"restricted"`, default `{mode:"allow-all"}`);
  **remove `internet`**; allow vercel `options` keys (`token`/`teamId`/`projectId`/`runtime`);
  verify `token` redaction.
- `functions/_shared/storage/workspace-config.ts` — open `storage.provider` enum to include
  `"vercel"` (§4-D).
- **`functions/_shared/workspaces.ts`** — change both read-only `readMount` literals from
  `{ provider:"lambda", internet:false }` to `{ provider:"lambda", network:{mode:"deny-all"} }`.
- **Migration** — one-time backfill (or read-time shim in the dynamo/convex
  `sandboxConfigs.getById/list`) mapping any legacy persisted `internet` → `network`, since
  stored records aren't re-normalized on read.

**Executor layer**

- `functions/harness-processing/sandbox/types.ts` — `"vercel"` in `SandboxProvider`; add
  `onCreate?`/`onResume?`/`network?` to `SandboxExecutorConfig`; **remove `internet?`**.
- `functions/harness-processing/sandbox/index.ts` — register vercel branch + `SANDBOX_PROVIDERS`.
- `functions/harness-processing/sandbox/vercel-executor.ts` — **new** (§4-C).
- `sandbox/{e2b,daytona,kubernetes}-executor.ts` — run `onCreate`/`onResume` in the
  create/reconnect branches (marker-guarded); map `network` (daytona allowlist;
  k8s NetworkPolicy; e2b no-op).
- `sandbox/lambda-executor.ts` — pick net-on/off slot from `network.mode` (`allow-all` ⇒
  net-on; else net-off); drop the `internet` read.

**Cleanup**

- `functions/account-manage/cleanup.ts` — add `"vercel"` to the persistent-provider
  iteration in `releaseReservedSandboxes` / `releaseSandboxConfigInstances` / `releaseFromConfigs`.

**Mapping sites** (carry new fields `SandboxConfig → SandboxExecutorConfig`):
`tools/filesystem-utils.ts`, `tools/bash.tool.ts`, `tools/async-status.tool.ts`,
`tools/custom-tool-executor.ts` — confirm spread vs field-by-field.

**Dependency**: `package.json` add `@vercel/sandbox`; verify Bun ARM64 `--compile` build.

**Docs** (focused, diagrams/tables): `docs/workspace/sandbox/index.md` (network + hooks
tables, provider diagram), new `docs/workspace/sandbox/vercel.md` (auth + FS caveat),
`docs/api-reference/openapi.yaml` (schema: `onCreate`/`onResume`/`network`, provider enum,
workspace storage enum).

**Tests**: `tests/` — `sandbox-config` validation (network incl. `internet` handling per D2;
hooks-require-persistent; vercel provider enum); vercel-executor unit test mocking
`@vercel/sandbox` (focus the async-stdout adapter).

**Lazy-load research track (separate change):** convert `sandbox/index.ts` provider
selection and `integrations.ts` channel selection to dynamic `import()`; lazy `ssm`/`lambda`
AWS clients; capture before/after init duration.

## 7. Decisions (resolved)

- **D1 — hook naming**: ✅ `onCreate` / `onResume` (Vercel parity).
- **D2 — `internet` field**: ✅ **hard-replace** with `network` (no back-compat shim).
  Remove the field everywhere; add a one-time migration for legacy persisted records; accept
  the lambda default-behavior change (see the note in §4-B).
- **D3 — vercel background jobs**: ✅ **include in v1** via the shared `jobs.ts` scripts (§4-C).
- **D4 — lazy-load pass**: ✅ **separate follow-up** with before/after CloudWatch
  init-duration numbers; this change ships only with the vercel SDK lazily imported.

### Minor open item (not blocking)

- **`network` default mode**: plan currently defaults unset `network` to `allow-all` for
  cross-provider uniformity, which flips the lambda provider's historical implicit-off. If
  "secure by default" is preferred, default to `deny-all` instead — decide at implementation
  time (one line in `normalizeSandboxConfig`).

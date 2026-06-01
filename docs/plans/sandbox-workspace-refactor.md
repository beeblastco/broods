# Sandbox / Workspace Refactor — Implementation Plan

> Status: **implemented + refined** (workstreams A–I landed on `dev`; build + typecheck +
> **484 tests** green; not yet deployed). The Convex submodule adapter is updated on the
> filthy-panty side, and the matching backend now exists in the `convex/` deployment
> submodule: the `sandboxConfigs` + `workspaceConfigs` tables (`convex/schema.ts`, both with a
> `by_accountId` index), their internal `getById/list/create/update/remove` modules
> (`convex/{sandboxConfigs,workspaceConfigs}.ts`, mirroring `convex/agents.ts`), the
> account/org teardown cascade (`convex/accounts.ts`, `convex/org.ts`), and the regenerated
> `_generated/api.d.ts`. **`convex codegen` pushed these to the `dev:` Convex deployment;** a
> prod deploy of the `convex/` submodule is still required in lockstep before flipping
> filthy-panty prod to `STORAGE_PROVIDER=convex` (R3).
> This document captures the original request, all interview decisions, the target
> architecture, and the concrete change list with code locations.
>
> **A series of post-implementation refinements landed after A–I** (provider-aware sandbox
> limits, Claude-Code-style tool descriptions, read-only-S3 routing confirmation, and a
> skill-staging simplification that removed the dead publish-round-trip machinery). They are
> documented as a dated changelog in **§9 — read that section first for the current state of
> those subsystems; it supersedes the original notes in §B, §D, §G, and R7.**
>
> **Follow-up (per-workspace sandbox + read-only S3):** the single agent-level `sandbox`
> is now a *default*. Each `workspaces[]` entry takes an optional `sandbox` id that
> overrides it for that workspace (and its `permissionMode`), so one agent can give
> different workspaces different sandboxes, and agents sharing a workspace can access it
> through their own sandboxes. The cascade is `ws.sandbox(null⇒read-only | id⇒override) ??
> config.sandbox`; a workspace with no effective sandbox is **read-only** (`read`/`glob`
> served directly from S3, no mount/Lambda), and `"sandbox": null` forces read-only even
> when an agent-level default exists. Each sandbox tool sets a
> per-call `needsApproval` function (function-form, AI SDK v6) resolved from the selected
> workspace. See `docs/workspace/index.md` for the current tool-surface matrix.

---

## 1. Background & motivation

`filthy-panty` is an agentic AI chatbot on AWS (Lambda + Vercel AI SDK + multi-channel
integrations, deployed with SST). Two new sibling repos now exist:

- **`~/Workspace/projects/lambda-just-bash-rust`** — a Rust-based AWS Lambda custom
  runtime ("Lambda Agent Sandbox") that executes `bash` / `python` / `node` in an
  isolated workspace. Real bash + native `python3` + Node 22 + `uv` are all installed
  in **one** container image. It acts as a VM-like computer for the agent.
- **`~/Workspace/projects/infra`** — company infra (k3s cluster + Terraform). It owns
  the **ECR repo** `beeblast-lambda-sandbox-${ACCOUNT_ID}-${REGION}` (currently in
  `eu-central-1`, account `403012596812`) that hosts the sandbox image, defined in
  `terraform/aws/main.tf:361` (`aws_ecr_repository.lambda_sandbox`) with a public-read
  policy block at `main.tf:370` so the image can be pulled once `filthy-panty` is
  open-sourced.

**Goal:** retire the legacy split-runtime sandbox model in `filthy-panty` and replace
it with a single, uniform sandbox built on the new image, while restructuring config so
that **sandbox** and **workspace** become independent, account-scoped, reusable resources.

### Why the current code has `runShell` / `runFile` / `readDirectory`

The current executor interface (`functions/harness-processing/sandbox/types.ts:97-104`)
has three methods. All three are artifacts of the **old** split-runtime Lambda, not
anything intrinsic to a sandbox:

- **`runShell`** (`lambda-executor.ts:60`) — the real "run a bash command" path. The only
  method that maps to what the agent actually does.
- **`runFile`** (`lambda-executor.ts:31`) — exists only because the old design assumed an
  **emulated WASM bash** for shell plus a **separate native-CPython Lambda** for Python.
  `filesystem.tool.ts:127-159` parses commands, detects `python3 foo.py`, and routes it to
  `runFile` → the dedicated `SandboxPython` function for "real" CPython. This is the
  "quirky" routing. It also drives the lambda-only caveats in the tool description at
  `filesystem.tool.ts:107-112` ("python inside bash runs on slower WASM", "`node -e` not
  supported", etc.).
- **`readDirectory`** (`lambda-executor.ts:82`) — not a runtime concern at all. It is a
  workaround for **S3 Files eventual consistency**: agent edits through the mount take
  ~1–2 min to become listable via the S3 API, so `publishSkillFromWorkspace`
  (`session.ts:388-425`) reads the working copy straight off the mount via a Python
  `os.walk` that base64-emits files. Only the skill-publish path uses it.

With the new uniform image (real bash + native python3 + node all on PATH), the split is
gone. In fact `SandboxBash` and `SandboxPython` in `sst.config.ts:551,574` **already point
at the same image** (`sandboxImageUri`, line 549); the two functions and the routing
survive only out of inertia. The whole interface collapses to a single `run`.

---

## 2. Final decisions (locked)

These were settled during the design interview and are authoritative.

### Sandbox model

1. **Collapse** the two Lambda functions (`SandboxBash` + `SandboxPython`) into the new
   uniform sandbox. **Keep** the alternative providers `e2b`, `daytona`, `kubernetes`.
2. **One `run`** method replaces `runShell` + `runFile`. Provider selection stays.
3. **Drop `readDirectory`** from the shared executor interface entirely. It was lambda-only
   and complicated the multi-provider contract; re-add later if a provider needs it.
4. Sandbox is a **standalone, account-scoped resource**. An agent references a sandbox by
   id. Different agents can reuse the same sandbox config.
5. The new lambda image is used with: **ARM64**, **512 MB** memory, **5 min** timeout, in
   a **VPC**, with the ability to **mount the S3 workspace bucket**.

### Workspace model

1. **Workspace is a separate, account-scoped resource**, saved in its own table; the
   record id **is** the config id (`workspaceId`). It is **mounted into** the sandbox.
2. **Shared semantics:** when agent A and agent B both reference `workspaceId = X`, they
   read/write the **same files** (true shared workspace — collaborative memory/tasks/files).
3. Workspace `storage` config has **only** `provider` (only `s3` supported now).
4. An agent **can reference a workspace without a sandbox** — in that case it interacts via
   the **S3 API directly** (no compute; memory/tasks served from S3).

### Persistence & tool availability

1. **No workspace ⇒ no cross-call persistence.** Each bash call is a fresh ephemeral
    container. Therefore, when no workspace is attached, **only stateless tools are
    exposed** — effectively **`bash` only** (the agent writes+runs inside a single
    command). Write/Edit/Read/Glob/Grep all assume persistent files and are **auto-disabled**.
2. **Workspace attached ⇒ full tool set** operating on the mounted workspace.
3. This is intentionally a **developer/AI-engineer design decision**, to be documented
    so whoever configures an agent understands the trade-off (no workspace = stateless,
    faster, no persisted output).

### Tools (Claude-Code-style surface)

1. Sandbox is a **collection of tools**. Implement the full
    filesystem/computer/bash surface: **`bash`, `read`, `write`, `edit`, `glob`, `grep`**.
    Each lives in its own `*.tool.ts`. The model-facing **`bash` tool keeps the name
    `bash`** (models are trained on it).
2. `needsApproval` (boolean) is replaced by **`permissionMode`** with values
    **`edit` | `ask` | `bypass`**, living on the **sandbox** config. Per-tool behavior:

    | Mode     | `read` / `glob` / `grep` | `write` / `edit` | `bash`                              |
    | -------- | ------------------------ | ---------------- | ----------------------------------- |
    | `ask`    | auto                     | **ask**          | **ask**                             |
    | `edit`   | auto                     | auto             | **ask**                             |
    | `bypass` | auto                     | auto             | auto                                |

    (`bash` **asks** in `edit` mode)

### Runtime restriction (advisory for now)

1. `sandboxConfig.runtimes` is an **allow-list** enforced **advisory / best-effort**
    harness-side (command inspection + reflected in the tool description). A general bash
    VM cannot hard-guarantee this. **Future:** add strict single-runtime images (or use
    AWS-managed node/python runtimes) and redirect there; keep harness-side checks too.

### Infra topology (deploy all 4)

1. Two independent axes → **4 Lambda functions** of the same image, auto-selected:

    | | internet **on** | internet **off** |
    | --- | --- | --- |
    | **workspace attached → mounted fn** | VPC + NAT + S3 mount | VPC, no NAT, S3 mount |
    | **no workspace → no-mount fn** | plain Lambda (fast) | VPC, no NAT, no mount |

    - **Mount axis** is derived automatically from "does the agent reference a workspace."
    - **Internet axis** comes from `sandboxConfig.internet`.
    - Rationale for the mount split: the S3 mount forces a VPC and a Mountpoint-for-S3
      client → heavier cold start; file ops go to S3 over the network. A no-mount, no-VPC
      function is meaningfully faster for the stateless case.

### Skill-publish

1. **Disable skill-publish for now.** Remove `publishSkillFromWorkspace`, the publish
    branch in `load-skill.tool.ts`, and all `readDirectory` code. **Keep** read-only skill
    loading. Skill-publish will be **reworked later**, likely by making **skills a
    workspace** so the agent edits them directly without `readDirectory` / staleness.

### Misc

1. **Clean break — no legacy support.** Do not keep a compat shim for the old
    `config.workspace.{needsApproval,sandbox}` shape. Update examples, tests, and docs to
    the new config.
2. **Account-scoped config defined once, shared by id.** Agent config references sandbox +
    workspaces by id; concrete configs live in their own tables.
3. **CRUD via `account-manage`** with new endpoints, mirroring accounts/agents, in **both**
    storage backends (DynamoDB + Convex submodule).

### One v1 simplification to call out (see §6, Risk R1)

1. **Workspace mounting = one active workspace selected per tool call by name** (matches
    today's `filesystem.tool.ts` `workspace` enum param), **not** simultaneous labeled
    multi-mount. The new lambda roots a run at a single `namespace`; simultaneous labeled
    mounts would require a lambda-side `mounts: [{label, namespace}]` API change (owned by
    the `lambda-just-bash-rust` repo). Deferred unless you decide otherwise.

---

## 3. New lambda sandbox API (the contract we target)

From `lambda-just-bash-rust/README.md`. Single JSON-in / JSON-out invocation.

### Request

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `runtime` | string | no | `bash` | `bash` \| `python` \| `node` |
| `code` | string | **yes** | — | code to execute |
| `namespace` | string | no | — | persistent workspace namespace; must match `fs-[a-f0-9]{40}` |
| `workspace_root` | string | no | `SANDBOX_WORKSPACE_MOUNT_PATH` env or `/mnt/workspaces` | root for namespaced runs |
| `timeout_ms` | int | no | `30000` | max 300000 (5 min) |
| `args` | string[] | no | `[]` | argv passed to the script |
| `env` | object | no | `{}` | env vars; child env is `env_clear()`ed first (no AWS creds leak) |

#### Response

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | bool | exit code 0 |
| `runtime` | string | runtime used |
| `exit_code` | int \| null | null if timed out |
| `timed_out` | bool | |
| `duration_ms` | int | |
| `stdout` / `stderr` | string | each truncated at 256 KB |
| `workspace` | string | path used for this run |

**Workspace modes:** no `namespace` ⇒ ephemeral `/tmp/agent-workspace/<uuid>` deleted after
the call. With `namespace` ⇒ `{workspace_root}/{namespace}`, never cleaned; persists in S3
when the function has the S3 Files mount. This maps cleanly to our decisions: **mounted fn +
namespace = persistent workspace; no-mount fn + no namespace = ephemeral scratch.**

---

## 4. Target architecture

### 4.1 Config shape (after refactor)

**`sandboxConfig` record** (account-scoped table; PK `accountId` + `sandboxId`):

```jsonc
{
  "provider": "lambda",            // lambda | e2b | daytona | kubernetes
  "runtimes": ["bash", "python", "node"], // advisory allow-list
  "internet": true,                // selects internet-on vs internet-off fn
  "permissionMode": "ask",         // edit | ask | bypass
  "timeout": 120,                  // seconds, bounded by limits (max raised to 300)
  "envVars": { "FOO": "bar" },     // injected into every run
  "options": { /* provider-specific, e.g. daytona/k8s/e2b knobs */ }
}
```

**`workspaceConfig` record** (account-scoped table; PK `accountId` + `workspaceId`):

```jsonc
{
  "storage": { "provider": "s3" },  // only provider; only s3 supported
  "harness": { "enabled": true },   // workspace harness prompting
  "description": "shared notes"
  // NO user-facing namespace — namespace is DERIVED from accountId + workspaceId
}
```

**Agent config** (per-agent; references the above by id):

```jsonc
{
  "sandbox": "sb_xxx",                                  // single sandbox id (optional)
  "workspaces": [                                        // list (optional)
    { "name": "notes", "workspaceId": "ws_aaa" },        // name = agent-facing mount label
    { "name": "data",  "workspaceId": "ws_bbb" }
  ]
}
```

- `config.workspace.{enabled,needsApproval,sandbox,storage,harness,namespace,defaultWorkspace,workspaces}`
  (the old nested shape) is **removed**.
- **Namespace derivation:** `normalizeFilesystemNamespace(`${accountId}:${workspaceId}`)`
  (`functions/_shared/runtime-keys.ts:48`). Scoped by **workspaceId, not agentId/conversation**,
  so the same workspace is shared across agents/conversations (shared-workspace decision,
  §2 Workspace model). Drop the user-typed `namespace` field entirely.

### 4.2 Tool enablement matrix

| Condition | Tools exposed |
| --- | --- |
| sandbox + ≥1 workspace | `bash`, `read`, `write`, `edit`, `glob`, `grep` (full) + memory/tasks (S3) |
| sandbox, no workspace | `bash` only (stateless) |
| workspace, no sandbox | memory/tasks via S3 API only (no compute tools) |
| neither | none of the above |

`permissionMode` (from the sandbox) gates approvals per the permissionMode table in §2 (Tools).

### 4.3 Lambda function selection (provider = lambda)

```text
hasWorkspace = (agent has ≥1 workspace) && provider == "lambda"
internet     = sandboxConfig.internet
fn = pick(hasWorkspace, internet) from the 4 deployed functions
```

Function names come from 4 env vars set by SST (see §5.4). For a workspace run, pass
`namespace` = the selected workspace's derived namespace + `workspace_root` = mount path.
For a no-workspace run, omit `namespace` (ephemeral).

### 4.4 Request flow (unchanged backbone)

`incoming request → integrations.ts → handler.ts → session.ts → harness.ts → optional reply`.
New work hooks in at:

- **handler.ts** — after loading the agent record, resolve `sandbox` + `workspaces` ids to
  concrete `sandboxConfig` / `workspaceConfig` records (storage lookups) and attach to the
  runtime agent config. Consider doing this inside `toRuntimeAgentConfig` /
  `toChannelRuntimeAgentConfig` (`agent-config.ts`, exported via `storage/index.ts:94-95`),
  but those are currently synchronous — the resolver needs async storage reads, so most
  likely a new async resolve step in handler before session construction.
- **session.ts** — `filesystemNamespace()` (`:576`), `workspaceBindings()` (`:580`),
  `isWorkspaceEnabled()` (`:594`) reworked to read resolved configs instead of
  `agentConfig.workspace`.
- **harness.ts** — `createTools({...})` call (`:76-96`) gets the resolved sandbox config +
  workspace bindings + permissionMode.
- **tools/index.ts** — `createTools` (`:52`) enablement logic rewritten (see §5.3).

---

## 5. Workstreams (concrete changes)

> Build with `bun run build`; deploy only on explicit request (`bun run deploy`, `dev`
> stage — **never** a `phicks` stage). CI runs on push/PR (`gh run list` / `gh run view`).

### A. Storage: new config tables & stores

**Interface** — `functions/_shared/storage/types.ts`

- Add `SandboxConfigStore` and `WorkspaceConfigStore` interfaces (mirror `AgentStore`,
  `types.ts:57-65`: `getById(accountId, id)`, `list(accountId)`, `create`, `update`,
  `remove`, `removeAllForAccount`).
- Add `sandboxConfigs` and `workspaceConfigs` to `StorageProvider` (`types.ts:101-106`).
- Add record/input types (`SandboxConfigRecord`, `CreateSandboxConfigInput`, … and the
  workspace equivalents).

**Domain normalizers** — new `functions/_shared/storage/sandbox-config.ts` and
`functions/_shared/storage/workspace-config.ts` (mirror `agents.ts` + `agent-config.ts`
validation). Move the sandbox/workspace validation out of `agent-config.ts` (§B) into here.
**Encrypt `sandboxConfig` at rest** (it carries `envVars` secrets) by reusing the
`encryptAgentConfig` / `decodeStoredAgentConfig` helpers (`agent-config.ts`); workspace
config stays plaintext (no secrets) for now. See §6 R4.

**DynamoDB stores** — new `functions/_shared/storage/dynamo/sandbox-configs.ts` and
`dynamo/workspace-configs.ts`, copying the pattern in `dynamo/agents.ts` (item ↔ record
mappers, `GetItem`/`Query`/`PutItem` with `attribute_not_exists` create guard +
`isConditionalCheckFailed` retry, `UpdateItem`, `DeleteItem`). Register both in
`dynamo/index.ts:12-17`.

**Convex stores + migration** — the Convex adapter is a **private submodule** mounted at
`functions/_shared/storage/convex/` (see `storage/index.ts:16-29`, `convex/README.md`). It
needs a **full migration/refactor** (see §6 R3): add `sandboxConfig` + `workspaceConfig`
tables + stores, change the agent schema to the new `sandbox`/`workspaces` refs, encrypt
sandbox config, and migrate existing agent data. Separate repo change that must land in
lockstep; the OSS build ships a stub (`scripts/build.ts`) so `STORAGE_PROVIDER=convex`
without the submodule throws.

**Index exports** — `functions/_shared/storage/index.ts`: export the new record/input
types and any helpers (mirror the `agents.ts` / `agent-config.ts` export blocks at
`:61-124`).

### B. Agent config refactor

`functions/_shared/storage/agent-config.ts`

- **Remove** `AgentWorkspaceConfig`, `AgentWorkspaceDefinitionConfig`,
  `AgentWorkspaceHarnessConfig`, `AgentWorkspaceStorageConfig`, `AgentWorkspaceSandboxConfig`
  (`:104-141`) and the `workspace?` field on `AgentConfig` (`:40`).
- **Add** `sandbox?: string` (sandbox id) and `workspaces?: Array<{ name: string;
  workspaceId: string }>` to `AgentConfig` (`:36-48`).
- **Replace** `normalizeWorkspaceConfig` + helpers (`:466-559+`) with:
  - `normalizeSandboxRef` — assert `config.sandbox` is an optional non-empty string id.
  - `normalizeWorkspaceRefs` — assert `config.workspaces` is an optional array of
    `{ name, workspaceId }`; validate `name` (mount-label charset) + `workspaceId`
    (non-empty); enforce unique names.
- Find the caller of `normalizeWorkspaceConfig` in the top-level `normalizeAgentConfig`
  and swap it. Update `mergeAgentConfig` / `redactAgentConfig` / `toRuntimeAgentConfig` /
  `toChannelRuntimeAgentConfig` for the new fields.
- The **sandbox/workspace field validation** (provider enum, timeout bound, permissionMode
  enum, runtimes enum, storage.provider) moves to the new `sandbox-config.ts` /
  `workspace-config.ts` normalizers (§A). The timeout/memory bound now comes from
  **provider-aware** `workspaceSandboxLimits(provider)` (`_shared/sandbox.ts:56`) — see §9.2
  for the final shape (lambda 300 s/1024 MB; persistent 600 s/unbounded).

### C. Sandbox executor: collapse to `run`

`functions/harness-processing/sandbox/types.ts`

- Reduce `WorkspaceSandboxExecutor` (`:97-104`) to a single `run(request): Promise<result>`.
- Replace `WorkspaceSandboxRunRequest` / `WorkspaceSandboxShellRequest` /
  `WorkspaceSandboxReadDirRequest` (`:28-71`) with **one** `SandboxRunRequest`:
  `{ runtime?: "bash"|"python"|"node"; code; namespace?; workspaceRoot?; timeoutSeconds;
  outputLimitBytes; envVars? }`. Keep `SandboxRunResult` (the old `WorkspaceSandboxShellResult`
  shape at `:86-95` — `ok, exitCode, stdout, stderr, durationMs, timedOut, truncated,
  provider`).
- **Remove** `WorkspaceSandboxReadDir*` types, `runFile`/`runShell`/`readDirectory`,
  `WorkspaceSandboxRuntime` if no longer needed, and the `WorkspaceSandboxArtifact`
  machinery if unused.
- Consider renaming the dir `sandbox/` types to drop the `Workspace` prefix
  (`SandboxConfig`, `SandboxExecutor`, `SandboxRunRequest`) since sandbox is now standalone.

`functions/harness-processing/sandbox/lambda-executor.ts` — rewrite to a single `run`:

- One `#invoke(functionName, { runtime, code, namespace, workspace_root, timeout_ms, env })`.
- **Function selection** by `(hasWorkspace, internet)` from 4 env vars (§5.4) instead of
  `bashFunctionName`/`pythonFunctionName` (`:155-180`). The executor needs to know
  `hasWorkspace` + `internet` — pass them in the config or request.
- Delete `runFile` (`:31`), the python-routing, `readDirectory` (`:82`), `functionNameFor`
  (`:155`), `shellFunctionName` (`:175`), `missingFunctionName` (`:205`).

`e2b-executor.ts`, `daytona-executor.ts`, `kubernetes-executor.ts`

- Collapse each provider's `runFile` + `runShell` into a single `run`. Keep provider
  behavior. Remove `readDirectory` from `kubernetes-executor.ts:121`.
- `sandbox/index.ts` (`createWorkspaceSandboxExecutor`, `:18`) stays as the provider
  switch; rename to `createSandboxExecutor` for clarity. Keep all four providers
  (§2 Sandbox model).

### D. Tool surface (Claude-Code-style)

`functions/harness-processing/tools/` — split the single `bash` tool into a tool set:

- **`bash.tool.ts`** — the `run` (rename/relocate the relevant parts of the current
  `filesystem.tool.ts`). **Delete** the lambda-only description caveats
  (`filesystem.tool.ts:96-113`) and the python-interception
  (`filesystem.tool.ts:127-159`, `parseExecutionCommand` / `executeWorkspaceFile`). The
  description becomes the clean generic "Linux VM with bash, python3, node" prompt.
- **`read.tool.ts`, `write.tool.ts`, `edit.tool.ts`, `glob.tool.ts`, `grep.tool.ts`** —
  each implemented as a single `run` under the hood against the selected workspace
  (e.g. `cat` for read, heredoc/`printf` for write, exact string-replace for edit,
  `find`/`ls` for glob, `rg`/`grep` for grep).
  (Edit = exact unique string replacement; Read = numbered lines; etc.).
- Keep `filesystem-utils.ts` helpers that remain relevant (`toScopedPath`,
  `boundedInteger`, `formatSandboxResult`) and drop the execution-parsing helpers.

`functions/harness-processing/tools/index.ts`

- `ToolContext` (`:28-38`): replace `config: AgentToolConfig` with the resolved sandbox
  config + workspace bindings + permissionMode; drop the single-tool assumptions.
- `createTools` (`:52`): replace the `agentConfig.workspace?.enabled` gate (`:56-68`) with:
  - if sandbox referenced → register `bash`; if also ≥1 workspace → register
    `read/write/edit/glob/grep`.
  - apply `permissionMode` → per-tool `needsApproval` via `withToolApproval` (`:125-132`),
    using the permissionMode matrix in §2 (Tools) (replace the `needsApproval` boolean at `:57,65`).
  - memory/tasks enablement keyed on workspace presence (not sandbox).
- Remove the `publishEnabled` skill-publish wiring (`:83-92`) per §G.

### E. Runtime resolution & session

`functions/harness-processing/handler.ts`

- After loading the agent record, **resolve** `agentConfig.sandbox` → `sandboxConfig`
  record and each `agentConfig.workspaces[].workspaceId` → `workspaceConfig` record via
  `getStorage().sandboxConfigs` / `.workspaceConfigs`. Attach resolved objects to the
  runtime config passed into the session. Handle missing/disabled referenced configs
  gracefully (clear error; do not crash the turn).
- Ensure the resolution is account-scoped (the referenced ids must belong to the same
  account — reject cross-account references).

`functions/harness-processing/session.ts`

- `filesystemNamespace()` (`:576`) / `workspaceBindings()` (`:580`): derive bindings from
  the resolved `workspaces` list; namespace from `accountId:workspaceId`.
- `isWorkspaceEnabled()` (`:594`): true when ≥1 workspace resolved.
- `isWorkspaceHarnessEnabled()` (`:597`): from the workspace's `harness.enabled`.
- `loadMemoryFile()` (`:536`) keeps reading `MEMORY.md` via the **S3 API** under
  `workspaceNamespacePrefix(namespace)` (`_shared/sandbox.ts:27`) — works without compute,
  satisfying the workspace-without-sandbox decision (§2 Workspace model).

`functions/_shared/workspaces.ts`

- Rework `resolveWorkspaceBindings` (`:29`) / `toWorkspaceBinding` (`:103`) /
  `defaultWorkspaceNamespace` (`:125`) to map the new `workspaces: [{name, workspaceId}]`
  list to bindings (`{ id: name, namespace: hash(accountId:workspaceId), isDefault }`).
  **Namespace no longer includes agentId/conversationKey** (shared-workspace decision, §2).
- `resolveConfiguredWorkspaceNamespaces` (`:72`) — used by cleanup; update accordingly and
  re-check `account-manage/cleanup.ts`.

### F. SST infra — `sst.config.ts`

> **ECR image tags (confirmed 2026-05-31).** The repo
> `beeblast-lambda-sandbox-403012596812-eu-central-1` publishes per-arch tags:
> **`latest-arm64`** (~175 MB, digest `sha256:d262…`) and `latest-amd64` (~178 MB),
> plus commit-pinned `<short-sha>-arm64` / `<short-sha>-amd64` (e.g. `c6cef6f-arm64`).
> The Lambda runs **ARM64**, so `sandboxImageUri` must reference the **`latest-arm64`**
> tag (or a pinned `<sha>-arm64` for reproducible deploys). There is no multi-arch
> `latest` manifest — do not use a bare `:latest`.

- **Image / functions:** replace `SandboxBash` (`:574`) + `SandboxPython` (`:551`) with
  **4 functions** of `sandboxImageUri` (`:549`, tag `latest-arm64`), all `arm64`, `512 MB`,
  **`5 minutes`** (was `2 minutes`):
  - `SandboxMountNet` — `vpc: sandboxNetwork` (with NAT) + `fileSystemConfig` mount.
  - `SandboxMountNoNet` — VPC **without** NAT egress + mount.
  - `SandboxNoMountNet` — **no VPC** (default internet), no mount.
  - `SandboxNoMountNoNet` — VPC without NAT, no mount.
  - Network topology per the **cheapest plan in §6 R2**: no managed NAT Gateway; reuse one
    `sandboxNetwork` VPC + existing **fck-nat** only for the mount+internet-on combo; add a
    **free S3 Gateway VPC Endpoint** so mounted functions reach S3 without NAT; no-mount +
    internet-on is a **no-VPC** Lambda; internet-off functions sit in an isolated subnet with
    no NAT route. `sandboxNetwork` (`:367`) sets `nat: "ec2"` on non-prod and omits NAT on
    prod — ensure fck-nat exists wherever the mount+internet-on combo runs.
- **Env wiring** (`HarnessProcessing`, `:630-631`): replace `SANDBOX_BASH_FUNCTION_NAME` /
  `SANDBOX_PYTHON_FUNCTION_NAME` with 4 vars, e.g. `SANDBOX_FN_MOUNT_NET`,
  `SANDBOX_FN_MOUNT_NONET`, `SANDBOX_FN_NOMOUNT_NET`, `SANDBOX_FN_NOMOUNT_NONET`. Update
  the outputs block (`:918`, `sandboxPythonFunctionName`).
- **Invoke permission** (`:716-724`): grant the harness `lambda:InvokeFunction` on **all 4**
  sandbox function ARNs (replace `sandboxBash.arn` / `sandboxPython.arn`).
- **Mount permissions:** `sandboxRuntimePermissions` (`:66-96`) applies to the **mounted**
  functions only; no-mount functions don't need S3 Files actions.
- **Bucket policy principals:** `denyUnlessProjectPrincipal` (`:98-119`) lists
  `SandboxBashRole-*` / `SandboxPythonRole-*` (`:110-111`) — replace with the 4 new role
  name globs so the mounted functions can still reach the bucket.
- **New tables (non-prod DynamoDB):** add `SandboxConfig` + `WorkspaceConfig` Dynamo tables
  next to `AgentConfig` (`:240`), gated `isProduction ? undefined : new sst.aws.Dynamo(...)`,
  PK `accountId` + (`sandboxId` | `workspaceId`). Add names to the `names` map (`:168-179`).
  Wire table-name env + IAM for **both** `AccountManage` and `HarnessProcessing` roles
  (mirror `agentConfigsTable` env at `:620-622,803-804` and IAM at `:672-679,838-847`).
  Production uses Convex tables (submodule schema).
- Keep `SANDBOX_WORKSPACE_MOUNT_PATH = "/mnt/workspaces"` (`:10`) and the access-point root
  `/sandbox` ↔ `WORKSPACE_MOUNT_PREFIX` invariant (`:472-493`, `_shared/sandbox.ts:14`).

### G. Skill-publish removal

- `functions/harness-processing/session.ts`: delete `publishSkillFromWorkspace`
  (`:388-425`) and `isSkillPublishEnabled` (`:601-603`) usage tied to publish; keep skill
  **loading** (`loadSkillPrompt`, `loadSkillMetadata` `:605`).
- `functions/harness-processing/tools/load-skill.tool.ts`: remove the publish callback /
  `publishNeedsApproval` (`:96`) path; keep load.
- `functions/harness-processing/tools/index.ts`: drop the publish branch (`:83-92`).
- `functions/_shared/storage/agent-config.ts`: keep `skills` config but drop `publish`
  validation (`:734`) if removing the field; or leave the field inert. Decide and document.
- Remove the now-unused `publishStagedSkillBundle` helper + any `readDirectory` plumbing.
- Update `docs/skills.md` to note publish is temporarily removed and will return as a
  skills-as-workspace model.

### H. account-manage endpoints

`functions/account-manage/handler.ts` — add CRUD mirroring agents
(`/accounts/me/agents` routing, `:105-...`, GET/POST/PATCH/DELETE pattern at
`:207-242,271-388`):

- `/accounts/me/sandboxes` (+ `/{id}`) → `getStorage().sandboxConfigs`.
- `/accounts/me/workspaces` (+ `/{id}`) → `getStorage().workspaceConfigs`.
- Admin variants under `/accounts/{id}/...` if agents have them.
- On account delete, `cleanup.ts` must also remove the account's sandbox/workspace configs
  (and, for workspaces, optionally purge S3 namespace data — confirm policy).
- Update `docs/api-reference/openapi.yaml` with the new endpoints + schemas.

### I. Examples, tests, docs

- **Examples:** `examples/sandbox-lambda.ts` (currently uses old
  `workspace.{enabled,needsApproval,storage,sandbox}` shape, `:25-39`) and
  `examples/sandbox-kubernetes.ts` → rewrite to: create a `sandboxConfig`, create a
  `workspaceConfig`, create an agent referencing them. `examples/sandbox.ts` is already
  deleted (git status) — keep deleted.
- **Tests:** `tests/filesystem-tool.test.ts` and `tests/sandbox-executor.test.ts` →
  rewrite for the single `run` + the new tool set + permissionMode matrix. Add tests for
  config-table CRUD + ref resolution + function selection.
- **Docs:** update `docs/workspace/index.md`, `docs/workspace/storage.md`,
  `docs/workspace/memory-and-session.md`, `docs/workspace/sandbox/{index,lambda,e2b,daytona,kubernetes}.md`,
  `docs/tools.md`, `docs/architecture.md`, `docs/skills.md`. Per CLAUDE.md: keep docs
  concise, prefer **diagrams** over prose, update only the suitable files, and **update the
  diagrams** to show sandbox ⟂ workspace separation, the 4-function topology, and the tool
  matrix. Update `CLAUDE.md` lines describing "Workspace-backed tools (filesystem and
  tasks) … through `config.workspace.enabled`" and the "add a new non-workspace tool" note.

---

## 6. Risks / things to verify before/while building

- **R1 — Multi-workspace mounting (see §2 "One v1 simplification").** v1 = one active workspace selected per
  tool call by `name` (current `filesystem.tool.ts` `workspace` enum). True simultaneous
  labeled multi-mount needs a `mounts: [{label, namespace}]` API in `lambda-just-bash-rust`.
  Confirm v1 is acceptable; if not, that repo changes too.
- **R2 — Internet on/off, cheapest topology (DECIDED).** Minimize spend — **no managed NAT
  Gateway anywhere**. Reuse the single `sandboxNetwork` VPC + the existing **fck-nat** (EC2
  t4g.nano, ~10× cheaper than a NAT Gateway) and add a **free S3 Gateway VPC Endpoint** so
  mounted functions reach S3 / S3-Files without paying NAT data charges. Per combo:
  - **no-mount + internet-on** → **no-VPC** Lambda (AWS-managed egress, free, fastest cold start).
  - **no-mount + internet-off** → VPC isolated subnet, no NAT, no endpoint (needs nothing external).
  - **mount + internet-off** → VPC isolated subnet, no NAT, **S3 Gateway Endpoint** for mount/S3.
  - **mount + internet-on** → VPC private subnet routed to **fck-nat** (the only combo that
    pays egress) + S3 Gateway Endpoint.
  Prod currently omits NAT (`sandboxNetwork`, `sst.config.ts:367`); the mount+internet-on
  combo needs fck-nat present on that stage (cheapest NAT) — enable it where that combo is
  used, or gate the combo off where NAT is absent. The no-VPC internet-on path needs no NAT.
- **R3 — Convex migration + refactor (DECIDED).** Production runs Convex
  (`sst.config.ts:152-167`). The private submodule (`functions/_shared/storage/convex/`)
  needs a **full migration/refactor**, not just additive tables: add `sandboxConfig` +
  `workspaceConfig` Convex tables + stores (mirroring the new DynamoDB stores and the
  `StorageProvider` interface); **change the agent schema** to drop the nested `workspace`
  object and add `sandbox` (id) + `workspaces` (`[{name, workspaceId}]`) refs; **encrypt
  sandbox config at rest**; and run a **data migration** for any existing agent records
  (lift inline workspace/sandbox config into the new tables, rewrite refs). With no live
  prod data this reduces to a clean schema change. Must land in lockstep before prod deploy
  or `getStorage()` for these tables fails on prod. (See the `convex-migration-helper` skill.)
- **R4 — Sandbox config encryption (DECIDED).** `sandboxConfig` is **encrypted at rest**
  like agent config (it carries `envVars`, which may hold secrets). Reuse the
  `encryptAgentConfig` / `decodeStoredAgentConfig` approach (`agent-config.ts`) in the new
  sandbox-config store (DynamoDB item mapper + Convex). Workspace config has no secrets and
  stays plaintext unless we later add credentials there.
- **R5 — Ref resolution is async.** `toRuntimeAgentConfig` is currently sync; ref→record
  resolution needs storage reads. Put the async resolve in handler.ts, not in the sync
  normalizers.
- **R6 — Shared-workspace blast radius.** The shared-workspace decision (§2) means agents
  share files by `workspaceId`. Document this prominently so operators don't accidentally
  cross-wire agents into one workspace.
- **R7 — Timeout/memory limits (RESOLVED, now provider-aware — see §9.2).** Originally
  "raise the flat cap to 300." Final design instead makes `workspaceSandboxLimits(provider)`
  provider-aware: **lambda** is hard-bounded (timeout ≤ 300 s, memory ≤ 1024 MB) because the
  deployed function is `timeout: 300` / `memorySize: 512`; **persistent providers**
  (`e2b`/`daytona`/`kubernetes`) cap a single blocking call only at the harness request
  budget (600 s) and leave memory operator-sized. `memoryLimit` is validated but not yet
  consumed by any executor (advisory).
- **R8 — Runtime allow-list is advisory.** Be explicit in docs + tool description that
  `runtimes` is best-effort on a general VM until strict single-runtime images exist.
- **R9 — Cleanup.** Account/agent deletion must cascade to sandbox/workspace configs and
  decide S3 data retention for shared workspaces.

---

## 7. Suggested sequencing

1. **Storage foundation (A, B):** types, normalizers, DynamoDB stores, index exports, SST
   tables + IAM/env. Convex submodule in parallel (R3). Land + build green.
2. **account-manage CRUD (H):** endpoints + OpenAPI. Now configs can be created.
3. **Executor collapse (C):** single `run` across all four providers; lambda function
   selection wired to the 4 env vars (depends on F for the names).
4. **SST functions (F):** 4 functions, env, invoke perms, bucket-policy principals (R2).
5. **Tool surface (D):** bash + read/write/edit/glob/grep; permissionMode matrix; tool
   enablement by sandbox/workspace presence.
6. **Runtime resolution (E):** handler resolves refs; session/workspaces reworked.
7. **Skill-publish removal (G).**
8. **Examples, tests, docs (I).**
9. `bun run build`, fix types, run tests, monitor CI. Deploy only when asked (dev stage).

---

## 8. Key file index

| Concern | Location |
| --- | --- |
| Sandbox executor interface | `functions/harness-processing/sandbox/types.ts` |
| Lambda executor (collapse) | `functions/harness-processing/sandbox/lambda-executor.ts` |
| Other providers | `sandbox/{e2b,daytona,kubernetes}-executor.ts` |
| Provider switch | `sandbox/index.ts:18` (`createWorkspaceSandboxExecutor`) |
| Bash tool (split into set) | `functions/harness-processing/tools/filesystem.tool.ts` |
| Tool registry & approvals | `functions/harness-processing/tools/index.ts` (`createTools` `:52`, `withToolApproval` `:125`) |
| Tool wiring into loop | `functions/harness-processing/harness.ts:76-96` |
| Session namespace/bindings | `functions/harness-processing/session.ts` (`:388,536,576-599`) |
| Workspace binding resolution | `functions/_shared/workspaces.ts` |
| Namespace hashing | `functions/_shared/runtime-keys.ts:48` |
| Sandbox limits / mount prefix | `functions/_shared/sandbox.ts` (`WORKSPACE_MOUNT_PREFIX` `:14`, limits `:39`) |
| Agent config types/validation | `functions/_shared/storage/agent-config.ts` (workspace block `:104-141`, normalizers `:466-559+`) |
| Storage interface | `functions/_shared/storage/types.ts` |
| DynamoDB stores (pattern) | `functions/_shared/storage/dynamo/{index,agents,accounts}.ts` |
| Convex (private submodule) | `functions/_shared/storage/convex/` |
| account-manage CRUD | `functions/account-manage/handler.ts` (agents routing `:207-388`), `cleanup.ts` |
| SST infra | `sst.config.ts` (perms `:66-119`, VPC/mount `:364-514`, sandbox fns `:549-595`, harness env/perms `:597-724`, tables `:207-313`) |
| New lambda image API | `~/Workspace/projects/lambda-just-bash-rust/README.md` |
| ECR repo (Terraform) | `~/Workspace/projects/infra/terraform/aws/main.tf:361-385` |
| Examples | `examples/sandbox-lambda.ts`, `examples/sandbox-kubernetes.ts` |
| Tests | `tests/filesystem-tool.test.ts`, `tests/sandbox-executor.test.ts` |
| Docs | `docs/workspace/**`, `docs/tools.md`, `docs/architecture.md`, `docs/skills.md`, `docs/api-reference/openapi.yaml` |

---

## 9. Post-implementation refinements (changelog)

> These landed **after** workstreams A–I were green, as a series of follow-up sessions. They
> are small, surgical changes — not new workstreams — but they change the *current behavior*
> of the limits, tool descriptions, and skill staging subsystems. Where they conflict with
> earlier sections, **this section wins.** Nothing here is committed/pushed/deployed yet;
> the working tree holds all of it. Verification after each: `bunx tsc --noEmit` clean,
> `ACCOUNT_CONFIG_ENCRYPTION_SECRET=test-secret bun test` → **457 pass / 2 skip / 0 fail**,
> `bun run build` → all functions built.

### 9.1 Read-only-S3 routing is per-call, not a branch in `index.ts` (clarification)

**Question raised:** "Where does `tools/index.ts` wire the read-only (no-sandbox) S3 path?"
**Answer:** it doesn't — and that's by design. `tools/index.ts` only decides **registration**:

- `read` / `glob` are registered for the full `context.workspaces` list (so they work even
  when a workspace has no sandbox).
- `write` / `edit` / `grep` are registered only for `sandboxWorkspaces`
  (`workspaces.filter(w => w.sandbox)`), because mutation/ripgrep require a real container.

The **S3-vs-mount decision is made per call, inside each tool's `execute`**, by inspecting
the *resolved workspace's* `sandbox` field:

- `glob` ([glob.tool.ts](../../functions/harness-processing/tools/glob.tool.ts)): if
  `!ws.sandbox` → `s3Glob(ws.namespace, …)` (lists straight from S3 via `Bun.Glob`); else
  run `globScript` in the container through the mount.
- `read` (read.tool.ts): same `ws.sandbox` check → `s3ReadNumbered` (direct S3 read,
  paginated harness-side) vs in-container `sed -n … | nl`.
- `write` / `edit` / `grep` short-circuit with `"Error: workspace is read-only"` when
  `!ws.sandbox` (they're never registered for those workspaces, but the guard is defensive).

So a workspace's read-only-ness is a property of the **resolved `ResolvedWorkspace.sandbox`**
(present ⇒ mounted/compute; absent ⇒ read-only S3), surfaced via the cascade
`ws.sandbox(null⇒read-only | id⇒override) ?? config.sandbox` described in the header.

### 9.2 Provider-aware sandbox limits (supersedes R7 and the §B timeout note)

**Motivation.** The 5-minute / memory caps are **Lambda facts**, not universal truths. The
deployed lambda sandbox function is `timeout: 300` / `memorySize: 512`; persistent providers
(`e2b`/`daytona`/`kubernetes`) run long-lived, operator-sized sandboxes and must not inherit
a 5-minute ceiling. The real ceiling for *any* single blocking tool call is the
**harness-processing request budget (600 s / 10 min)**, because `runSandbox` awaits the
provider synchronously inside the streaming request.

**Implementation** — [`functions/_shared/sandbox.ts`](../../functions/_shared/sandbox.ts):

- Constants: `DEFAULT_TIMEOUT_SECONDS = 30`, `DEFAULT_OUTPUT_LIMIT_BYTES = 64 KiB`,
  `LAMBDA_MAX_TIMEOUT_SECONDS = 300`, `LAMBDA_MAX_MEMORY_LIMIT_MB = 1024`,
  `PERSISTENT_MAX_TIMEOUT_SECONDS = 600`. (Removed the old flat
  `DEFAULT_MAX_TIMEOUT_SECONDS` / `DEFAULT_MAX_MEMORY_LIMIT_MB`.)
- `WorkspaceSandboxLimits.maxMemoryLimitMb` is now **optional** — `undefined` means "no
  harness ceiling" (operator-sized).
- New signature: `workspaceSandboxLimits(provider: SandboxProvider = "lambda")`. Branches on
  `isLambda`:

  | Limit | `lambda` | `e2b` / `daytona` / `kubernetes` |
  | --- | --- | --- |
  | `maxTimeoutSeconds` | 300 (env `WORKSPACE_SANDBOX_LAMBDA_MAX_TIMEOUT_SECONDS`) | 600 (env `WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS`) |
  | `maxMemoryLimitMb` | 1024 (env `WORKSPACE_SANDBOX_LAMBDA_MAX_MEMORY_LIMIT_MB`) | *omitted* (unbounded) |

  `defaultTimeoutSeconds` / `defaultOutputLimitBytes` / `maxOutputLimitBytes` are
  **universal** (same for every provider) — output is always truncated harness-side.

- The `import type { SandboxProvider }` from `./storage/sandbox-config.ts` is **type-only**
  (erased at compile, so no runtime cycle even though `sandbox-config.ts` imports back).

**Consumers (both pass the provider now):**

- Validation — [`storage/sandbox-config.ts:87`](../../functions/_shared/storage/sandbox-config.ts):
  `workspaceSandboxLimits((config.provider as SandboxProvider) ?? "lambda")`, then
  `assertOptionalPositiveInteger(config.{timeout,memoryLimit,outputLimitBytes}, …, max)`.
  `assertOptionalPositiveInteger(value, name, max?)` only enforces the upper bound when
  `max !== undefined` — so for persistent providers `memoryLimit` is validated as a positive
  integer but **not** capped.
- Runtime bound — [`tools/filesystem-utils.ts:83`](../../functions/harness-processing/tools/filesystem-utils.ts):
  `runSandbox` calls `workspaceSandboxLimits(config.provider)` and passes `timeout` /
  `outputLimitBytes` through `boundedInteger(value, default, max)`. Note `boundedInteger`
  **does not clamp** — it returns the default when the value is `undefined`, else *throws*
  if the value is outside `1..max` (config-time validation in `sandbox-config.ts` is what
  normally keeps it in range). `runSandbox` only bounds timeout + output; **`memoryLimit` is
  never read here**, reinforcing the advisory-only gap below.

**Known gap (carried forward):** `memoryLimit` is **validated but not consumed by any
executor** — no `run()` path translates it into a pod/container resource request. It is
advisory metadata today. The natural place to wire it is the kubernetes executor (pod
resource request); deferred until asked.

### 9.3 Claude-Code-style tool descriptions (refines §D)

The model-facing descriptions for `bash` / `read` / `write` / `edit` / `glob` / `grep` were
rewritten to mirror Claude Code's "one-line summary + **Usage notes:** bullets" voice,
adapted to this runtime (paths are **workspace-root-relative**). Files:
[bash](../../functions/harness-processing/tools/bash.tool.ts),
[read](../../functions/harness-processing/tools/read.tool.ts),
[write](../../functions/harness-processing/tools/write.tool.ts),
[edit](../../functions/harness-processing/tools/edit.tool.ts),
[glob](../../functions/harness-processing/tools/glob.tool.ts),
[grep](../../functions/harness-processing/tools/grep.tool.ts).

- **bash** — two description variants from `description(context)`: a *stateless* variant (no
  workspace: fresh container per call, write-and-run in one command) and a *workspace*
  variant that adds "**prefer the dedicated `read`/`write`/`edit`/`glob`/`grep` tools over
  their bash equivalents** (`cat`/`sed`/`find`/`grep`)."
- **read** — "Reads a file from the workspace … (cat -n style)"; documents `${DEFAULT_LIMIT}`
  (2000) line cap, `offset`/`limit` paging, `<line_number>\t<content>` format.
- **write** — "Writes a file … overwriting it if it already exists"; relative path, parent
  dirs auto-created, prefer `edit` for existing files.
- **edit** — "Performs exact string replacements …"; exact-whitespace match, unique unless
  `replace_all`, `new_string` must differ, fails if file missing (use `write`).
- **glob** — "Fast file pattern matching … `**/*.ts`"; mtime newest-first, `path` defaults to
  root, prefer over `bash find`.
- **grep** — "A powerful content search tool … built on ripgrep"; regex syntax,
  `output_mode` (`files_with_matches` default | `content` | `count`), `glob`/`path` filters,
  prefer over `bash grep`/`rg`.

### 9.4 In-sandbox helper scripts stay Python (decision: do NOT switch to Node)

`glob` and `edit` run a one-shot helper **inside the container** (`globScript` /
`editScript` in their `*.tool.ts`), injected as a base64'd `python3 <<'PYEOF'` heredoc.
Considered switching to Node "for speed"; **decided against it:**

- These are single-shot (spawn → run → exit). Node's advantage is long-running throughput,
  not interpreter startup; for a tiny script `python3` startup is comparable-or-faster.
- Wall-clock is dominated by the **sandbox round-trip** (Lambda invoke / pod exec), so the
  interpreter delta is noise — optimizing it is premature.
- `glob.glob(recursive=True, root_dir=…)` is decades-stable; Node's `fs.glob` is
  experimental (Node 22+) and version-fragile in an image we don't fully control.
- The genuinely fast path already exists: read-only workspaces use `Bun.Glob` **in the
  harness** with no subprocess at all (see §9.1). Python is only used when there's a real
  mount to walk.

A `// Might need to optimize this …` comment remains above `globScript` as a marker; no code
change. Base64 injection is also a safety property (no content can break heredoc quoting).

### 9.5 Skill staging simplified — publish-round-trip scaffolding removed (refines §G)

§G disabled skill **publishing** but left the staging code shaped like a git round-trip
(clone → edit → push back), including a `.stage.json` manifest and a `preserveStagedEdits`
cache. With publishing gone that machinery was **dead or inert**, so it was removed.

**Why it was dead:** the only caller,
[`session.ts` `loadSkillPrompt`](../../functions/harness-processing/session.ts), always
passed `preserveStagedEdits: false`, so the manifest cache-hit and per-file-skip branches
were never reached; the manifest was written every load but its read path never fired.

**Removed from [`functions/harness-processing/skills.ts`](../../functions/harness-processing/skills.ts):**

- The `.stage.json` manifest entirely — `SKILL_STAGE_MANIFEST_FILE`, the
  `SkillStageManifest` / `SkillStageManifestFile` types, `loadStageManifest`,
  `writeStageManifest`, `isStageManifest`.
- The edit-preservation/caching logic — `isStageCurrent`, `manifestFileMatchesSource`, and
  the `preserveStagedEdits` option (and its `options` param on `loadConfiguredSkillPrompt`).
- Manifest-only fields — `SkillSourceFile.{sourceKey,etag,size}` (now just `{ key, path }`)
  and `SkillBundleSandboxStage.{copiedFiles,deletedFiles,cacheHit}` (now just
  `{ stagedPath, mirrorPaths, files }`).
- Now-unused S3 imports `isMissingS3Error`, `readS3Text`, `writeS3Object`.

**Resulting shape (current behavior):** `stageSkillBundleForSandbox(skillPath, namespace)`
re-stages **fresh on every `load_skill`**: list source files once, then for each staged
location (canonical `.claude/skills/<name>` + mirror `.agents/skills/<name>`) drop stale
files and re-copy the bundle via the single shared `stageSkillFiles` helper (replacing the
old `syncMirrorSkillFiles`). `deleteStaleStagedSkillFiles` returns `void` now. No manifest,
no caching, no branching. Staging itself is still load-bearing — it's what puts a skill's
bundled `.sh`/`.py` scripts on the sandbox filesystem so `bash script.sh` works (the
S3-API load path only injects `SKILL.md` text into context and can't execute scripts).

**Call site** — [`session.ts`](../../functions/harness-processing/session.ts): dropped the
`{ preserveStagedEdits: false }` arg + the TODO comment.

**Tests** — [`tests/harness-skills.test.ts`](../../tests/harness-skills.test.ts): removed the
obsolete "skips staging when manifest is current" test; replaced "refreshes when preserving
disabled" with **"re-stages from source on every load, replacing stale staged files"**
(asserts source re-copied, stale file deleted via `s3Deletes`, and **no** `.stage.json`
written); removed the `.stage.json` assertions from the main staging test.

**Docs** — [`docs/skills.md`](../../docs/skills.md): the staging paragraph now says "stages a
fresh read/run copy … every load re-stages from the account-level skill — stale files are
dropped and the bundle re-copied," with no mention of a manifest. The "publishing temporarily
removed → returns as skills-as-workspace" note is unchanged.

**Still open (future, unchanged from §G):** publishing returns as a **skills-as-workspace**
model — i.e. treat a skill as a workspace the agent edits directly, instead of the staged
working-copy + push-back design. `config.skills.publish.*` remains validated but inert.

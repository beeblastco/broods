# Lambda

The default sandbox provider. It runs a **single uniform container image** with real
`bash`, native `python3`, Node 22, and `uv` all on PATH — there is no emulated shell, no
WASM Python, and no separate Python function. SST deploys the image as four Lambda
functions plus one AWS S3 Files filesystem backed by the workspace S3 bucket.

## 4-function topology

The same image is deployed across two axes; the harness auto-selects one per run:

| | internet **on** | internet **off** |
| --- | --- | --- |
| **workspace mounted** | `SandboxMountNet` (VPC + NAT + S3 mount) | `SandboxMountNoNet` (VPC, S3 mount) |
| **no workspace** | `SandboxNoMountNet` (no VPC, fastest) | `SandboxNoMountNoNet` (VPC, no mount) |

- The **mount axis** comes from whether the run has a workspace namespace.
- The **internet axis** comes from `sandbox.internet`.
- All four are ARM64, 512 MB (minimum for the S3 mount), 5-minute timeout, pulled from the
  `latest-arm64` ECR image tag.

`harness-processing` invokes them by function name via four env vars
(`SANDBOX_FN_{MOUNT,NOMOUNT}_{NET,NONET}`) and never via a public Function URL.

## Image & ECR

Lambda can only pull a **private** ECR image **in the function's own region** — public
ECR and cross-region are rejected. So the repo is region-scoped and **owned by this app**
(`sst.config.ts` creates `aws.ecr.Repository` `beeblast-lambda-sandbox-<account>-<region>`),
not the infra repo. The `latest-arm64` image is built and pushed by the
[`lambda-sandbox custom image`](https://github.com/beeblastco/lambda-sanbdox) CI.

```text
sst deploy ──creates──▶ ECR repo (per region)  ◀──pushes── lambda-sandbox CI
                              │
                         imageUri ▼
                    4 sandbox Lambda functions
```

- **Multi-region:** every region you deploy to needs its own repo + pushed image. The CI
  mirrors the image to each region in `ECR_REGIONS` and **skips (with a warning) any region
  whose repo doesn't exist yet**.
- **Bootstrap a region (two passes), gated by `SANDBOX_IMAGE_READY`:** the 4 functions are
  created only when this flag is `true`. Without it the first `sst deploy` creates the empty
  repo and **succeeds** (functions skipped, deploy not blocked) → lambda-sanbdox CI mirrors the
  image into the now-existing repo → re-deploy with the flag `true` and the functions create.
  Harness env/IAM always carry the deterministic function names/ARNs, so flipping the flag is
  the only change needed on the second pass.
- **The flag is per-stage in `deploy.yaml`**, because `dev` and `production` deploy to
  different regions that bootstrap independently. The resolve step picks
  `SANDBOX_IMAGE_READY_DEV` (falls back to the legacy repo-wide `SANDBOX_IMAGE_READY`) for
  `dev` and `SANDBOX_IMAGE_READY_PRODUCTION` (default `false`) for `production`. So a region
  whose image isn't mirrored yet can keep its flag `false` while the other stays `true` —
  setting one global flag `true` would otherwise break the unbootstrapped region's deploy.

## Config

```jsonc
// POST /accounts/me/sandboxes
{
  "name": "default",
  "config": {
    "provider": "lambda",
    "internet": true,
    "permissionMode": "ask",
    "envVars": { "MY_API_BASE": "https://api.example.com" }
  }
}
```

Function names are service-managed. Account sandbox config cannot override them.

## Environment variables

`config.envVars` is a flat object of string key/value pairs injected into every run:

| Runtime | How the value is read |
| --- | --- |
| Shell | `echo $MY_API_BASE` |
| Node | `process.env.MY_API_BASE` |
| Python | `os.environ["MY_API_BASE"]` |

Rules:

- **The child env is `env_clear()`ed first** — the host Lambda's `process.env` (including
  AWS credentials) is never inherited. Only the keys you declare reach the run.
- Reserved runtime vars (`PATH`, `HOME`, `TMPDIR`, ...) are set by the image and win.
- Values must be strings. Sandbox config (and therefore `envVars`) is encrypted at rest.

## Runtimes

`bash`, `python3`, and `node` are all real binaries on PATH. The harness tools all compile
to bash, so you can run programs directly:

```bash
python3 script.py        # native CPython, full stdlib
node app.js              # Node 22
uv run tool.py           # uv is available
```

`config.runtimes` is a **best-effort** allow-list. The bash tool rejects obvious
disallowed runtime invocations and surfaces the allowed list in its description; a
general shell VM cannot make this a hard isolation boundary.

## Workspace mount

AWS S3 Files is mounted into the mounted functions at `/mnt/workspaces`, rooted at the
`sandbox/` access-point prefix (load-bearing — keep in sync with `WORKSPACE_MOUNT_PREFIX`).
A workspace run is rooted at `/mnt/workspaces/<namespace>`, where the namespace is derived
from `accountId:workspaceId`. The no-mount functions run statelessly in `/tmp`.

Skill bundles are still staged into the workspace namespace at `/.claude/skills/<name>` by
`load_skill` (S3 server-side copy), so the agent can read and run skill scripts without a
second mount.

### Read-only workspaces: mount (default) vs S3-direct

A workspace with **no** effective sandbox is **read-only** — `write`/`edit`/`grep`/`bash`
are not exposed; only `read`/`glob`. How those reads are served depends on the existing
per-workspace `sandbox` reference value (no new config — it reuses the `null` opt-out):

| Workspace ref | Read path | Sees committed writes | Cost |
| --- | --- | --- | --- |
| sandbox omitted / inherited, no effective sandbox (**default**) | service-managed **read-only mount** (`SandboxMountNoNet`) | **immediately** (hop 1) | a mounted Lambda invocation |
| `sandbox: null` (**explicit opt-out**) | **S3-direct** — reads `sandbox/<namespace>/` keys via the S3 API | only after the S3 export (hop 2, ≥60s) | no VPC/mount/Lambda cold start (cheapest) |

```jsonc
// agent config — reader on a shared workspace
"workspaces": [
  { "name": "shared", "workspaceId": "ws_…" },               // default: read-only mount (fresh reads)
  { "name": "shared", "workspaceId": "ws_…", "sandbox": null } // opt out: read straight from S3 (cheaper, lagged)
]
```

The default mount path reads the same filesystem a writer mounts, so a reader sees a
writer's committed file right away (subject only to NFS close-to-open consistency, seconds).
The `null` opt-out trades that freshness for skipping the mount entirely — use it for reads
that tolerate the S3-export lag and want the lowest cost.

## Write durability & S3 sync

The mount is **AWS S3 Files** (NFS over S3), which has two distinct flush boundaries. Getting
a write to a plain S3 object is a two-hop journey, and each hop is asynchronous by default:

```text
  tool write ──fsync──▶ S3 Files server ──async export (~60s idle)──▶ plain S3 object
              (hop 1: durability)            (hop 2: S3 visibility)
```

- **Hop 1 — durability across cold containers.** Closing a file does **not** force an NFS
  COMMIT; the data sits in the container's page cache. A Lambda is frozen the instant the
  handler returns, so a write that was never committed is **silently lost** on the next cold
  container. The `write` and `edit` tools therefore `fsync` the file (`sync <file>` /
  `fs.fsyncSync`) before returning — their writes are durable across cold mounts.
- **Hop 2 — visibility to the S3-direct opt-out path.** S3 Files exports committed data to
  plain S3 objects only **asynchronously**, roughly after 60s of write inactivity, and only
  if **S3 Versioning is enabled** on the bucket. This only matters for the `sandbox: null`
  opt-out (which reads S3 objects directly): it sees a freshly written file only **after**
  that export. The **default** read-only path reads through the mount (hop 1), so it — like
  any mounted sandbox — sees committed writes immediately and never waits on hop 2.

### ⚠️ The `bash` tool is not auto-synced

Only the dedicated `write`/`edit` tools fsync. Files created by raw `bash` redirection
(`echo > f`, `cmd > out`, `>>`, in-script writes) live only in the page cache and can be
**lost on the next cold container**. If an agent needs a `bash`-written file to persist,
it must flush explicitly:

```bash
echo "data" > report.txt && sync report.txt   # fsync this file
# or, after a batch of writes:
sync                                           # flush everything
```

Prefer the `write` tool over `bash` redirection when durability matters — it does this for you.

### Known limitations

- **S3-direct opt-out visibility lag.** Because of hop 2, a write is not immediately visible
  to a reader using the `sandbox: null` opt-out. Expect a delay (≥60s) and verify the bucket
  has versioning on. The default read-only mount and any mounted sandbox are unaffected.
- **Unflushed `bash` writes can vanish.** See the warning above — this is a correctness
  footgun for agents that script their own file writes instead of using the `write` tool.
  Tracked in [#46](https://github.com/beeblastco/filthy-panty/issues/46) for a future fix.
- **No mount-level `sync` option.** Lambda's managed `fileSystemConfig` mount does not expose
  NFS mount options, so durability is enforced per-write in the tools rather than globally.

## Security

- functions have no public Function URLs and need no account-management permissions
- child processes run with no AWS credentials (`env_clear()`)
- only the mounted functions can reach the workspace bucket (bucket policy principals)
- internet access is gated by `sandbox.internet` selecting the on/off function
- the Lambda mount is rooted at the shared `sandbox/` access-point prefix, so arbitrary
  `bash` should be treated as privileged workspace compute rather than a hard
  cross-workspace filesystem isolation boundary; dedicated file tools still reject path
  traversal, but full isolation requires an image/infra-level chroot or per-namespace mount

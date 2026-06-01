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
- **Bootstrap a region (two passes):** `sst deploy` creates the empty repo (sandbox
  functions fail — no image yet) → CI pushes the image → re-deploy and the functions create.

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

A workspace with **no** effective sandbox is never mounted at all: `read`/`glob` read the
same `sandbox/<namespace>/` keys directly via the S3 API, skipping the VPC/mount/Lambda
cold start entirely (cheaper and faster for read-only access).

## Security

- functions have no public Function URLs and need no account-management permissions
- child processes run with no AWS credentials (`env_clear()`)
- only the mounted functions can reach the workspace bucket (bucket policy principals)
- internet access is gated by `sandbox.internet` selecting the on/off function
- the Lambda mount is rooted at the shared `sandbox/` access-point prefix, so arbitrary
  `bash` should be treated as privileged workspace compute rather than a hard
  cross-workspace filesystem isolation boundary; dedicated file tools still reject path
  traversal, but full isolation requires an image/infra-level chroot or per-namespace mount

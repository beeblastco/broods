# Security

The sandbox runs model-driven code, so the harness treats everything inside it as
untrusted. Two boundaries matter: **credential isolation** (no host secret reaches a run)
and **workspace scoping** (a run can only touch its own files).

## Credential isolation

- **Child processes start from a cleared environment.** Each run does `env_clear()` first,
  so the harness runtime's `process.env` — including the broad AWS credentials it holds —
  is never inherited. Only the keys you declare in `config.envVars` reach the run, plus the
  reserved runtime vars (`PATH`, `HOME`, `TMPDIR`, …) the image sets.
- **No account secret enters the sandbox.** Background jobs authenticate their completion
  callback with a short-lived **per-job token**, never the account key.
- **Workspace mounts use scoped, short-lived credentials.** For a workspace-backed run the
  harness assumes a namespace-scoped STS role and delivers only those prefix-scoped
  credentials to the mount (`lambda` passes them in the ≤16 KB run-hook payload; `daytona`
  and `sandbox` inject them for `mount-s3`). Sandbox code can reach only this workspace's
  key prefix (and the skills bucket read-only), never the harness runtime's broader
  permissions.

## Workspace scoping

- The workspace mount is **rooted at the run's `<namespace>/` prefix** — a run cannot see
  another workspace's files.
- File tools (`read`/`write`/`edit`/`glob`/`grep`) **normalize paths to the workspace and
  reject directory traversal** (`..`, absolute paths, whole-filesystem scans) before the
  command reaches a provider.
- Workspace-backed `bash` likewise rejects obvious attempts to use absolute paths, parent
  traversal, or whole-filesystem scans. This is a guardrail on a general VM, **not** a hard
  cross-workspace filesystem boundary — the kernel-grade isolation is the sandbox itself
  (Firecracker for `lambda`/`sandbox`).
- The workspace and skills S3 buckets **block public access**.

## Runtime allow-list

`config.runtimes` is a **best-effort** allow-list (e.g. `["bash", "python", "node"]`): the
`bash` tool rejects obvious disallowed runtime invocations and surfaces the allowed list in
its description. On a general VM this cannot be a hard isolation boundary — treat it as a
prompt-shaping convenience, not a security control.

## Network and approvals

- Outbound access is gated by [`network.mode`](networking.md) (egress connector or policy
  for `restricted`/`deny-all`).
- Each `lambda` exec is authenticated by a short-lived (≤15 min) per-call JWE token scoped
  to the proxy port.
- Tool approvals are governed by the sandbox `permissionMode` (`edit` | `ask` | `bypass`),
  see [Workspace & Sandbox](../index.md).

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
- Workspace-backed `bash` rejects parent traversal (`..`) so it is not the trivial way
  around the file tools. Treat this as a **guardrail, not a boundary**: it inspects the
  literal command text, and a shell expands `$'\x2e\x2e'`, `$(printf ..)`, or a variable
  after that check runs. What actually contains a run is the sandbox itself (Firecracker
  for `lambda`/`sandbox`) plus the prefix-scoped mount credentials — no amount of traversal
  reaches another workspace's files. `bash` does **not** restrict reads elsewhere in the
  sandbox: a run reading its own machine's system files crosses no boundary.
- What `bash` does gate is **durability**, not access: the workspace mount is the only
  storage that outlives the sandbox, so writes to an absolute path outside it are rejected
  with the workspace path to use instead. `/tmp` and `/var/tmp` are exempt — writing there
  is a deliberate "this is throwaway". The gate also steps aside when the workspace runs on
  the agent's **own** `persistent` sandbox, because that filesystem survives between calls
  (see [Whose sandbox is it?](../index.md)). A `persistent` sandbox the workspace only
  **borrows** keeps its filesystem between calls too, but stays gated — it is an execution
  layer, not the agent's machine.
  Two lifetimes are in play and they are not the same: a single **call** ends when the
  command returns, while a **reservation** spans many calls and ends on idle expiry or
  release. `persistent` is what makes the filesystem outlive the call; nothing makes it
  outlive the reservation. So the mount is still the only storage that survives the sandbox
  itself — the gate is about that, not about how long the machine happens to stick around.
  (A workspace-less `sandbox: true` run has no namespace to key a reservation on, so it
  reserves on a key derived per agent — or on the `options.reservationKey` you pin. Both
  forms are account-scoped before they reach the reservation registry, so no key an
  author writes can name another account's machine.)
  See [Network](./lambda.md) for the egress boundary, which is a genuine security control.
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

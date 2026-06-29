# E2B

Uses an [E2B](https://e2b.dev/docs) template for sandbox runs. The current harness does
not wire E2B into the shared S3 workspace mount. E2B is available for sandbox compute,
but attaching an S3 workspace to an E2B sandbox is rejected until E2B Volumes or bucket
mounts are wired into the workspace contract.

## Configuration

```json
{
  "name": "e2b",
  "config": {
    "provider": "e2b",
    "network": { "mode": "allow-all" },
    "permissionMode": "ask",
    "options": {
      "apiKey": "...",
      "template": "runtime-template",
      "workspaceRoot": "/mnt/workspaces"
    }
  }
}
```

E2B cannot enforce egress restrictions, so validation requires `network.mode` to be
`allow-all` explicitly — `deny-all` (the default when omitted) and `restricted` are
rejected. `apiKey` can be omitted when `E2B_API_KEY` is set on the harness runtime.
`templateId` is an alias for `template`.

## Persistent mode

Set `persistent: true` to reserve one long-lived sandbox per workspace. The executor maps
`lifecycle.idleTimeoutSeconds` to the E2B sandbox timeout with `onTimeout: "pause"`, so an
idle sandbox snapshots and resumes (files, installs, and processes survive). Reserved
sandboxes are tracked in the instance store and reconnected on later calls.

E2B background execution uses the native E2B command API (`commands.run` with
`background: true`) and disconnects from the returned command handle after launch. It does
not use the harness `.fp-jobs` marker files, so E2B can launch detached work and deliver
completion through the existing callback/result row path, but it does not expose the
`sandbox`/Daytona/Vercel live log-tail and stop controls.

`onCreate` / `onResume` hooks are not accepted for E2B in this harness. Put setup in the
E2B template or run explicit setup commands in a persistent sandbox.

E2B also documents native Volumes and cloud bucket mounts through custom templates and
runtime commands such as `s3fs`. Those are provider capabilities, not part of this harness
integration yet. If E2B workspace sharing is added later, prefer E2B's native SDK/storage
primitives first and avoid introducing a second custom workspace path.

## Requirements

Use a template with Node and Python installed. Python is required only when the harness
wraps a background bash job with its completion callback. Workspace-backed
`read`/`write`/`edit`/`glob`/`grep`/`bash` fail fast because E2B does not currently
mount the shared S3 workspace in this harness.

## Execution Notes

See [E2B runtime documentation](https://e2b.dev/docs) for supported runtimes and
environment setup. The executor runs the tool's bash command as-is inside the sandbox.

`sandbox.envVars` is forwarded as the command's `envs`, so configured variables are
visible to executed files.

## What the model sees

Stateless configs behave like a temporary Linux shell: only `bash` is available, files do
not persist across calls, and dependent files should be written and run in one command,
usually under `/tmp`.

Persistent configs keep E2B sandbox state, but they are not currently valid S3 workspace
mounts. Use E2B without a workspace, or wire E2B storage into the workspace contract first.

## Dependencies

Use a template image with packages installed during template build, or install into a
persistent sandbox with an explicit setup command.

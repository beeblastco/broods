# E2B

Uses an [E2B](https://e2b.dev/docs) template for sandbox runs. E2B has no S3 mount:
stateless configs get `bash` only, and workspace-backed filesystem tools require
`persistent: true` (a reserved sandbox whose native filesystem holds the workspace files).

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
sandboxes are tracked in the instance store and reconnected on later calls; `onCreate` /
`onResume` hooks and detached background jobs work as described in
[the sandbox overview](index.md#reserved-persistent-sandboxes). Workspace files live under
`<workspaceRoot>/<namespace>` (default `/mnt/workspaces`).

## Requirements

Use a template with Node and Python installed. Without `persistent: true` there is no
workspace filesystem, so workspace-backed `read`/`write`/`edit`/`glob`/`grep`/`bash`
fail fast.

## Execution Notes

See [E2B runtime documentation](https://e2b.dev/docs) for supported runtimes and
environment setup. The executor runs the tool's bash command as-is inside the sandbox.

`sandbox.envVars` is forwarded as the command's `envs`, so configured variables are
visible to executed files.

## What the model sees

Stateless configs behave like a temporary Linux shell: only `bash` is available, files do
not persist across calls, and dependent files should be written and run in one command,
usually under `/tmp`.

Persistent configs follow the same model-facing contract as the other providers: `bash`
starts in the workspace root, examples use relative paths, and the default underlying
root is `/mnt/workspaces/<namespace>`.

## Dependencies

Use a template image with packages installed during template build, or install into a
persistent sandbox once via `onCreate`.

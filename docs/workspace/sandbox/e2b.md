# E2B

Uses an [E2B](https://e2b.dev/docs) template for stateless sandbox runs. Persistent
workspace-backed filesystem tools are currently disabled for E2B unless an equivalent S3
mount integration is added.

## Configuration

```json
{
  "name": "e2b",
  "config": {
    "provider": "e2b",
    "permissionMode": "ask",
    "options": {
      "apiKey": "...",
      "template": "runtime-template",
      "workspaceRoot": "/workspace"
    }
  }
}
```

Reference the resulting `sandboxId` from `config.sandbox` for stateless `bash`, or from a
workspace only after the provider has a persistent mount strategy. `apiKey` can be omitted
when `E2B_API_KEY` is set on the harness runtime. `templateId` is an alias for `template`.

## Requirements

Use a template with Node and Python installed. The E2B executor does not sync workspace
files itself, so workspace-backed `read`/`write`/`edit`/`glob`/`grep`/`bash` fail fast
unless this provider grows a durable mount equivalent to Lambda/Daytona/Kubernetes.

## Execution Notes

See [E2B runtime documentation](https://e2b.dev/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled; use compiled JavaScript instead. `python <file>` is rewritten to `python3` at runtime.

`sandbox.envVars` is forwarded as the command's `envs`, so configured variables are visible to executed files.

## Dependencies

Use a template image with packages installed during template build.

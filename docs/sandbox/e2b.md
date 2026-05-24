# E2B

Uses an [E2B](https://e2b.dev/docs) template or volume with the workspace mounted at `options.workspaceRoot`.

## Configuration

```json
{
  "workspace": {
    "sandbox": {
      "enabled": true,
      "provider": "e2b",
      "options": {
        "apiKey": "...",
        "template": "mounted-template",
        "workspaceRoot": "/workspace"
      }
    }
  }
}
```

`apiKey` can be omitted when `E2B_API_KEY` is set on the harness runtime. `templateId` is an alias for `template`.

## Requirements

Use a template with Node and Python installed, and mount the workspace at `options.workspaceRoot`.

## Execution Notes

See [E2B runtime documentation](https://e2b.dev/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled — use compiled JavaScript instead.
`python <file>` is rewritten to `python3` at runtime.

## Workspace Mount

E2B volume or S3/FUSE template mounted at `options.workspaceRoot`.

## Dependencies

Use the mounted template/volume image with packages installed during template build.

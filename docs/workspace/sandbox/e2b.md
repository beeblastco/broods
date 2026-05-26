# E2B

Uses an [E2B](https://e2b.dev/docs) template with the S3 workspace bucket mounted at `options.workspaceRoot`.

## Configuration

```json
{
  "config": {
    "workspace": {
      "storage": {
        "provider": "s3"
      },
      "sandbox": {
        "provider": "e2b",
        "options": {
          "apiKey": "...",
          "template": "mounted-template",
          "workspaceRoot": "/workspace"
        }
      }
    }
  }
}
```

`apiKey` can be omitted when `E2B_API_KEY` is set on the harness runtime. `templateId` is an alias for `template`.

## Requirements

Use a template with Node and Python installed, and mount the S3 workspace bucket at `options.workspaceRoot`. The E2B executor does not sync files itself; the template must expose the same bucket namespace that Lambda uses.

## Execution Notes

See [E2B runtime documentation](https://e2b.dev/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled; use compiled JavaScript instead. `python <file>` is rewritten to `python3` at runtime.

## Workspace Mount

Use an S3/FUSE template mounted at `options.workspaceRoot`. The mount must contain the account filesystem namespace directly under that root, for example `/workspace/fs-...`.

## Dependencies

Use the mounted template or volume image with packages installed during template build.

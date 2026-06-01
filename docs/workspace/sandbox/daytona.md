# Daytona

Uses a [Daytona](https://daytona.io/docs) sandbox with an S3 workspace mount at
`options.workspaceRoot/<namespace>`.

## Configuration

```json
{
  "name": "daytona",
  "config": {
    "provider": "daytona",
    "permissionMode": "ask",
    "options": {
      "apiKey": "...",
      "organizationId": "...",
      "apiUrl": "https://app.daytona.io/api",
      "target": "default",
      "snapshot": "fuse-s3",
      "workspaceRoot": "/mnt/workspaces",
      "mountAwsS3Buckets": true
    }
  }
}
```

Reference the resulting `sandboxId` from `config.sandbox` or `config.workspaces[].sandbox`.
`apiKey`, `organizationId`, `apiUrl`, and `target` can be omitted when
`DAYTONA_API_KEY`, `DAYTONA_ORGANIZATION_ID`, `DAYTONA_API_URL`, and `DAYTONA_TARGET` are set.

Use `snapshot` for Daytona snapshots. Use `image` only when creating the sandbox from a Docker/OCI image. For the current AWS-backed workspace, build the reusable `mount-s3` snapshot first:

```bash
bun run daytona:s3-snapshot
```

`sandbox.envVars` passes additional environment variables into the sandbox container. All providers honor it (Lambda, E2B, and Daytona).

## Requirements

Use an image or target with Node and Python installed. For persistent workspace tools,
set `options.mountAwsS3Buckets: true`; the executor mounts the selected
`sandbox/<namespace>/` prefix at `options.workspaceRoot/<namespace>`.

## Execution Notes

See [Daytona runtime documentation](https://daytona.io/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled; use compiled JavaScript instead. `python <file>` is rewritten to `python3` at runtime.

## AWS S3 Workspace Mount

See Daytona's [Amazon S3 mount docs](https://www.daytona.io/docs/en/mount-external-storage/#mount-an-amazon-s3-bucket) for the underlying `mount-s3` setup.

Set `options.mountAwsS3Buckets` to `true` to mount the current `FILESYSTEM_BUCKET_NAME`
bucket at `options.workspaceRoot/<namespace>`. This is required for the Daytona provider
to see the same files as the Lambda bash tool.

The snapshot must include `mount-s3`; use `bun run daytona:s3-snapshot` to build it from `daytonaio/sandbox:0.8.0`.

The executor passes AWS credentials and region into the Daytona sandbox for `mount-s3`.
Treat Daytona sandboxes as trusted account-controlled compute when this option is enabled.

Override defaults with:

```json
{
  "workspaceBucketName": "my-workspace-bucket",
  "awsRegion": "eu-central-1"
}
```

## Dependencies

Use an image or image builder with packages installed before runtime.

# Daytona

Uses a [Daytona](https://daytona.io/docs) sandbox with an S3 workspace mount at
`options.workspaceRoot/<namespace>`. The default `workspaceRoot` is `/mnt/workspaces`
so Daytona matches Lambda and Kubernetes.

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

`sandbox.envVars` passes additional environment variables into the sandbox container. All providers honor it.

`network.mode` maps to Daytona's `networkBlockAll` (`allow-all` → `false`, `deny-all` → `true`); `restricted` applies the CIDR allowlist only — domain allowlists are ignored with a warning.

Persistent mode (`persistent: true`) reserves one Daytona sandbox per workspace: idle/lifetime settings map to Daytona's `autoStopInterval`/`autoDeleteInterval`, the instance is tracked and reconnected across calls, and `onCreate`/`onResume` hooks plus detached background jobs work as described in [the sandbox overview](index.md#reserved-persistent-sandboxes).

## Requirements

Use an image or target with Node and Python installed. For persistent workspace tools,
set `options.mountAwsS3Buckets: true`; the executor mounts the selected
`sandbox/<namespace>/` prefix at `options.workspaceRoot/<namespace>`.

## What the model sees

For workspace-backed runs, the model should see a normal project directory. `bash` starts
in the selected workspace directory:

```bash
pwd                 # current workspace directory
ls                  # files in this workspace
python3 script.py
```

Use relative paths in prompts and examples. `options.workspaceRoot` is an implementation
setting for the mount location, not a path the model needs for normal file work.

## Execution Notes

See [Daytona runtime documentation](https://daytona.io/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled; use compiled JavaScript instead. The executor runs the tool's bash command as-is, so use `python3` explicitly.

## AWS S3 Workspace Mount

See Daytona's [Amazon S3 mount docs](https://www.daytona.io/docs/en/mount-external-storage/#mount-an-amazon-s3-bucket) for the underlying `mount-s3` setup.

Set `options.mountAwsS3Buckets` to `true` to mount the current `FILESYSTEM_BUCKET_NAME`
bucket at `options.workspaceRoot/<namespace>`. This is required for the Daytona provider
to see the same files as the Lambda bash tool.

The snapshot must include `mount-s3`; use `bun run daytona:s3-snapshot` to build it. The script requires `DAYTONA_S3_SNAPSHOT_BASE_IMAGE` (base image to build from) and `DAYTONA_S3_SNAPSHOT_NAME` (snapshot name) to be set.

When `SKILLS_BUCKET_NAME` is set on the harness, the executor also mounts the account skills bucket read-only at `options.skillsMountPath` (default `/mnt/skills`); override the bucket with `options.skillsBucketName`.

The executor assumes the deployed `sandbox-s3mount` IAM role and passes the resulting
short-lived, prefix-scoped credentials into the Daytona sandbox for `mount-s3` — sandbox
code can only reach this workspace's own key prefix and the skills bucket (read-only),
never the harness runtime's broader permissions. Without the role
(`SANDBOX_MOUNT_ROLE_ARN` unset, e.g. self-managed deployments), supply
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` through the sandbox `envVars` instead.

Override defaults with:

```json
{
  "workspaceBucketName": "my-workspace-bucket",
  "awsRegion": "eu-central-1"
}
```

## Dependencies

Use an image or image builder with packages installed before runtime.

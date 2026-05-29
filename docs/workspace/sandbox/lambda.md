# Lambda

The default sandbox provider. SST deploys private runtime Lambdas and one AWS S3 Files filesystem backed by the workspace S3 bucket.

## Runtime Functions

| Function | Runtime | Executes |
| --- | --- | --- |
| `SandboxBash` | `nodejs22.x` | Bash-like shell scripts through [`just bash`](https://github.com/vercel-labs/just-bash), plus native `.js` and `.ts` files |
| `SandboxNode` | `nodejs22.x` | Legacy mounted `.js` and `.ts` file execution |
| `SandboxPython` | `python3.12` | `.py` files |

Each runtime Lambda executes files with its own interpreter binary (`process.execPath` for Node and `sys.executable` for Python), so execution does not depend on `node` or `python3` being present on the sanitized `PATH`. The Lambda functions are configured with at least 512 MB memory because AWS S3 Files direct reads require that for Lambda.

## How it Works

The main `harness-processing` Lambda invokes sandbox functions with:

- `SANDBOX_BASH_FUNCTION_NAME`
- `SANDBOX_NODE_FUNCTION_NAME`
- `SANDBOX_PYTHON_FUNCTION_NAME`

You can override those names per agent:

```json
{
  "config": {
    "workspace": {
      "storage": {
        "provider": "s3"
      },
      "sandbox": {
        "options": {
          "bashFunctionName": "my-bash-sandbox",
          "nodeFunctionName": "my-node-sandbox",
          "pythonFunctionName": "my-python-sandbox",
          "workspaceRoot": "/mnt/workspaces",
          "networkAccess": "disabled"
        }
      }
    }
  }
}
```

The default Lambda provider is deployed by SST. Do not configure public Lambda Function URLs for sandbox functions; `harness-processing` invokes them by function ARN.

## Supported Runtimes

| Runtime | Command | File extension |
| --- | --- | --- |
| Shell | bash-like scripts | `just-bash` [command set](https://github.com/vercel-labs/just-bash) |
| Node | `node <file>` | `.js` |
| TypeScript | `node <file>` | `.ts` — transpiled inside `SandboxBash` before execution |
| Python | `python <file>` or `python3 <file>` | `.py` |

## Workspace Mount

AWS S3 Files are mounted into the private runtime Lambdas at `/mnt/workspaces`. The S3 Files mount target allows NFS only from the sandbox VPC security group. `SandboxBash` roots `just-bash` at `/mnt/workspaces/<namespace>`, so shell redirects and file commands write through the mounted filesystem.

Lambda exposes a single `fileSystemConfig` per function, so the deployed sandbox mounts only the workspace S3 Files filesystem. Skill scripts are still available: when `load_skill` runs for a workspace-enabled agent, `harness-processing` stages that skill bundle from the skills bucket into the workspace namespace at `/.skills/<skill-name>`. A stage manifest lets publishing-enabled agents preserve staged edits across repeated loads; publishing-disabled agents refresh from the source skill on later loads. Changed files use S3 server-side copy. This avoids a second Lambda mount and keeps sandbox execution on the existing workspace bucket.

## File Artifacts

For `SandboxBash`, file changes are written directly to the S3 Files mount. For Python runs, changed files created by the sandbox runtime are returned as file artifacts and persisted back into the workspace S3 bucket.

## Dependencies

Bundle packages into the runtime artifact or attach a Lambda layer.

## Security

- Lambda sandbox functions have no public Function URLs.
- Sandbox runtime Lambdas do not need account-management permissions.
- `curl` is disabled by default. When `options.networkAccess` is `"public"`, `SandboxBash` enables `just-bash` network access with private and loopback ranges denied.

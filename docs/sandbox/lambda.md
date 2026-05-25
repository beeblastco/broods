# Lambda

The default sandbox provider. SST deploys two private runtime Lambdas and one AWS S3 Files filesystem backed by the workspace S3 bucket.

## Runtime Functions

| Function | Runtime | Executes |
| --- | --- | --- |
| `SandboxNode` | `nodejs22.x` | Mounted `.js` files and mounted `.ts` files transpiled inside the runtime |
| `SandboxPython` | `python3.12` | `.py` files |

Each runtime Lambda executes files with its own interpreter binary (`process.execPath` for Node and `sys.executable` for Python), so execution does not depend on `node` or `python3` being present on the sanitized `PATH`. The Lambda functions are configured with at least 512 MB memory because AWS S3 Files direct reads require that for Lambda.

## How it Works

The main `harness-processing` Lambda invokes those functions with:

- `SANDBOX_NODE_FUNCTION_NAME`
- `SANDBOX_PYTHON_FUNCTION_NAME`

You can override those names per agent:

```json
{
  "workspace": {
    "sandbox": {
      "options": {
        "nodeFunctionName": "my-node-sandbox",
        "pythonFunctionName": "my-python-sandbox",
        "workspaceRoot": "/mnt/workspaces"
      }
    }
  }
}
```

The default Lambda provider is deployed by SST. Do not configure public Lambda Function URLs for `SandboxNode` or `SandboxPython`; `harness-processing` invokes them by function ARN.

## Supported Runtimes

| Runtime | Command | File extension |
| --- | --- | --- |
| Node | `node <file>` | `.js` |
| TypeScript | `node <file>` | `.ts` — transpiled inside the runtime before execution |
| Python | `python <file>` or `python3 <file>` | `.py` |

## Workspace Mount

AWS S3 Files are mounted into the private runtime Lambdas at `/mnt/workspaces`. The S3 Files mount target allows NFS only from the sandbox VPC security group.

## File Artifacts

For Lambda runs, changed files created by the sandbox runtime are returned as file artifacts and persisted back into the workspace S3 bucket. This is what makes a file such as `result.json`, written from Python or Node with normal relative file APIs, readable later through `cat /result.json`. Generated artifacts are capped before being persisted.

## Dependencies

Bundle packages into the runtime artifact or attach a Lambda layer.

## Security

- Lambda sandbox functions have no public Function URLs.
- Sandbox runtime Lambdas do not need account-management permissions.
- Sandbox runtime Lambdas run in the sandbox VPC without NAT, so they can reach the mounted workspace filesystem but cannot open arbitrary public internet connections.

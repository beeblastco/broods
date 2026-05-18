# Sandbox

The workspace sandbox lets an agent execute code that it has already written into the workspace filesystem. It extends the existing `filesystem` tool; there is no separate model-facing sandbox tool.

```mermaid
flowchart LR
  A[Agent] --> B[filesystem tool]
  B --> C[write file to workspace S3]
  B --> D[node/python file command]
  D --> E{Sandbox provider}
  E --> F[Lambda + S3 Files mount]
  E --> G[E2B mounted workspace]
  E --> H[Daytona mounted workspace]
  F --> I[Structured result]
  G --> I
  H --> I
```

## Enable It

Sandbox execution is available only when workspace and sandbox are enabled for the agent.

```json
{
  "workspace": {
    "enabled": true,
    "needsApproval": false,
    "filesystem": { "enabled": true },
    "sandbox": {
      "enabled": true,
      "provider": "lambda",
      "timeout": 30,
      "memoryLimit": 512,
      "outputLimitBytes": 65536,
      "filesystem": { "mount": "native" }
    }
  }
}
```

`provider` can be:

| Provider | Purpose |
| --- | --- |
| `lambda` | Default AWS runtime sandbox. Runs private Node and Python Lambda workers on an AWS S3 Files mount. |
| `e2b` | Uses an E2B template or volume with the workspace mounted at `options.workspaceRoot`. |
| `daytona` | Uses a Daytona volume or external storage mount at `options.workspaceRoot`. |

## How Agents Use It

The agent must write a file first, then execute that file.

```bash
cat <<'EOF' > /main.js
console.log(JSON.stringify({ ok: true, runtime: "node" }));
EOF

node /main.js
```

```bash
cat <<'EOF' > /main.py
print({"ok": True, "runtime": "python"})
EOF

python3 /main.py
```

Sandboxed code can also read and write nearby workspace files with normal file APIs:

```bash
python3 analyze.py sample.wav
```

```py
from pathlib import Path

data = Path("sample.wav").read_bytes()
Path("summary.txt").write_text(str(len(data)))
```

Supported execution commands:

| Runtime | Command |
| --- | --- |
| Node | `node <file.js>` |
| TypeScript | `node <file.ts>`; the Node runtime transpiles the mounted file inside the namespace before execution |
| Python | `python <file.py>` or `python3 <file.py>` |

Inline execution is intentionally rejected. Commands such as `node -e "..."` and `python -c "..."` are not allowed.

## Result Shape

Sandbox runs return JSON through the filesystem tool:

```json
{
  "output": {
    "stdout": "hello\n",
    "stderr": "",
    "artifacts": []
  },
  "status": {
    "ok": true,
    "runtime": "node",
    "provider": "lambda",
    "exitCode": 0,
    "durationMs": 42,
    "timedOut": false,
    "truncated": false
  }
}
```

`artifacts` is reserved for provider outputs such as charts, images, or files when a provider can return them.

## Mounted Workspace

Every provider uses a native mounted workspace. The runtime executes from the namespace root, so relative paths behave like normal bash.

| Provider | Mount strategy |
| --- | --- |
| `lambda` | AWS S3 Files mounted into the private runtime Lambdas at `/mnt/workspaces` |
| `e2b` | E2B volume or S3/FUSE template mounted at `options.workspaceRoot` |
| `daytona` | Daytona volume or external storage mounted at `options.workspaceRoot` |

## Lambda Runtime

SST deploys two private runtime Lambdas and one AWS S3 Files filesystem backed by the workspace S3 bucket:

| Function | Runtime | Executes |
| --- | --- | --- |
| `SandboxNode` | `nodejs22.x` | Mounted `.js` files and mounted `.ts` files transpiled inside the runtime |
| `SandboxPython` | `python3.12` | `.py` files |

Each runtime Lambda executes files with its own interpreter binary (`process.execPath` for Node and `sys.executable` for Python), so execution does not depend on `node` or `python3` being present on the sanitized `PATH`. The Lambda functions are configured with at least 512 MB memory because AWS S3 Files direct reads require that for Lambda.

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

## Dependency Strategy

Dependencies are not an account config field.

Use provider images/templates for packages:

- Lambda: bundle packages into the runtime artifact or attach a Lambda layer.
- E2B: use the mounted template/volume image with packages installed during template build.
- Daytona: use an image or image builder with packages installed before runtime.

Runtime package installation requires network egress and has a larger security surface. If Lambda runtime installs are needed later, add a separate opt-in sandbox provider mode with:

- no application secrets in environment variables
- minimal IAM permissions, ideally only CloudWatch Logs
- no permission to access account tables, S3 buckets, or model/provider secrets
- explicit egress controls
- clear timeout and output limits

## Security Boundaries

The sandbox path is designed around mounted, file-based runs:

- only allowlisted runtimes are exposed
- execution requires an existing workspace file
- inline code flags are rejected
- stdout/stderr are truncated
- Lambda provider runs in private runtime functions on an S3 Files mount
- sandbox runtime Lambdas do not need account-management permissions
- child processes run without AWS credentials in their environment

Workspace write/read commands still use the normal `filesystem` tool. Use `workspace.needsApproval` if file writes and code runs should require human approval.

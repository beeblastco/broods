# Sandbox Reference

The workspace sandbox lets an agent execute code that it has already written into the workspace filesystem. It extends the existing `filesystem` tool; there is no separate model-facing sandbox tool.

```mermaid
flowchart LR
  A[Agent] --> B[filesystem tool]
  B --> C[write file to workspace S3]
  B --> D[node/python file command]
  D --> E{Sandbox provider}
  E --> F[Lambda + S3 Files mount]
  E --> G[E2B template with mounted workspace]
  E --> H[Daytona image with mounted workspace]
  F --> I[Structured result]
  G --> I
  H --> I
  I --> J[generated file artifacts persisted to S3]
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
      "outputLimitBytes": 65536
    }
  }
}
```

| Provider | Documentation |
| --- | --- |
| `lambda` | [Lambda Details](lambda.md) |
| `e2b` | [E2B Details](e2b.md) |
| `daytona` | [Daytona Details](daytona.md) |

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

| Runtime | Command | File extension |
| --- | --- | --- |
| Node | `node <file>` | `.js` |
| TypeScript | `node <file>` | `.ts` — transpiled before execution (Lambda only) |
| Python | `python <file>` or `python3 <file>` | `.py` |

Inline execution is intentionally rejected across all providers. Commands such as `node -e "..."` and `python -c "..."` are not allowed.

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

## Mounted Workspace

Every provider uses a native mounted workspace. The runtime executes from the namespace root, so relative paths behave like normal bash. See each provider page for the specific mount strategy.

The filesystem tool persists workspace files under the account/agent namespace before the sandbox starts. Third-party providers must make that same namespace visible under `options.workspaceRoot`; otherwise the command can start but the file the agent just wrote will not exist inside the provider sandbox.

## Output Truncation

Sandbox stdout and stderr are truncated at the byte limit configured by `outputLimitBytes` (default 65536). This prevents runaway output from blowing the Lambda invocation payload (6 MB max) or flooding the LLM's tool-result context window.

```json
{
  "workspace": {
    "sandbox": {
      "outputLimitBytes": 65536
    }
  }
}
```

When the limit is exceeded, the output is sliced at the cap and `[output truncated]` is appended.

All four executors (Lambda Node, Lambda Python, E2B, Daytona) apply identical truncation logic using the same `outputLimitBytes` value.

## Dependency Strategy

Dependencies are not an account config field. Use provider images/templates for packages — see each provider page for details. The Lambda provider VPC has no internet egress, so runtime package installation is not possible.

## Security Boundaries

The sandbox path is designed around mounted, file-based runs:

- only allowlisted runtimes are exposed
- execution requires an existing workspace file
- inline code flags are rejected
- stdout/stderr output is capped at `outputLimitBytes` (see [Output Truncation](#output-truncation))
- workspace and skills buckets block public access and deny S3 actions for principals outside the project runtime/deploy roles
- child processes run without AWS credentials in their environment

Workspace write/read commands still use the normal `filesystem` tool. Use `workspace.needsApproval` if file writes and code runs should require human approval.

# Lambda

The default sandbox provider. SST deploys private runtime Lambdas and one AWS S3 Files filesystem backed by the workspace S3 bucket.

## Runtime Functions

| Function | Runtime | Executes |
| --- | --- | --- |
| `SandboxBash` | `nodejs22.x` | Bash-like shell scripts through [`just bash`](https://github.com/vercel-labs/just-bash), plus native `.js` and `.ts` files |
| `SandboxPython` | `python3.12` | `.py` files |

`SandboxBash` runs files with `process.execPath` (real Node) and `SandboxPython` with `sys.executable`, so execution does not depend on `node` or `python3` being present on the sanitized `PATH`. Node files run inside `SandboxBash` — there is no separate Node Lambda. The Lambda functions are configured with at least 512 MB memory because AWS S3 Files direct reads require that for Lambda.

## How it Works

The main `harness-processing` Lambda invokes sandbox functions with:

- `SANDBOX_BASH_FUNCTION_NAME`
- `SANDBOX_PYTHON_FUNCTION_NAME`

You can override those names per agent, and inject environment variables into every sandbox runtime:

```json
{
  "config": {
    "workspace": {
      "storage": {
        "provider": "s3"
      },
      "sandbox": {
        "envVars": {
          "MY_API_BASE": "https://api.example.com"
        },
        "options": {
          "bashFunctionName": "my-bash-sandbox",
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

## Environment Variables

Add `config.workspace.sandbox.envVars` as a flat object of string key/value pairs. Each entry is injected into every sandbox runtime — shell, Node, and Python:

```json
{
  "config": {
    "workspace": {
      "sandbox": {
        "envVars": {
          "MY_API_BASE": "https://api.example.com",
          "FEATURE_FLAG": "on"
        }
      }
    }
  }
}
```

The agent reads them like normal environment variables:

| Runtime | How the value is read |
| --- | --- |
| Shell | `echo $MY_API_BASE` |
| Node | `process.env.MY_API_BASE` |
| Python | `os.environ["MY_API_BASE"]` |

Rules:

- **Reserved runtime vars always win.** `PATH`, `HOME`, `TMPDIR`, `NODE_OPTIONS` (and Python's `PYTHONPATH`) cannot be overridden, even if you list them in `env`.
- **The host Lambda's `process.env` is never inherited.** Only the keys you declare reach the sandbox — AWS credentials and other harness env vars stay out.
- Values must be strings. Add secrets through `env` rather than hardcoding them in scripts.

## Supported Runtimes

| Runtime | Command | File extension |
| --- | --- | --- |
| Shell | bash-like scripts | `just-bash` [command set](https://github.com/vercel-labs/just-bash) |
| Node | `node <file>` | `.js` |
| TypeScript | `node <file>` | `.ts` — transpiled inside `SandboxBash` before execution |
| Python | `python <file>` or `python3 <file>` (run standalone for native CPython) | `.py` |

### Node execution fidelity

`node <file>` inside `SandboxBash` is **not** run on just-bash's built-in `js-exec` (QuickJS WASM, which only ships a curated subset of Node built-ins). just-bash's JS runtime is disabled (`javascript: false`); a registered `node` command spawns the real `process.execPath`, so files run on full Node 22. The remaining limits are operational, not language-fidelity:

- File-only: no `node -e` / REPL / stdin scripts; `.js` and `.ts` only.
- No package manager on the sanitized `PATH` (no `npm`/`npx`/`yarn`): only Node built-in modules plus any `node_modules` already present in the workspace.
- Minimal env: only `sandbox.envVars` plus the reserved runtime vars (`PATH`, `HOME=/tmp`, `TMPDIR`, `NODE_OPTIONS`) reach the process; the host Lambda's `process.env` is not inherited.
- TypeScript is single-file transpile-only (transpiled to CommonJS, no type-check, no cross-file imports). `import`/`export` work out of the box; top-level `await` does not (wrap it in an async function).

### Python execution fidelity

Run Python as a **standalone** command — `python3 <file>.py` or `python <file>.py`. The bash tool routes those to `SandboxPython` (native CPython 3.12, full stdlib, file artifacts persisted back to the workspace). This is the best-performance, full-fidelity path.

When `python`/`python3` is invoked **inside a larger shell command** (e.g. a heredoc file-write and the run in the same call), it can't be routed out — and there is no Python runtime inside `SandboxBash`. just-bash's in-process WASM Python (`python: false`) is disabled: it runs in a sibling `worker.js` asset that esbuild doesn't emit next to the bundled Lambda, so the worker never starts and the run crashes the whole shell call (`Runtime.NodeJsExit`). Instead, `SandboxBash` registers `python`/`python3` stub commands that fail cleanly with exit code `127` and a message telling the caller to run Python on its own line. **Write the `.py` file in one call, then run it standalone in the next** so it routes to `SandboxPython`.

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

# Sandboxes

A sandbox is a Linux machine where your agent runs code. It gives the agent a `bash` tool with real `bash`, `python3` and `node` on the PATH, and, together with a [workspace](../workspaces.md), the file tools `read`, `write`, `edit`, `glob` and `grep`. An agent that only talks and calls APIs does not need one. Add a sandbox when the agent should run scripts, process files, install packages or drive a computer.

```ts title="broods/index.ts"
import { defineAgent, defineSandbox, env } from "broods";

export const box = defineSandbox({
  name: "box",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "ask",
  timeout: 60,
});

export const myAgent = defineAgent({
  name: "my-agent",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  sandboxes: [box],
});
```

Only `provider` is required. Without a workspace every `bash` call gets a fresh machine, so nothing survives between calls. Attach a workspace for files that persist, or make the sandbox [persistent](persistent.md) to keep installed packages and running processes.

## Providers

| Provider  | What it is                   | Workspace mount | Persistent            | Background jobs         | Network enforcement            |
| --------- | ---------------------------- | --------------- | --------------------- | ----------------------- | ------------------------------ |
| `sandbox` | Broods-hosted Firecracker VM | yes             | yes, pause and resume | yes, with logs and stop | all modes, domain + CIDR lists |
| `lambda`  | AWS Lambda MicroVM           | yes             | yes, 8 h max per VM   | yes, with logs and stop | `allow-all` or no internet     |
| `daytona` | Daytona sandbox              | yes             | yes, native auto-stop | yes, with logs and stop | all modes, CIDR lists only     |
| `e2b`     | E2B template                 | no              | yes, pause on timeout | yes, no logs or stop    | `allow-all` only               |
| `vercel`  | Vercel Sandbox               | no              | yes, named sandbox    | yes, with logs and stop | all modes, domain + CIDR lists |
| `machine` | Your own computer            | no              | no                    | no                      | `allow-all` only               |

`sandbox` is the default provider. Attaching a workspace to an `e2b`, `vercel` or `machine` sandbox is rejected rather than falling back to provider storage. Setup, options and quirks per provider are on [Providers](providers.md), and the `machine` provider has its own page, [Your computer](machine.md).

## Configuration

| Field                  | Default                | What it does                                                                                                      |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `provider`             | `sandbox`              | Compute backend, from the table above                                                                             |
| `fallbackProvider`     | none                   | Ephemeral only. Where a run goes when `provider` is out of capacity. Cannot be `machine`                          |
| `size`                 | provider default       | Compute footprint, see [Sizes](#sizes)                                                                            |
| `snapshot`             | provider default       | Prebuilt image to boot from, see [Images](#images)                                                                |
| `network`              | `{ mode: "deny-all" }` | Outbound access, see [Network](#network)                                                                          |
| `permissionMode`       | `ask`                  | Which tool calls need approval, see below                                                                         |
| `runtimes`             | all                    | Advisory list of `bash`, `python`, `node`. The tool rejects obvious other runtimes. Not a security boundary       |
| `timeout`              | 30                     | Seconds per call. Maximum 600                                                                                     |
| `memoryLimit`          | none                   | MB. Validated, maximum 8192 on `lambda`, but executors do not resize to it                                        |
| `outputLimitBytes`     | 65536                  | Output kept per call. Maximum 262144                                                                              |
| `envVars`              | none                   | Variables injected into every run. Accepts `env("NAME")`. Encrypted at rest                                       |
| `options`              | none                   | Provider-specific settings, see [Providers](providers.md). On `lambda`, only `workspaceRoot` and `reservationKey` |
| `persistent`           | `false`                | Reserve a long-lived machine, see [Persistent sandboxes](persistent.md)                                           |
| `lifecycle`            | none                   | `idleTimeoutSeconds`, `maxLifetimeSeconds`. Needs `persistent: true`                                              |
| `onCreate`, `onResume` | none                   | Setup commands. Need `persistent: true`, not supported on `e2b`                                                   |

`envVars` cannot override the runtime's reserved names. Those are `PATH`, `HOME`, `LD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND` and the background-job slots. Those entries are dropped. The host environment, including any cloud credentials, never reaches a run.

A call that blocks is capped at 600 seconds on every provider. Background jobs are not bound by the call timeout.

### Permission mode

| Mode     | `read`, `glob`, `grep` | `write`, `edit` | `bash` |
| -------- | ---------------------- | --------------- | ------ |
| `ask`    | auto                   | ask             | ask    |
| `edit`   | auto                   | auto            | ask    |
| `bypass` | auto                   | auto            | auto   |

Approval requests go to the caller over the direct API or WebSocket. Channels cannot answer an approval, so a tool that needs one is denied on a channel turn. Use `bypass` or `edit` for sandboxes that serve channel agents.

### Network

| Mode         | Meaning                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `allow-all`  | Outbound internet allowed                                                 |
| `deny-all`   | No outbound internet                                                      |
| `restricted` | Only `allowDomains` and `allowCidrs`, where the provider can enforce them |

```ts
network: {
  mode: "restricted",
  allowDomains: ["api.example.com"],
  allowCidrs: ["10.0.0.0/8"],
},
```

| Provider  | `allow-all` | `deny-all` | `restricted`                                                 |
| --------- | ----------- | ---------- | ------------------------------------------------------------ |
| `sandbox` | allowed     | denied     | domain and CIDR allowlist                                    |
| `lambda`  | allowed     | denied     | same as `deny-all`. Allowlists are rejected at validation    |
| `daytona` | allowed     | denied     | CIDR allowlist only. Domain lists are ignored with a warning |
| `vercel`  | allowed     | denied     | domain and CIDR allowlist                                    |
| `e2b`     | allowed     | rejected   | rejected                                                     |
| `machine` | allowed     | rejected   | rejected                                                     |

A provider that cannot enforce a mode rejects the config instead of quietly granting more access. Background jobs report back to the platform over the network, so under `deny-all` a job still runs but its result has to be polled. See [Persistent sandboxes](persistent.md#background-jobs).

## Sizes

| Size     | vCPU | Memory | Disk  | Tier          |
| -------- | ---- | ------ | ----- | ------------- |
| `tiny`   | 0.25 | 0.5 GB | 8 GB  | free          |
| `xsmall` | 0.5  | 1 GB   | 8 GB  | free, default |
| `small`  | 1    | 2 GB   | 8 GB  | paid          |
| `medium` | 2    | 4 GB   | 16 GB | paid          |
| `large`  | 4    | 8 GB   | 32 GB | paid          |

Only the `sandbox` provider applies the size to the machine it creates, and it rounds `tiny` up to 0.5 vCPU. On `lambda` the image fixes the machine, so the size is display-only. `daytona`, `e2b` and `vercel` size machines through their own options, and there the size only sets what the dashboard shows. Every provider accepts every size name.

## Images

Set `snapshot` to boot a prebuilt image instead of the provider default. Bake heavy toolchains into an image once rather than installing them on every cold start.

- `sandbox` boots the named image. The dashboard's Create snapshot action captures a running `sandbox` instance into an image you can pin later. It is the only provider with that action.
- `lambda` selects a platform MicroVM image by ARN, in the same AWS account and region as the default image. A running MicroVM cannot be captured into a new image. Its state survives idle through suspend and resume instead.
- `daytona`, `e2b` and `vercel` pick images through their own `options`, such as Daytona `snapshot`, E2B `template` or Vercel `image`.

The dashboard Snapshots view shows which image each running instance booted from.

## More than one sandbox

An agent lists its sandboxes in `sandboxes`. The first one is the default. `bash` without a workspace runs there, a workspace without its own sandbox mounts it, and a [harness](../agents.md) runs on it. Add more when one agent needs a second kind of machine, such as a browser image or a deny-all box.

```ts
export const myAgent = defineAgent({
  name: "my-agent",
  sandboxes: [general, offline], // general is the default
});
```

The model reaches a later sandbox by passing its name to `bash`, here `sandbox: "offline"`. The file tools never run there, and no workspace is mounted, so nothing written there reaches durable storage. A `machine` sandbox anywhere in the list also gives the agent a `computer` tool. Each sandbox may appear once, and only the first may also back a workspace.

## What the model sees

With a workspace, `bash` starts in the workspace directory and file tools take relative paths. Tell the model to use relative paths such as `analysis.json` or `src/index.ts`. Provider mount paths belong in logs, not prompts.

```text
write  notes/a.txt          # creates parent folders
read   notes/a.txt          # numbered lines
edit   notes/a.txt          # exact, unique string replacement
glob   **/*.py              # newest first
grep   TODO                 # ripgrep
bash   python3 notes/run.py
```

Without a workspace only `bash` exists and each call is a new machine, so write and run in one command:

```bash
cat <<'EOF' > /tmp/run.py
print("ok")
EOF
python3 /tmp/run.py
```

`bash` also takes `pty: true` for programs that refuse to run without a terminal. The output then merges stderr into stdout and ends lines with CRLF, so leave it off when you need byte-exact output.

`bash` returns stdout and stderr as text. Output is truncated at `outputLimitBytes`.

## Examples

| Demo                                                                                                                        | Shows                                  |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [`sandbox`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox)                                           | Stateless bash on `sandbox`            |
| [`sandbox-lambda`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-lambda)                             | Stateless bash on `lambda`             |
| [`sandbox-workspace`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-workspace)                       | File tools on a workspace              |
| [`sandbox-workspace-persistent`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-workspace-persistent) | Persistent sandbox and background jobs |
| [`sandbox-multiple`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-multiple)                         | A default sandbox plus a deny-all one  |

How executors, mounts and credentials work inside the platform is covered in [Sandbox internals](../../internals/sandboxes.md).

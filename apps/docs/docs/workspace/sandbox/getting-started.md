# Getting Started

This walks through defining a sandbox, attaching it to an agent, and running real
code in it. For the concepts behind each knob, see [Core design](index.md).

## 1. Install the SDK

```bash
bun add broods
```

## 2. Define a sandbox

Sandboxes are declared in `broods/index.ts` and referenced from agents. The smallest
useful sandbox is a stateless, bash-only box — a fresh ephemeral container per call:

```ts title="broods/index.ts"
import { defineSandbox, defineAgent, env } from "broods";

export const sandbox = defineSandbox({
  name: "starter",
  config: {
    provider: "sandbox",        // self-hosted workdir (the default-featured backend)
    network: { mode: "deny-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: { system: "Use bash to write files and run code in the sandbox." },
    sandbox,
    publicAccess: true,
  },
});
```

Only `provider` is required; everything else has a safe default (network normalizes to
`deny-all`, `permissionMode` to `ask`, `timeout` to 30 s). Omitting `size` and `snapshot`
keeps the cheap default-create path.

## 3. Run it

Deploy the project (`broods deploy`) and stream the agent:

```ts title="index.ts"
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.myAgent, {
  input: "Write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
})) {
  if (chunk.type === "text-delta") process.stdout.write(chunk.text);
}
```

The agent's `bash`/`read`/`write`/`edit`/`glob`/`grep` tools each compile to a single
`run` against the provider you chose.

## 4. Add a workspace (persistent files)

A bare sandbox is ephemeral — only `bash` is available and each call is a fresh
container. Attach a [workspace](../index.md) to get a persistent project checkout (an S3
mount the file tools operate on) shared across `sandbox`, `lambda`, and `daytona`:

```ts
import { defineWorkspace } from "broods";

export const projectWorkspace = defineWorkspace({
  name: "project",
  config: { storage: { provider: "s3" }, harness: { enabled: true } },
});

// then on the agent: workspaces: [projectWorkspace]
```

## Runnable examples

| Demo | What it shows |
| --- | --- |
| [`sandbox`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox) | stateless bash-only `sandbox` (workdir) |
| [`sandbox-workspace`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-workspace) | workspace-backed file tools on `sandbox` |
| [`sandbox-workspace-persistent`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-workspace-persistent) | reserved (persistent) sandbox + background jobs |
| [`sandbox-lambda`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-lambda) | stateless bash-only `lambda` (AWS MicroVM) |
| [`sandbox-workspace-lambda`](https://github.com/beeblastco/broods/tree/dev/packages/demos/sandbox-workspace-lambda) | workspace-backed file tools on `lambda` |

## Next steps

- [Snapshot](snapshot.md) — pin a prebuilt image and pick a compute size.
- [Networking](networking.md) — control outbound egress per sandbox.
- [Security](security.md) — the isolation and credential model.
- [Hook](hook.md) — `onCreate`/`onResume` setup commands and runtime lifecycle hooks.
- [Best practice](best-practice.md) — persistent sandboxes, background jobs, and idle tuning.
- [Integration](lambda.md) — provider-specific behavior (Lambda, Daytona, E2B, Vercel).

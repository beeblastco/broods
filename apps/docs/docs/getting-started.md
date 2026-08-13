# Getting Started

Broods is a serverless AI agent platform. You define agents, workspaces, sandboxes, skills, and channels as typed TypeScript resources, sync them to the cloud with a CLI, and invoke them over a typed SDK or raw HTTP.

This guide uses the **managed service** at `gateway.broods.app`. If you prefer to self-host, see [Deployment](deployment.md) first, then return here — the CLI and SDK workflow is identical.

---

## Prerequisites

- [Bun](https://bun.sh/) 1.2+ (the CLI and SDK are built on Bun)
- A free [Broods dashboard](https://dashboard.broods.app) account

When you create your account or log in for the first time, Broods automatically provisions your API access. A one-time banner displays your account API secret (`fp_acct_...`) — copy it immediately, as it is shown only once. You can rotate it later under **Org Settings → API Access**.

## 1. Install the CLI & SDK

```bash
bun add -g broods
```

Or with npm:

```bash
npm install -g broods
```

Or install locally in your project:

```bash
mkdir my-agent-project && cd my-agent-project
bun init
bun add broods
```

## 2. Set Your Model Secret

Create `.env.local` with your model provider key so the CLI can auto-sync it on the first run:

```bash
echo 'OPENAI_API_KEY="sk-..."' >> .env.local
```

## 3. Start Developing

```bash
broods dev
```

On the first run this does everything for you:

1. **Creates** a `broods/` project shell with a starter agent (same as `broods init`)
2. **Opens your browser** to log in via WorkOS if you haven't authenticated yet (same as `broods login`)
3. **Auto-pushes** `OPENAI_API_KEY` from `.env.local` to the cloud
4. **Compiles and syncs** your resources to the `development` stage
5. **Watches** `broods/` for changes and **live-tails** agent logs

```text
Created starter broods/
Deploy target: my-agent-project/development
  create  agent   my-agent
  create  sandbox lambda-sandbox
Synced 2 resources to my-agent-project/development
Wrote BROODS_API_KEY (fp_env_...) to .env.local
· live logs — Ctrl+C to stop
```

The starter agent created in `broods/index.ts`:

```ts title="broods/index.ts"
import { defineAgent, defineSandbox, env } from "broods";

export const lambdaSandbox = defineSandbox({
  name: "lambda-sandbox",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const myAgent = defineAgent({
  name: "my-agent",
  provider: {
    openai: { apiKey: env("OPENAI_API_KEY") },
  },
  model: {
    provider: "openai",
    modelId: "gpt-5.5",
  },
  agent: {
    system: "You are a helpful assistant.",
  },
  sandbox: lambdaSandbox,
  publicAccess: true,
});
```

> `broods init` and `broods login` are also available as standalone commands if you prefer to run them separately.

## 4. Run Your Agent

```bash
broods run my-agent "Hello, who are you?"
```

This opens a terminal UI chat session and sends your prompt as the first turn.
Reasoning streams as it arrives, tool calls render as cards with their input and
output, and tools that need approval stop for a `y`/`n` answer. The session stays
open for follow-ups — press Esc or Ctrl+C to leave.

Leave the prompt off to start an empty session:

```bash
broods run my-agent
```

Redirect the output and you get plain text instead of the terminal UI, so runs
stay scriptable:

```bash
broods run my-agent "Hello, who are you?" > answer.txt
```

## 5. Programmatic Calls

Import the generated API references and the SDK client in your application code. `broods/_generated/` is empty until a sync runs, so `broods dev` (or `broods dev --once`) has to have completed at least once before `api` resolves:

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

// Sync run
const result = await client.run(api.agents.myAgent, {
  input: "What is the capital of France?",
});
console.log(result.text);

// Streaming run
for await (const part of client.stream(api.agents.myAgent, {
  input: "Tell me a story.",
})) {
  if (part.type === "text-delta") {
    process.stdout.write(part.text);
  }
}

// Async run
const job = await client.runAsync(api.agents.myAgent, {
  input: "Generate a long report.",
});
const status = await job.wait();
console.log(status.response);
```

## 6. Deploy to Production

```bash
broods deploy
```

This syncs to your `production` stage and writes the production runtime key to `.env.local`.

## 7. Check Where You Are Pointed

A sync lands in an organization, a project, and a stage. The organization lives on
your CLI login token and is shared by every project directory on the machine, so
confirm it before syncing somewhere shared:

```bash
broods status
```

```text
broods v0.8.1
Dashboard:   https://dashboard.broods.app
Project:     my-agent-project
Stage:       development
Server:      https://gateway.broods.app
User:        you@example.com
Org:         my-team (my-team, owner, free plan)
Account:     my-team (active)
Runtime key: fp_agent_…vK8s (matches this org and stage)
```

Switch organizations with `broods org use <name>`, and work on a copy of an
existing stage with `broods stage create staging --from development`. See the
[CLI reference](cli.md) for the full picture.

## Next Steps

- [CLI](cli.md) — Command reference, organizations, and stages
- [Resource Configuration](resources.md) — Full reference for `defineAgent`, `defineSandbox`, `defineWorkspace`, channels, skills, tools, and cron jobs
- [SDK & Runtime API](sdk.md) — Typed SDK usage, curl equivalents, and WebSocket streaming
- [Workspace & Sandbox](workspace/index.md) — Persistent files, compute, and permission modes
- [External Tools](tools.md) — Built-in tools and uploading custom tools
- [Skills](skills.md) — Instruction bundles and the skill panel
- [Channels](channels/index.md) — Telegram, Discord, Slack, GitHub, Pancake, and Zalo
- [Sub Agents](sub-agents.md) — Parallel child agents
- [Cron Jobs](crons.md) — Scheduled agent runs
- [Architecture](architecture.md) — How the platform works under the hood
- [API Reference](/api-reference) — Interactive OpenAPI docs

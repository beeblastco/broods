# Quickstart

Deploy an agent, chat with it, and call it from code. This takes about five minutes on the managed service at `gateway.broods.app`. To run Broods on your own AWS account instead, start with [Self-hosting](internals/self-hosting.md) and come back here.

You need [Bun](https://bun.sh/) 1.2+ or Node 22.15+, a [Broods dashboard](https://dashboard.broods.app) account, and a key for a model provider. This guide uses OpenAI.

## 1. Install

```bash
mkdir my-agents && cd my-agents
bun init -y
bun add broods ai
```

`ai` is the Vercel AI SDK. The `broods` types build on it. For the CLI alone, `bun add -g broods` or `npm install -g broods` is enough.

## 2. Add your model key

```bash
echo 'OPENAI_API_KEY="sk-..."' >> .env.local
```

## 3. Start the dev loop

```bash
bunx broods dev
```

The first run:

1. Opens your browser to log in, if you have not yet.
2. Asks for a project name and creates `broods/index.ts` with a starter agent.
3. Pushes `OPENAI_API_KEY` from `.env.local` to your `development` stage.
4. Syncs your resources and writes the stage runtime key to `.env.local` as `BROODS_API_KEY`.
5. Watches `broods/` and live-tails warnings and errors.

```text
Created starter broods/
Synced 2 resources to my-agents/development
Wrote BROODS_API_KEY (fp_agent_…vK8s) to .env.local
```

The starter agent:

```ts title="broods/index.ts"
import { defineAgent, defineSandbox, env } from "broods";

// A fresh, throwaway Linux box per command.
export const lambdaSandbox = defineSandbox({
  name: "lambda-sandbox",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const myAgent = defineAgent({
  name: "my-agent",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  agent: { system: "You are a helpful assistant." },
  sandboxes: [lambdaSandbox],
  publicAccess: true,
});
```

`env("OPENAI_API_KEY")` is a reference, resolved on the server. The key never lands in your synced config. `publicAccess: true` lets the stage runtime key reach this agent, which `broods run` and the SDK use.

Leave `broods dev` running. Every save re-syncs.

## 4. Chat with it

In a second terminal:

```bash
bunx broods run my-agent "Write fib.py and run it"
```

This opens a chat in the terminal. Reasoning streams in, tool calls show as cards, and tools that need approval stop for `y` or `n`. Press Esc to leave. Redirect the output (`> answer.txt`) to get plain text instead.

## 5. Call it from code

`broods dev` generates typed references in `broods/_generated/`:

```ts title="index.ts"
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient(); // reads BROODS_API_KEY from .env.local

const result = await client.run(api.agents.myAgent, {
  input: "What is the capital of France?",
});
console.log(result.text);

for await (const part of client.stream(api.agents.myAgent, {
  input: "Tell me a story.",
})) {
  if (part.type === "text-delta") process.stdout.write(part.text);
}
```

```bash
bun index.ts
```

Other languages use the same endpoint over HTTP. See [HTTP API](reference/http-api.md).

## 6. Deploy to production

```bash
bunx broods deploy
```

`deploy` syncs the same resources to your `production` stage once. It does not push `.env.local` values, so set production secrets explicitly first:

```bash
bunx broods env set OPENAI_API_KEY --stage production
```

## Check where you are pointed

A sync lands in an organization, a project and a stage. `whoami` shows all three before you write somewhere shared:

```bash
bunx broods whoami
```

## Next

- [Concepts](concepts.md): how organizations, projects, stages, agents and keys fit together.
- [Agents](guides/agents.md): models, prompts, reasoning, structured output.
- [Tools](guides/tools.md): give the agent web search or an MCP server.
- [Channels](channels/index.md): put the agent in Slack or Telegram.

If your repo already works with a coding agent (it has `CLAUDE.md`, `AGENTS.md`, `.claude/` or `.agents/`), `broods dev` also installs a Broods skill at `.agents/skills/broods/` that teaches the agent the CLI and SDK. Your edits to it survive. Only `broods init --force` rewrites it.

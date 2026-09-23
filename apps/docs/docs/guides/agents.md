# Agents

An agent is a model plus everything it may use, such as a system prompt, tools, sandboxes, workspaces, channels, skills, subagents and hooks. This page covers the model and prompt side. Each capability has its own guide, linked at the end.

```ts title="broods/index.ts"
import { defineAgent, env } from "broods";

export const assistant = defineAgent({
  name: "assistant",
  description: "General-purpose assistant", // parent agents read this when picking a subagent
  provider: { anthropic: { apiKey: env("ANTHROPIC_API_KEY") } },
  model: {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    reasoning: "medium",
  },
  agent: { system: "You are a concise assistant.", maxTurn: 20 },
  publicAccess: true,
});
```

The full field list is in [Configuration](../reference/configuration.md).

## Model and provider

`provider` holds credentials per provider. `model.provider` picks which one runs. Every Vercel AI SDK provider that ships language models works, plus any OpenAI-compatible endpoint:

| Provider             | Key         | Provider          | Key          |
| -------------------- | ----------- | ----------------- | ------------ |
| Anthropic            | `anthropic` | Groq              | `groq`       |
| Azure OpenAI         | `azure`     | MiniMax           | `minimax`    |
| Baseten              | `baseten`   | Mistral           | `mistral`    |
| Amazon Bedrock       | `bedrock`   | OpenAI            | `openai`     |
| Cerebras             | `cerebras`  | Perplexity        | `perplexity` |
| Cohere               | `cohere`    | Together.ai       | `togetherai` |
| DeepInfra            | `deepinfra` | Vercel AI Gateway | `vercel`     |
| DeepSeek             | `deepseek`  | Vercel v0         | `v0`         |
| Fireworks            | `fireworks` | xAI Grok          | `xai`        |
| Google Generative AI | `google`    | OpenAI-compatible | `custom`     |
| Google Vertex AI     | `vertex`    |                   |              |

Each provider needs an `apiKey`. Other settings pass straight to that provider's AI SDK factory, so the provider's own docs are the reference. `bedrock` also takes `region`, `accessKeyId` and `secretAccessKey`. `vertex` takes `project` and `location` and uses [express mode](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode), since an API key is required. Service-account credentials do not work.

For a self-hosted or third-party OpenAI-compatible endpoint, use `custom`:

```ts
provider: {
  custom: { apiKey: env("LLM_API_KEY"), base_url: "https://llm.example.com/v1" },
},
model: { provider: "custom", modelId: "gpt-oss-120b" },
```

`base_url` and `baseURL` both work. `baseUrl` fails the sync with an error. For vLLM-style servers, Broods folds several system messages into one and turns cumulative reasoning chunks into increments, so thinking text is not duplicated.

## Reasoning

One level in `model.reasoning` works across providers. The levels are `provider-default`, `none`, `minimal`, `low`, `medium`, `high` and `xhigh`.

Provider-specific settings in `model.providerOptions` win over `reasoning` when both are set, for example `providerOptions.openai.reasoningEffort` or `providerOptions.anthropic.thinking`. If a model does not support the level you asked for, the run logs a `model.step.warnings` event and continues.

## Structured output

Ask for JSON that matches a schema:

```ts
model: {
  provider: "google",
  modelId: "gemini-3-flash",
  output: {
    type: "object",
    name: "analysis",
    schema: {
      type: "object",
      properties: { summary: { type: "string" }, confidence: { type: "number" } },
      required: ["summary", "confidence"],
    },
  },
},
```

## System prompt and turn limit

`agent.system` is the base prompt. Broods appends a block for each feature that is on, such as workspace guidance, the memory index, available skills, subagents and the scheduler clock. The Tracing tab in the dashboard shows the full assembled prompt for every run.

`agent.maxTurn` caps model steps per run. The default is 30, and `0` removes the cap. A run that hits the cap ends as `failed` with its history intact, and `continue` resumes it. See [Conversations](conversations.md).

## Session history

Long conversations are trimmed before each model call. The stored history never changes.

```ts
session: {
  pruning: { enabled: true },                                    // default on
  compaction: { enabled: true, maxContextLength: 100_000 },      // default off
},
```

Details are in [Memory and sessions](memory-and-sessions.md).

## Who can call the agent

| Setting                   | Default | Effect                                                                                                                        |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `publicAccess: true`      | off     | The stage runtime key may run this agent. Without it, runtime-key requests get `403 public_access_disabled`.                  |
| `allowRunOverrides: true` | off     | A runtime-key caller may send `system` messages and `model` overrides. Without it, the run gets `403 run_overrides_disabled`. |

Channels, cron jobs and callers with the account secret are never gated by these flags. A private agent is still reachable from Slack.

## Harness adapters

By default an agent runs on the Broods loop, a serverless AI SDK `streamText` loop with the Broods tools. `defineHarness` swaps that loop for Claude Code, Codex, Deep Agents, OpenCode or Pi, running inside the agent's first sandbox.

```ts
import { defineAgent, defineHarness, defineSandbox, env } from "broods";

export const runner = defineSandbox({
  name: "codex-runner",
  provider: "sandbox",
  persistent: true,
  permissionMode: "bypass",
  network: { mode: "allow-all" },
  onCreate: ["bun install"],
});

export const codingAgent = defineAgent({
  name: "coding-agent",
  harness: defineHarness({ type: "codex", permissionMode: "allow-all" }),
  sandboxes: [runner],
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
});
```

- The first sandbox must be persistent and use the `sandbox` or `lambda` provider.
- The harness ships its own file tools, so the Broods workspace prompt is off. `memory_save` still works.
- Broods MCP servers and account skills still reach the harness. Filter tools with `activeTools` or `inactiveTools` on `defineHarness`.
- The harness's own "ask the user" tool is off. The agent asks through [`ask_questions`](tools.md#asking-the-user).
- Steering sent before a turn starts is folded into its prompt. Steering sent during a turn runs as the next turn.
- Policies and structured output are not supported yet.

Each harness supports different model providers, tool approval and tool filtering. The table is in [Configuration](../reference/configuration.md).

Codex requires `permissionMode: "allow-all"` and is the only harness with `webSearch`. The harness's native session is checkpointed after each turn, so the next request continues the same session.

## What to add next

- [Tools](tools.md) adds provider tools and MCP servers.
- [Sandboxes](sandboxes/index.md) and [Workspaces](workspaces.md) let the agent run code and keep files.
- [Channels](../channels/index.md) puts the agent in chat apps.
- [Skills](skills.md), [Subagents](subagents.md) and [Scheduling](scheduling.md) extend what one run can do.
- [Hooks](hooks.md), [Webhooks](webhooks.md) and [Policies](policies.md) observe and control runs.

---
title: Configuration
---

# Configuration reference

Every resource in a Broods project is a `define*` call exported from a file in `broods/`. `broods dev` and `broods deploy` compile them into a manifest, sync it to a stage, and write typed references to `broods/_generated/`. This page lists every helper and its fields. The guides explain when to use each one.

## Project layout

```text
my-project/
  broods/
    index.ts         # resource definitions, any number of files
    _generated/      # written by broods dev / deploy
      api.ts         # typed references for the SDK
    support-flow/    # a skill bundle
      SKILL.md
  .env.local         # local secrets and CLI settings, never commit
```

## defineBroods

Optional project defaults, exported as the default export. CLI flags and `.env.local` override them.

| Field          | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `project`      | Project name                                                       |
| `stages`       | `{ dev, deploy }` stage names for `broods dev` and `broods deploy` |
| `dashboardUrl` | Where `broods login` opens the browser and deep links point        |
| `baseUrl`      | Broods API base URL. Defaults to the one discovered at login       |

```ts
import { defineBroods } from "broods";

export default defineBroods({
  project: "my-project",
  stages: { dev: "development", deploy: "production" },
});
```

## env

`env("NAME")` is a reference to a stage environment variable that the server resolves. Use it for every secret. Never use `process.env` in resource files, because it bakes your local value into the deployed config.

```ts
provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
```

Names are uppercase letters, digits and underscores. A sync fails, and writes nothing, when a referenced name has no value on the stage. Set values with `broods env set`, or let `broods dev` push them from `.env.local`. In a plain string, such as an MCP header, write `"Bearer ${NAME}"` instead. `env()` returns an object, so a template literal around it sends `[object Object]`.

## defineAgent

The agent's model, instructions, tools, and what it can reach. See [Agents](../guides/agents.md).

| Field               | Description                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`              | Unique per stage. Required                                                                             |
| `description`       | Shown to parent agents choosing a subagent                                                             |
| `provider`          | Credentials per model provider. See [providers](#model-providers)                                      |
| `model`             | `provider`, `modelId`, call settings, `reasoning`, `providerOptions`, `output`, `transcriptionModelId` |
| `agent`             | `system` prompt and `maxTurn`, the steps per turn. Default 30, `0` for no cap                          |
| `harness`           | A `defineHarness()` value to replace the built-in loop                                                 |
| `tools`             | Provider-executed tools, keyed by the provider's tool name                                             |
| `mcp`               | MCP servers to enable, keyed by server name                                                            |
| `connections`       | Channel connections the agent answers on                                                               |
| `sandboxes`         | Sandboxes it can use. The first is the default                                                         |
| `workspaces`        | Workspaces it mounts, with optional per-workspace sandbox                                              |
| `subagent`          | `enabled`, `allowed`, `context`, `mode`, `stream`, `visibility`                                        |
| `skills`            | `enabled`, `allowed` skill resources                                                                   |
| `scheduler`         | `{ enabled: true }` gives the agent scheduling tools                                                   |
| `session`           | `pruning.enabled`, `compaction.enabled`, `compaction.maxContextLength`                                 |
| `hooks`             | Code hook callbacks and `webhooks` for lifecycle events                                                |
| `policies`          | Policies that gate the agent. Each carries its own mode                                                |
| `publicAccess`      | Open the agent to the stage runtime key. Default `false`                                               |
| `allowRunOverrides` | Let runtime-key callers send `system` and `model` overrides. Default `false`                           |

```ts
import { defineAgent, env } from "broods";

export const myAgent = defineAgent({
  name: "my-agent",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5", reasoning: "medium" },
  agent: { system: "You are a helpful assistant.", maxTurn: 20 },
  sandboxes: [lambdaSandbox],
  workspaces: [notes, { workspace: docs, sandbox: null }],
  publicAccess: true,
});
```

### model

| Field                                                                                              | Description                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `provider`, `modelId`                                                                              | Which model to call                                                                                                            |
| `temperature`, `topP`, `topK`, `maxOutputTokens`, `seed`, `stopSequences`, `maxRetries`, `timeout` | AI SDK call settings                                                                                                           |
| `reasoning`                                                                                        | `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`                                                        |
| `providerOptions`                                                                                  | Provider-specific options. They win over `reasoning` when both set thinking                                                    |
| `output`                                                                                           | Structured output as `{ type: "object", schema }`, `array`, `choice`, `json` or `text`, with optional `name` and `description` |
| `transcriptionModelId`                                                                             | Speech-to-text model for inbound audio, on the same provider                                                                   |

The provider-specific thinking keys are OpenAI `providerOptions.openai.reasoningEffort`, Anthropic `providerOptions.anthropic.thinking`, Google `providerOptions.google.thinkingConfig`, MiniMax `providerOptions.anthropic.thinking`. When a model does not support a level, the run logs a `model.step.warnings` event.

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

### Model providers

Every Vercel AI SDK language model provider works, plus any OpenAI-compatible endpoint through `custom`. Each needs an `apiKey`, and other settings pass through to the provider's AI SDK factory. The provider keys and the `bedrock`, `vertex` and `custom` specifics are in [Agents](../guides/agents.md). When a `custom` server reports no reasoning token count, Broods estimates it.

### tools and mcp

`tools` holds provider-executed tools, imported from the provider's AI SDK package. Broods flags sit beside them.

| Flag            | Description                                    |
| --------------- | ---------------------------------------------- |
| `enabled`       | `false` disables the tool                      |
| `needsApproval` | Ask before each call. Refused on channel turns |
| `async`         | Run a slow local tool in the background        |

`mcp` enables registered MCP servers by name. Each entry takes `enabled`, `needsApproval` for every tool of that server, and the `headers` and `oauth` secrets to resolve.

```ts
import { google } from "@ai-sdk/google";

tools: {
  googleSearch: google.tools.googleSearch({ searchTypes: { webSearch: {} } }),
  urlContext: { ...google.tools.urlContext({}), needsApproval: true },
},
mcp: { [search.name]: { enabled: true } },
```

See [Tools](../guides/tools.md).

### workspaces and sandboxes

`sandboxes` lists sandbox resources. The first runs `bash` when no workspace is attached, backs every workspace without its own sandbox, and hosts a harness. The model reaches the others by name. Each sandbox may appear once, and only the first may also back a workspace.

`workspaces` entries are a workspace resource, or `{ workspace, sandbox }`:

| `sandbox` value | Result                                                     |
| --------------- | ---------------------------------------------------------- |
| omitted         | Uses the agent's first sandbox. Read-only if there is none |
| a sandbox       | Uses that sandbox and its `permissionMode`                 |
| `null`          | Read-only, read straight from storage with no compute      |

### subagent

| Field        | Default        | Description                                                         |
| ------------ | -------------- | ------------------------------------------------------------------- |
| `enabled`    | `false`        | Gives the agent `run_subagent`                                      |
| `allowed`    | `[]`           | Agents it may dispatch. Empty means one-shot virtual subagents only |
| `context`    | `"new"`        | `"inherited"` passes the parent's messages to the child             |
| `mode`       | `"persistent"` | `"ephemeral"` keeps child conversations in memory only              |
| `stream`     | `false`        | Publish child stream parts for WebSocket attach                     |
| `visibility` | `"result"`     | What the parent sees, `full`, `result` or `none`                    |

See [Subagents](../guides/subagents.md).

### hooks

The code hooks are `onStart`, `onStepFinish`, `onToolCall`, `onToolResult`, `onFinish`, `onApproval`, `onError`, `onSubagentFinish`, `onMessageReceived`, `onMessageSending`. `hooks.webhooks` is a list of `{ enabled, url, secret, events }`. See [Code hooks](../guides/hooks.md) and [Lifecycle webhooks](../guides/webhooks.md).

## defineHarness

Replaces the built-in agent loop with Claude Code, Codex, Deep Agents, OpenCode or Pi, running on the agent's first sandbox. Omit `harness` to use the built-in loop.

| Field              | Description                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `type`             | `claude-code`, `codex`, `deepagents`, `opencode`, `pi`. Required                                                |
| `permissionMode`   | `allow-reads`, `allow-edits`, `allow-all`. Codex needs `allow-all`                                              |
| `activeTools`      | Only these adapter built-ins and MCP tools                                                                      |
| `inactiveTools`    | Hide these adapter built-ins and MCP tools                                                                      |
| `startupTimeoutMs` | How long to wait for the harness to start                                                                       |
| `webSearch`        | Codex only                                                                                                      |
| `debug`            | `{ enabled, level, subsystems }` for adapter debug logs. `level` is `error`, `warn`, `info`, `debug` or `trace` |

| Harness     | Model providers                                    | Tool approval | Tool filtering |
| ----------- | -------------------------------------------------- | ------------- | -------------- |
| Claude Code | `anthropic`, `vercel`                              | yes           | yes            |
| Codex       | `custom`, `openai`, `vercel`                       | no            | no             |
| Deep Agents | `anthropic`, `vercel`                              | yes           | auto-rejection |
| OpenCode    | `anthropic`, `openai`, `vercel`                    | yes           | auto-rejection |
| Pi          | its own catalog, keys from the configured provider | yes           | yes            |

- The first sandbox must be `persistent` and use the `sandbox` or `lambda` provider.
- Every harness gets the agent's MCP servers and skills. The adapter's own question tool is off. Agents ask through `ask_questions`.
- Policies and structured output are not supported yet.
- The `<workspace>` prompt is dropped, since the adapter ships its own file tools. Structured memory still applies.
- Steering sent before a turn starts is folded into its prompt. Steering sent during a turn runs as the next turn.
- Codex is the only harness with `webSearch`. Broods checkpoints the harness's native session after each turn, so the next request continues it.

```ts
import { defineAgent, defineHarness, defineSandbox, env } from "broods";

export const runner = defineSandbox({
  name: "codex-runner",
  provider: "sandbox",
  persistent: true,
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

## defineSandbox

Compute where `bash` and the file tools run. See [Sandboxes](../guides/sandboxes/index.md).

| Field                  | Default    | Description                                                                          |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `provider`             | `sandbox`  | `sandbox`, `lambda`, `daytona`, `e2b`, `vercel`, `machine`                           |
| `permissionMode`       | `ask`      | `ask`, `edit` or `bypass`                                                            |
| `network`              | `deny-all` | `{ mode, allowDomains?, allowCidrs? }`, mode `allow-all`, `deny-all` or `restricted` |
| `timeout`              | 30         | Seconds per call, max 600                                                            |
| `size`                 | provider   | `tiny`, `xsmall`, `small`, `medium`, `large`                                         |
| `snapshot`             | provider   | Image or snapshot to boot from                                                       |
| `persistent`           | `false`    | Keep one long-lived machine per workspace or agent                                   |
| `lifecycle`            |            | `idleTimeoutSeconds`, default 900, and `maxLifetimeSeconds`                          |
| `onCreate`, `onResume` |            | Setup commands. Persistent sandboxes only                                            |
| `fallbackProvider`     |            | Second provider when the first is out of capacity. Ephemeral only                    |
| `envVars`              |            | Variables for every run. Values may be `env("NAME")`                                 |
| `runtimes`             |            | Advisory allow-list of `bash`, `python`, `node`                                      |
| `memoryLimit`          |            | MB, informational                                                                    |
| `outputLimitBytes`     | 65536      | Output kept per call                                                                 |
| `options`              |            | Provider settings, plus `reservationKey` to share a persistent machine               |

```ts
export const lambdaSandbox = defineSandbox({
  name: "lambda-sandbox",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "ask",
  timeout: 60,
});
```

## defineWorkspace

Persistent files, mounted into a sandbox. See [Workspaces](../guides/workspaces.md).

| Field         | Default              | Description                                                                                              |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `storage`     | `{ provider: "s3" }` | Managed bucket, or your own with `bucket`, `region`, `prefix`, `endpoint`, `auth`                        |
| `partitioned` | `false`              | Allow channels to split the workspace per conversation                                                   |
| `harness`     |                      | `workspace.enabled` for the workspace prompt, `memory.enabled` for structured memory. Both on by default |

```ts
export const notes = defineWorkspace({
  name: "notes",
  storage: { provider: "s3" },
});
```

## defineSkill

An instruction bundle the agent loads when needed. `path` is a folder under `broods/` with a `SKILL.md`. See [Skills](../guides/skills.md).

```ts
export const supportFlow = defineSkill({
  name: "support-flow",
  path: "support-flow",
});

export const myAgent = defineAgent({
  name: "my-agent",
  skills: { enabled: true, allowed: [supportFlow] },
});
```

## defineMcp

An MCP server whose tools the agent sees as `<name>__<tool>`. Give exactly one of `url`, `handler` or `sandbox`. See [Tools](../guides/tools.md).

| Field          | Description                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`         | 1 to 32 lowercase letters, digits or hyphens, starting with a letter                                         |
| `url`          | External server over stateless HTTP. Public host, no redirects                                               |
| `handler`      | Hosted server built with `createMcpHandler` from `@modelcontextprotocol/server`, bundled by the CLI          |
| `sandbox`      | A `machine` sandbox whose daemon runs the stdio server of the same name                                      |
| `headers`      | Request headers. Credentials must be `"Bearer ${NAME}"` refs                                                 |
| `oauth`        | `{ clientId, clientSecret, refreshToken, tokenUrl? }` for expiring tokens. No Authorization header alongside |
| `allowedTools` | Tools to register. Omit for all                                                                              |

```ts
export const search = defineMcp({
  name: "search",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
});
```

## definePolicy

Authorization rules for agents, attached through `policies` on an agent or channel. See [Policies](../guides/policies.md).

| Field   | Description                                                                       |
| ------- | --------------------------------------------------------------------------------- |
| `mode`  | `enforce` blocks denied actions and fails closed. `audit`, the default, only logs |
| `rules` | `{ id, effect: "allow" \| "deny", actions, resources?, conditions? }`             |

- Actions are `agent.invoke`, `tool.call`, `workspace.read`, `workspace.write`, `workspace.exec`, `subagent.run`, `skill.load`.
- Resource selectors are `toolNames`, `mcpIds`, `workspaceIds`, `workspaceNames`, `filePaths`, `subagentIds`, `skillPaths`.
- Conditions are `{ attribute, operator, value }`, with operators `equals`, `notEquals`, `in`, `notIn`, `prefix`, `contains`. Attributes include `project`, `stage`, `agentId`, `channel`, `channelId`, `userId`, `userRoles`, `toolName`, `mcpId`, `filePath`, `sandboxPermissionMode`, and tool input as `tool.input.<field>`.
- A `deny` beats an `allow`. In `enforce` mode, anything without a matching allow is denied.
- A `filePaths` entry is a workspace-relative prefix such as `secrets/`. A deny on it also blocks a `grep` or `glob` rooted above it, including the workspace root.

```ts
export const guard = definePolicy({
  name: "workspace-guard",
  mode: "enforce",
  rules: [
    { id: "allow-read", effect: "allow", actions: ["workspace.read"] },
    {
      id: "deny-secrets",
      effect: "deny",
      actions: ["workspace.read", "workspace.write"],
      resources: { filePaths: ["secrets/"] },
    },
  ],
});

export const myAgent = defineAgent({ name: "my-agent", policies: [guard] });
```

## defineCron

Runs an agent on a schedule. Give `input` or `events`. See [Scheduling](../guides/scheduling.md).

| Field                | Description                                     |
| -------------------- | ----------------------------------------------- |
| `agent`              | Agent resource or name. Required                |
| `scheduleExpression` | `cron(...)`, `rate(...)` or `at(...)`. Required |
| `input` / `events`   | One text message, or full model messages        |
| `timezone`           | IANA name. Default UTC                          |
| `conversationKey`    | Conversation to run in. Default `cron:<cronId>` |
| `status`             | `active` or `paused`                            |
| `description`        | Free text                                       |

```ts
export const dailyDigest = defineCron({
  name: "daily-digest",
  agent: myAgent,
  input: "Summarize today's activity.",
  scheduleExpression: "cron(0 9 * * ? *)",
  timezone: "Europe/Amsterdam",
});
```

## Connections and channels

A connection holds one app's credentials. A channel names one room on that connection and the rules for it. Agents list connections in `connections`.

| Provider | Connection                 | Channel                 | Room field       |
| -------- | -------------------------- | ----------------------- | ---------------- |
| Telegram | `defineTelegramConnection` | `defineTelegramChannel` | `chatId`         |
| Slack    | `defineSlackConnection`    | `defineSlackChannel`    | `channelId`      |
| Discord  | `defineDiscordConnection`  | `defineDiscordChannel`  | `channelId`      |
| GitHub   | `defineGitHubConnection`   | `defineGitHubChannel`   | `repo`           |
| Matrix   | `defineMatrixConnection`   | `defineMatrixChannel`   | `channelId`      |
| Pancake  | `definePancakeConnection`  | `definePancakeChannel`  | `conversationId` |
| Zalo     | `defineZaloConnection`     | `defineZaloChannel`     | `chatId`         |

Every connection also takes `allowedChannelIds`, where `["*"]` answers everywhere, `allowedUserIds`, `partition` and `trace`. Channels take `agents`, `instructions`, `workspaces`, `policies`, `denyTools`, `partition`, `sandboxImages`, `tagRoles`, and `replyIn` on Slack. Provider fields are on each [channel page](../channels/index.md).

## Validation

`broods dev` and `broods deploy` check the project before anything reaches a stage:

- Unknown agent keys fail with a suggestion, such as `workspace:` for `workspaces:`.
- Duplicate resource names fail.
- Every `env("NAME")` needs a stored value on the stage.
- Skill folders need a `SKILL.md`.
- Hosted MCP bundles must build as ESM and export a fetch-style handler.
- Workspace storage must be `s3`.
- The old `sandbox` agent key fails. List sandboxes in `sandboxes`. A stored agent that still carries `sandbox` refuses to run until you resync.
- A connection with no declared channels and no `allowedChannelIds` fails. `"*"` as a channel id fails.

## Generated references

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

await new BroodsClient().run(api.agents.myAgent, { input: "Hello" });
```

`api.agents`, `api.channels`, `api.workspaces`, `api.sandboxes` and the other maps hold the deployed ids. See the [SDK reference](sdk.md). Every resource also maps to the raw account API, documented in the [API reference](/api-reference).

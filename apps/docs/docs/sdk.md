---
id: sdk
title: SDK & Runtime API
---

# SDK & Runtime API

The `broods` package exposes a typed TypeScript SDK for invoking agents at runtime. You can also call the HTTP endpoints directly with `curl` or any HTTP client. A Python SDK is planned for a future release.

## Installation

```bash
npm install broods
# or
bun add broods
```

## Authentication

Runtime calls use the **environment runtime API key** (not your dashboard login token). After your first `broods deploy`, the CLI writes `BROODS_API_KEY` to `.env.local`. The SDK loads it automatically, or you can pass it explicitly:

```ts
import { BroodsClient } from "broods";

const client = new BroodsClient();
// Loads BROODS_API_KEY from .env.local automatically
```

Or explicitly:

```ts
const client = new BroodsClient({
  apiKey: process.env.BROODS_API_KEY,
});
```

For self-hosted deployments, point the client at your own core service:

```ts
const client = new BroodsClient({
  baseUrl: "https://core.your-domain.example",
  apiKey: "fp_env_...",
});
```

## Invoke an Agent

### Sync Run (accumulate text)

Pass the generated `api.agents.<name>` reference separately from the model input. The
reference carries the deployed endpoint, project, and environment routing metadata.

```ts
import { api } from "./broods/_generated/api";

const client = new BroodsClient();
const result = await client.run(api.agents.myAgent, {
  input: "Hello, who are you?",
});

console.log(result.text);
// You are a helpful assistant...
```

**Curl equivalent:**

```bash
curl -X POST "https://gateway.broods.app" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_...",
    "eventId": "req-001",
    "conversationKey": "my-conversation",
    "events": [
      { "role": "user", "content": [{ "type": "text", "text": "Hello, who are you?" }] }
    ]
  }'
```

### Streaming Run (yield parts as they arrive)

```ts
for await (const part of client.stream(api.agents.myAgent, {
  input: "Tell me a story.",
})) {
  if (part.type === "text-delta") {
    process.stdout.write(part.text);
  }
  if (part.type === "tool-call") {
    console.log("\n[tool]", part.toolName, part.input);
  }
  if (part.type === "reasoning") {
    console.log("\n[thinking]", part.text);
  }
}
```

**Curl equivalent:**

```bash
curl -X POST "https://gateway.broods.app" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "agentId": "agent_...",
    "eventId": "req-002",
    "conversationKey": "my-conversation",
    "events": [
      { "role": "user", "content": [{ "type": "text", "text": "Tell me a story." }] }
    ]
  }'
```

The SSE stream emits Vercel AI SDK `TextStreamPart` events: `text-delta`, `tool-call`, `tool-result`, `finish`, `error`, etc.

### Async Run (long-running tasks)

```ts
const job = await client.runAsync(api.agents.myAgent, {
  input: "Generate a detailed report.",
});

console.log("Polling:", job.statusUrl);

const status = await job.wait({ intervalMs: 2000, timeoutMs: 300_000 });

if (status.status === "completed") {
  console.log(status.response);
} else if (status.status === "failed") {
  console.error(status.error);
} else if (status.status === "awaiting_approval") {
  console.log("Approval needed:", status.approvals);
}
```

**Curl equivalent:**

```bash
# Start async job
curl -X POST "https://gateway.broods.app/async" \
  -H "Authorization: Bearer $BROODS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_...",
    "eventId": "req-003",
    "conversationKey": "my-conversation",
    "events": [
      { "role": "user", "content": [{ "type": "text", "text": "Generate a detailed report." }] }
    ]
  }'

# Poll status
curl "https://gateway.broods.app/status/req-003?agentId=agent_..." \
  -H "Authorization: Bearer $BROODS_API_KEY"
```

### Full-Fidelity Events

For multimodal input, tool responses, or ephemeral system instructions, use the `events` array instead of the `input` shorthand:

```ts
const result = await client.run(api.agents.myAgent, {
  events: [
    { role: "system", content: "Answer concisely.", persist: false },
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image", image: "data:image/png;base64,iVBORw0KGgo..." },
      ],
    },
  ],
});
```

### Per-Run Overrides

Override model settings for a single invocation without touching the deployed config:

```ts
const result = await client.run(api.agents.myAgent, {
  input: "Summarize today's plan.",
  model: {
    temperature: 0.3,
    maxOutputTokens: 4096,
    providerOptions: {
      openai: { reasoningEffort: "high" },
    },
  },
});
```

Reserved keys (`provider`, `modelId`, `output`, `apiKey`) are rejected so a request cannot swap the model or credentials.

## Cron Jobs at Runtime

Create, list, update, and delete cron jobs programmatically:

```ts
// Create a cron job
const cron = await client.createCron({
  name: "Daily digest",
  agent: api.agents.myAgent,
  input: "Summarize today's activity.",
  scheduleExpression: "cron(0 9 * * ? *)",
  timezone: "Europe/Amsterdam",
});

// List all crons
const crons = await client.listCrons();

// Get a specific cron
const job = await client.getCron(cron.cronId);

// List recent runs
const runs = await client.listCronRuns(cron.cronId, { limit: 10 });

// Update
await client.updateCron(cron.cronId, { status: "paused" });

// Delete
await client.deleteCron(cron.cronId);
```

## Account Config Client (dynamic configuration)

`broods dev` and `broods deploy` sync **predefined configs**: the resources you
declare in your `broods/` folder are versioned with your code and pushed as a
unit. If you instead need **dynamic config at runtime** — creating or mutating config
while your app runs, e.g. provisioning one agent per customer in a multi-tenant
product — use `BroodsAccountClient` from the separate `broods/account` entry
point with your **account secret** (not the runtime API key). It is the complete
typed client for the account config plane: agents, sandboxes (config +
suspend/resume/terminate/snapshot/terminal), workspaces (config + file
upload/rename/delete/download), tools, policies, skills, crons (+ run history),
and the account itself (metadata, secret rotation, deletion).

The entry point is dependency-free and built on plain `fetch`, so it works in
edge runtimes (Convex actions, Cloudflare Workers) where the main `broods`
entry cannot load — the main entry reads `.env` files from disk.

```ts
import { BroodsAccountClient } from "broods/account";

// baseUrl defaults to https://gateway.broods.app (override with BROODS_BASE_URL
// or the option); the secret falls back to BROODS_ACCOUNT_SECRET.
const account = new BroodsAccountClient({
  accountSecret: process.env.BROODS_ACCOUNT_SECRET,
});

// Upsert flow: get/update return null on 404, so no try/catch needed.
const existing = await account.getAgent(savedAgentId);
const agent = existing
  ? await account.updateAgent(savedAgentId, { config })
  : await account.createAgent({ name: `tenant-agent-${customerId}`, config });

// Crons (with run history), workspaces, and files use the same client.
await account.createCron({
  name: "daily-digest",
  agentId: agent.agentId,
  input: "Summarize yesterday's conversations.",
  scheduleExpression: "cron(0 8 * * ? *)",
});
const files = await account.listWorkspaceFiles(workspaceId);
await account.uploadWorkspaceFile(workspaceId, {
  path: "memory/seed.md",
  contentBase64: "IyBTZWVk",
});
const runs = await account.listCronRuns(cronId, { limit: 20 });

// Sandboxes, tools, policies, and skills round out the config plane.
const sandbox = await account.createSandbox({
  name: "reserved",
  config: { provider: "lambda", persistent: true, permissionMode: "ask" },
});
await account.suspendSandbox(sandbox.sandboxId, reservationKey); // + resume/terminate/snapshot/terminal
await account.createSkill({
  source: "json",
  name: "triage",
  description: "Triage flow",
  content: "# Triage",
});

// Account self-management: metadata, one-time secret rotation, deletion.
const { secret } = await account.rotateSecret();

// Channel webhook URLs are per account + agent.
const { accountId } = await account.getAccount();
const url = account.webhookUrl(accountId, agent.agentId, "slack");
```

`PATCH` semantics: `config` deep-merges into the stored config and `null`
values delete keys. Secrets inside configs are encrypted at rest and come back
redacted (`********`) on reads. Errors other than 404 throw
`BroodsAccountApiError` with the HTTP status code.

## Python (Coming Soon)

A Python SDK is on the roadmap. Until then, use the HTTP endpoints directly:

```python
import requests

response = requests.post(
    "https://gateway.broods.app",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    json={
        "agentId": "agent_...",
        "eventId": "req-001",
        "conversationKey": "my-conversation",
        "events": [
            {"role": "user", "content": [{"type": "text", "text": "Hello"}]}
        ],
    },
    stream=True,
)

for line in response.iter_lines():
    if line.startswith(b"data: "):
        part = json.loads(line[6:])
        print(part)
```

## WebSocket (Real-time Streaming)

For browser or persistent-connection clients, use the WebSocket gateway instead of SSE:

```ts
import { WebSocketClient } from "broods";
import { api } from "./broods/_generated/api";

const wsClient = new WebSocketClient({
  baseUrl: "https://gateway.broods.app",
  apiKey: "fp_env_...",
});

const subscription = wsClient.subscribe(
  {
    agent: api.agents.myAgent,
    events: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
  },
  {
    onMessage(message) {
      if (message.type === "text-delta") {
        process.stdout.write(message.text);
      }
    },
    onDone() {
      console.log("\n[done]");
    },
    onError(error) {
      console.error("[error]", error.message);
    },
  },
);

// Close the connection when finished
// subscription.close();
```

Or use the async-generator form:

```ts
for await (const message of wsClient.stream({
  agent: api.agents.myAgent,
  events: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
})) {
  if (message.type === "text-delta") {
    process.stdout.write(message.text);
  }
}
```

See [Architecture](architecture.md) for the WebSocket protocol details.

## CLI Runtime Commands

The CLI includes runtime helpers that do not require writing code:

```bash
# Run an agent once and pretty-print the result
broods run my-agent "What is the capital of France?"

# Stream live logs for the whole project
broods stream

# Backfill recent logs then live-tail
broods logs --limit 100

# List deployed agents
broods agent list

# Show one agent's resolved config
broods agent get my-agent
```

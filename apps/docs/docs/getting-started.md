# Getting Started

Choose your path to get up and running:

- **Managed service** — create an account and start interacting with agents immediately. No deployment required.
- **Self-deployed** — deploy the full serverless infrastructure to your own AWS account for complete control.

Both paths converge on the same account and agent APIs. After setup, you can configure agents, enable tools, connect channels, and integrate via the direct API or messaging platforms.

---

## Path 1: Managed Service

Skip infrastructure. Create an account and start using the platform right away.

### 1. Create an Account

Send a POST request to the managed account service:

```bash
curl -X POST "https://<managed-account-service-url>/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-first-account",
    "description": "My first account"
  }'
```

The response includes your `accountId` and a one-time `secret`:

```json
{
  "account": {
    "accountId": "acct_...",
    "username": "my-first-account",
    "description": "My first account"
  },
  "secret": "fp_acct_..."
}
```

**Store `secret` securely** — it is not recoverable. If lost, rotate it to get a new one.

### 2. Start Building

You now have everything you need. Skip to [Start Building](#start-building) below to create your first agent and send requests.

---

## Path 2: Self-Deployed

Deploy the full infrastructure to your own AWS account.

### Prerequisites

- [Bun](https://bun.sh/) installed
- An AWS account with CLI access configured
- [SST](https://sst.dev/) (installed by `bun install` as a project dependency; commands use `bunx sst`)

### 1. Deploy the Infrastructure

Clone the repository and install dependencies:

```bash
bun install
cp .env.example .env
```

Set the required SST secrets (fill in `.env` first — `AWS_ACCOUNT_ID`, `PROJECT_NAME`, and `PROJECT_OWNER_EMAIL` have no defaults):

```bash
bunx sst secret set AdminAccountSecret <long-random-value>
bunx sst secret set AccountConfigEncryptionSecret <long-random-value>
bunx sst secret set DaytonaApiKey <daytona-api-key>
```

Build and deploy:

```bash
bun run deploy
```

After deploy, note the two Function URLs from the output:

- `accountServiceUrl` — for account and agent management
- `agentServiceUrl` — for sending requests to agents

Set them as environment variables:

```bash
export ACCOUNT_SERVICE_URL=<accountServiceUrl>
export AGENT_SERVICE_URL=<agentServiceUrl>
```

### 2. Create an Account

Create your first account on your own deployment:

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-first-account",
    "description": "My first account"
  }'
```

Save the returned `secret`:

```bash
export ACCOUNT_SECRET=fp_acct_...
```

### 3. Start Building

You now own the infrastructure. Skip to [Start Building](#start-building) below to create your first agent and send requests.

---

## Start Building

This section is the same regardless of which path you chose. You need `ACCOUNT_SERVICE_URL`, `AGENT_SERVICE_URL`, and `ACCOUNT_SECRET` set.

### Create an Agent

Agents hold the model, provider, and tool configuration. Create one with your account secret:

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts/me/agents" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "A general-purpose assistant",
    "config": {
      "provider": {
        "google": { "apiKey": "YOUR_GOOGLE_API_KEY" }
      },
      "model": {
        "provider": "google",
        "modelId": "gemini-3-flash"
      },
      "agent": {
        "system": "You are a helpful assistant."
      }
    }
  }'
```

The response includes your `agentId`:

```json
{
  "agent": {
    "accountId": "acct_...",
    "agentId": "agent_...",
    "name": "assistant",
    "description": "A general-purpose assistant"
  }
}
```

Save it:

```bash
export AGENT_ID=agent_...
```

#### Supported Providers

| Provider | Config key | Required fields |
| --- | --- | --- |
| Google | `google` | `apiKey` |
| OpenAI | `openai` | `apiKey` |
| Bedrock | `bedrock` | `region`, `apiKey` |
| Gateway | `gateway` | `apiKey` |
| MiniMax | `minimax` | `apiKey` |

#### Reasoning / thinking tokens

Use standard Vercel AI SDK call settings directly in `config.model`. Provider-specific thinking controls live under `config.model.providerOptions`:

| Provider | Enable thinking with |
| --- | --- |
| OpenAI | `providerOptions.openai.reasoningEffort` (`low`/`medium`/`high`) and `providerOptions.openai.reasoningSummary` |
| Anthropic | `providerOptions.anthropic.thinking` or `providerOptions.anthropic.effort` |
| Google | `providerOptions.google.thinkingConfig` |
| MiniMax | `providerOptions.anthropic.thinking` |

MiniMax's default provider is **Anthropic-compatible**, so it uses the Anthropic-style `thinking` config. **MiniMax-M3 thinking is off by default** — without the provider option the model returns no reasoning tokens:

```jsonc
"model": {
  "provider": "minimax",
  "modelId": "MiniMax-M3",
  "providerOptions": {
    "anthropic": {
      "thinking": { "type": "enabled", "budgetTokens": 4096 }
    }
  }
}
```

Reasoning surfaces in the stream as `reasoning-start` / `reasoning-delta` parts, the same as any other provider.

### Send Your First Request

#### Sync SSE Request

POST to the agent service. The response streams as SSE:

```bash
curl -X POST "$AGENT_SERVICE_URL" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "eventId": "req-001",
    "conversationKey": "my-first-conversation",
    "events": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Hello, who are you?" }
        ]
      }
    ]
  }'
```

The SSE stream emits `data:`-only lines carrying raw Vercel AI SDK stream chunks (`text-delta`, `tool-call`, `tool-result`, `finish`), with `: waiting…` comment heartbeats during long waits. When the agent finishes, the last data line is the `finish` chunk (followed by a `structured-output` chunk when `config.model.output` is set), then the stream closes:

> The WebSocket transport carries the **same** AI SDK stream parts. Each part is published in a NATS envelope `{ type: "stream", data: <part>, sequence, headers }`; clients read `.data`, which is byte-identical to one SSE event.

```bash
data: {"type":"finish","finishReason":"stop", ...}
```

#### Async Request

For long-running requests, use the async endpoint:

```bash
curl -X POST "$AGENT_SERVICE_URL/async" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "eventId": "req-002",
    "conversationKey": "my-first-conversation",
    "events": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Tell me a long story." }
        ]
      }
    ]
  }'
```

The response includes a `statusUrl` for polling:

```json
{
  "statusUrl": "https://.../status/req-002?agentId=agent_..."
}
```

Poll the status endpoint (the `agentId` query parameter is required; unknown ids return `404` with `status: not_found`):

```bash
curl "$AGENT_SERVICE_URL/status/req-002?agentId=$AGENT_ID" \
  -H "Authorization: Bearer $ACCOUNT_SECRET"
```

Status responses:

| Status | Meaning |
| --- | --- |
| `processing` | Agent is working |
| `completed` | Finished — includes the response |
| `failed` | Error occurred |
| `awaiting_approval` | Tool approval needed |

`events` accepts three kinds of entries: `user` messages, `tool` messages carrying tool-approval responses (only valid while a turn is `awaiting_approval`), and `system` messages with `persist: false` for one-turn ephemeral instructions. Per-request webhook fields (`webhookUrl`, `x-webhook-secret`) are rejected — use `config.hooks.webhook` on the agent instead.

### Per-run Overrides

Optional top-level `system` and `model` fields override config for a **single** invocation (direct, async, and websocket). Nothing persists — model overrides are folded into a copy of the agent config for that run only.

```jsonc
{
  "agentId": "agent_...",
  "eventId": "req-003",
  "conversationKey": "my-first-conversation",
  "system": [
    {
      "role": "system",
      "content": "Answer concisely.",
      "persist": false
    }
  ],
  "model": {
    "temperature": 0.3,
    "maxOutputTokens": 4096,
    "providerOptions": {
      "openai": {
        "reasoningEffort": "high",
        "reasoningSummary": "auto"
      }
    }
  },
  "events": [ { "role": "user", "content": [ { "type": "text", "text": "Summarize today's plan." } ] } ]
}
```

`system` accepts one Vercel AI SDK-style system message event or an array of them. These events are request-local and follow the same ephemeral behavior as direct `events` entries with `persist: false`.

`model` accepts any standard Vercel AI SDK call setting (`temperature`, `topP`, `topK`, `maxOutputTokens`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`) and provider-specific `providerOptions`, the same shape used by `config.model`. The reserved keys `provider`, `modelId`, `output`, and `apiKey` are rejected so a request cannot swap the model, provider, structured output contract, or credentials.

### Enable Tools (Optional)

Add tools to your agent config:

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "tools": {
        "googleSearch": { "enabled": true },
        "tavilySearch": {
          "enabled": true,
          "apiKey": "YOUR_TAVILY_API_KEY"
        }
      }
    }
  }'
```

Available `config.tools` entries: `tavilySearch`, `tavilyExtract`, `googleSearch`, `handoffs`, and uploaded custom tools (`tool_<id>` keys). `async_status` is registered automatically when async tools or a persistent workspace sandbox are present. See [External Tools](tools.md).

### Set Up a Channel (Optional)

Connect a messaging platform so users can interact with your agent through Telegram, Discord, Slack, GitHub, Facebook Messenger (via Pancake), or Zalo.

#### Example: Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) and get the `botToken`.
2. Generate a random `webhookSecret` for webhook verification.
3. Update your agent config:

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "channels": {
        "telegram": {
          "botToken": "YOUR_BOT_TOKEN",
          "webhookSecret": "YOUR_WEBHOOK_SECRET",
          "allowedChatIds": [123456789]
        }
      }
    }
  }'
```

1. Set the webhook URL in Telegram:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "'"$AGENT_SERVICE_URL"'/webhooks/<ACCOUNT_ID>/<AGENT_ID>/telegram",
    "secret_token": "YOUR_WEBHOOK_SECRET"
  }'
```

Users can now message your bot on Telegram and get responses from your agent.

#### Other Channels

| Channel | Required config |
| --- | --- |
| Discord | `botToken`, `publicKey` |
| Slack | `botToken`, `signingSecret` |
| GitHub | `webhookSecret`, `appId`, `privateKey` |
| Pancake | `pageId`, `pageAccessToken`, `webhookSecret` |
| Zalo | `botToken`, `webhookSecret`, `allowedUserIds` |

See [Channels](channels/index.md) for full setup details.

### Run Example Scripts

The repository includes example scripts to probe a live deployment. Each demo has its own folder and `.env.example`:

```bash
cp packages/demos/stream/.env.example packages/demos/stream/.env
# fill in the service URLs from the deploy output and your model/tool keys

cd packages/demos/stream && bun index.ts
```

Each script creates a temporary account, runs the test, and cleans up.

### Define Your Own Agent Config

The agent config is a JSON object that controls everything about how your agent runs. Reference the [API Reference](/api-reference) for the complete `AgentConfig` schema.

Key config sections:

- `provider` — AI SDK provider constructor settings (Google, OpenAI, Bedrock, Gateway, MiniMax)
- `model` — `streamText` parameters: model ID, temperature, structured output, provider options
- `agent` — max turns and system prompt
- `tools` — external tools like Tavily and Google Search
- `sandbox` / `workspaces` — references to account-scoped sandbox and workspace records
- `skills` — account-scoped skill bundles
- `subagent` — parallel subagent dispatch
- `channels` — Telegram, Discord, Slack, GitHub, Pancake, Zalo
- `hooks` — lifecycle webhook events
- `session` — history pruning and compaction

---

## Next Steps

- [API Reference](/api-reference) — Interactive OpenAPI docs for all endpoints
- [Architecture](architecture.md) — how the platform works under the hood
- [External Tools](tools.md) — add custom tools for your agents
- [Skills](skills.md) — add account-scoped instruction bundles and enable the skill panel
- [Workspace](workspace/index.md) — workspace files, storage, and sandbox execution
- [Sub Agents](sub-agents.md) — dispatch parallel subagent tasks
- [Deployment](deployment.md) — SST secrets, deployment, account setup, and live probes
- [CI/CD](ci-cd.md) — GitHub Actions deployment and integration account setup

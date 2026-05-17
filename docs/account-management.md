# Account Management

Accounts are the tenant and authentication boundary for the harness. Runtime behavior lives on account-owned agents, so one account can run multiple agents with separate model, tool, channel, workspace, and skills configuration.

- `accountId`: generated stable identifier used in webhook URLs.
- `username`: required human-readable account name.
- `description`: optional purpose/usage note.
- `accountSecret`: one-time API secret returned on create or rotation.
- `agents`: encrypted runtime configurations created after account signup.

Account API secrets are stored as hashes. Provider tokens and webhook secrets must be usable at runtime, so they are stored inside encrypted agent config payloads.

## Create Account

`POST /accounts` on the `ACCOUNT_SERVICE_URL` is public and IP-rate-limited.

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Company A account"
  }'
```

Response:

```json
{
  "account": {
    "accountId": "acct_...",
    "username": "company-a",
    "description": "Company A account"
  },
  "accountSecret": "fp_acct_..."
}
```

Store `accountSecret` securely. It is not recoverable; rotate it if lost.

Account creation accepts identity only. Create at least one agent before sending runtime traffic.

## Manage Own Account

All self-management requests use:

```http
Authorization: Bearer <accountSecret>
```

Endpoints:

- `GET /accounts/me`
- `PATCH /accounts/me`
- `POST /accounts/me/rotate-secret`
- `DELETE /accounts/me`
- `POST /accounts/me/agents`
- `GET /accounts/me/agents`
- `GET|PATCH|DELETE /accounts/me/agents/{agentId}`
- `POST /accounts/me/skills`
- `GET /accounts/me/skills`
- `GET|PUT|DELETE /accounts/me/skills/{skillName}`

Patch account metadata:

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated account purpose"
  }'
```

`PATCH /accounts/me` accepts only account metadata. Create or update runtime `config` through the agent endpoints below.

Agent config patch behavior is a deep merge. Redacted secret placeholders returned by reads (`********`) preserve the existing stored secret if sent back. Set a config field to `null` to delete it, for example `"workspace": { "memory": { "namespace": null } }`.

## Agents

Create an agent after creating the account. A clear `description` is recommended because parent agents see this text when the agent is allowed as a predefined subagent.

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts/me/agents" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-agent",
    "description": "Customer support agent",
    "config": {
      "provider": { "google": { "apiKey": "..." } },
      "model": { "provider": "google", "modelId": "gemini-3-flash" },
      "agent": { "system": "You are a helpful support assistant." }
    }
  }'
```

Response:

```json
{
  "agent": {
    "accountId": "acct_...",
    "agentId": "agent_...",
    "name": "support-agent",
    "description": "Customer support agent"
  }
}
```

Direct and async runtime requests must include that `agentId`; channel webhook URLs also include it.

## Skills

Skills are account-scoped bundles stored in the skills S3 bucket under `<accountId>/<skill-name>`. Create a JSON skill:

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts/me/skills" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "json",
    "name": "support-flow",
    "description": "Handles support triage. Use when classifying customer support requests.",
    "content": "# Support Flow\n\nClassify urgency, product area, and next action."
  }'
```

Response:

```json
{
  "skill": {
    "skillPath": "acct_.../support-flow",
    "name": "support-flow",
    "description": "Handles support triage. Use when classifying customer support requests."
  }
}
```

Add that `skillPath` to an agent with:

```json
{
  "config": {
    "skills": {
      "enabled": true,
      "allowed": ["acct_.../support-flow"]
    }
  }
}
```

Skill uploads also support JSON base64 file bundles and public GitHub tree URLs. Every bundle must include a root `SKILL.md` with `name` and `description` YAML frontmatter. Agent create/update returns `404` for missing same-account skill paths and `401` for skill paths owned by a different account.

## Admin Account

`AdminAccountSecret` is an SST secret. Requests using it can manage all accounts:

- `GET /accounts`
- `GET /accounts/{accountId}`
- `PATCH /accounts/{accountId}`
- `POST /accounts/{accountId}/rotate-secret`
- `DELETE /accounts/{accountId}`

The admin account is virtual; it is not a normal account record.

## Delete Account

`DELETE /accounts/me` and admin `DELETE /accounts/{accountId}` remove the account and cascade cleanup for account-scoped runtime data:

- direct and channel conversation rows
- processed event dedupe rows and conversation leases
- async direct API status rows
- async external tool result rows
- current account filesystem, memory, and task objects
- account-owned agent records
- account-owned skill objects

Response:

```json
{
  "deleted": true,
  "cleanup": {
    "conversationsDeleted": 12,
    "processedEventsDeleted": 14,
    "asyncAgentResultDeleted": 2,
    "asyncToolResultDeleted": 3,
    "filesystemObjectsDeleted": 8,
    "agentsDeleted": 1,
    "skillObjectsDeleted": 4
  }
}
```

## Agent Config

Agent config is a JSON object passed via agent create/update. See [`examples/account.config.example.json`](../examples/account.config.example.json) for the full working example.

---

### Provider Config

Stores constructor settings for the AI SDK provider. The selected provider entry must exist and include its `apiKey`. Secret-like fields (`apiKey`, `secret`, `token`, `privateKey`) are encrypted at rest and redacted from reads.

```json
{
  "provider": {
    "google": { "apiKey": "...", "baseURL": "...", "headers": {} },
    "openai": { "apiKey": "...", "baseURL": "...", "organization": "...", "project": "...", "name": "..." },
    "bedrock": { "region": "us-east-1", "apiKey": "...", "accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "..." },
    "gateway": { "apiKey": "...", "baseURL": "...", "headers": {} },
    "minimax": { "apiKey": "...", "baseURL": "...", "headers": {} }
  }
}
```

| Provider | Field | Type | Description |
| ---------- | ------- | ------ | ------------- |
| `google` | `apiKey` | string | Google API key |
| | `baseURL` | string | Optional custom base URL |
| | `headers` | object | Optional custom headers |
| `openai` | `apiKey` | string | OpenAI API key |
| | `baseURL` | string | Optional custom base URL |
| | `organization` | string | OpenAI organization ID |
| | `project` | string | OpenAI project ID |
| | `name` | string | OpenAI API name |
| `bedrock` | `region` | string | AWS region (e.g., `us-east-1`) |
| | `apiKey` | string | AWS credentials or IAM role ARN |
| | `accessKeyId` | string | AWS access key ID |
| | `secretAccessKey` | string | AWS secret access key |
| | `sessionToken` | string | AWS session token for temp credentials |
| `gateway` | `apiKey` | string | Gateway API key |
| | `baseURL` | string | Optional custom base URL |
| | `headers` | object | Optional custom headers |
| `minimax` | `apiKey` | string | MiniMax API key |
| | `baseURL` | string | Optional custom base URL |
| | `headers` | object | Optional custom headers |

---

### Model Config

Controls the Vercel AI SDK `streamText` call. All standard `streamText` parameters are passed through directly — see the [Vercel AI SDK `streamText` docs](https://sdk.vercel.ai/providers/custom-providers/vercel-ai-sdk-guide#streamtext) for the full reference. The `options` field maps to `providerOptions`.

```json
{
  "model": {
    "provider": "google",
    "modelId": "gemini-3-flash",
    "temperature": 0.2,
    "maxOutputTokens": 16000,
    "topP": 0.95,
    "topK": 40,
    "stopSequences": ["STOP"],
    "headers": { "X-Custom-Header": "value" },
    "timeout": 120,
    "output": {
      "type": "object",
      "name": "AgentAnswer",
      "description": "A concise answer with optional follow-up actions.",
      "schema": {
        "type": "object",
        "properties": {
          "answer": { "type": "string" },
          "actions": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": ["answer"],
        "additionalProperties": false
      }
    },
    "options": {
      "google": { "thinkingConfig": { "thinkingLevel": "high" } }
    }
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `provider` | string | Provider constructor: `google`, `openai`, `bedrock`, `gateway`, or `minimax` |
| `modelId` | string | Provider-specific model identifier |
| `temperature` | number | Sampling temperature |
| `maxOutputTokens` | number | Maximum tokens in response |
| `topP` | number | Nucleus sampling threshold |
| `topK` | number | Top-k sampling threshold |
| `stopSequences` | string[] | Stop sequences to end the response |
| `headers` | object | Custom HTTP headers |
| `timeout` | number | Request timeout in seconds |
| `output` | object | Optional structured output config, mapped to Vercel AI SDK `Output.*` |
| `options` | object | Provider-specific `providerOptions` (maps to Vercel AI SDK `providerOptions`) |

Other supported `streamText` settings are passed through. Harness-owned fields, including messages, system prompt assembly, tool definitions, callbacks, and stop conditions, are controlled by the runtime and override account-provided values.

Structured output config is JSON-only so it can be stored in encrypted agent config. Use JSON Schema rather than Zod or custom validation functions.

| Output type | Required fields | Runtime mapping |
| ------- | ------ | ------------- |
| `text` | none | Default plain text behavior |
| `object` | `schema` object | `Output.object({ schema: jsonSchema(schema), name, description })` |
| `array` | `element` object | `Output.array({ element: jsonSchema(element), name, description })` |
| `choice` | non-empty `options` string array | `Output.choice({ options, name, description })` |
| `json` | none | `Output.json({ name, description })` |

When structured output is configured, direct async status and webhook responses return the parsed JSON value. Chat channels receive the same value formatted as pretty JSON.

---

### Agent Runtime Config

Controls harness behavior.

```json
{
  "agent": {
    "maxTurn": 20,
    "system": "Knowledge cutoff: January 2025.\n\nOptional agent-specific system prompt."
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `maxTurn` | number | Maximum model/tool loop steps per conversation turn |
| `system` | string | Replaces the generated default system prompt (not appended) |

> **Important:** The runtime always prepends an environment system prompt before this agent prompt. That environment prompt includes current runtime time and runtime timezone. Do not duplicate generic current-time instructions in `agent.system`; only add model knowledge cutoff, timezone, or calendar guidance here when the agent needs that stable rule.

### Skills Config

Optional. Omit `skills` when an agent has no skills. When `enabled` is true and `allowed` contains at least one skill path, the runtime includes allowed skill metadata in the system prompt and exposes the harness-managed `load_skill` tool.

```json
{
  "skills": {
    "enabled": true,
    "allowed": ["acct_.../support-flow"]
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `enabled` | boolean | Enables skill metadata and the `load_skill` tool |
| `allowed` | string[] | Account-scoped skill paths allowed for this agent |

---

### Subagent Config

Optional. Omit `subagent` when an agent should not dispatch child work. When enabled, the runtime exposes `run_subagent` and adds predefined subagent metadata to the parent prompt.

```json
{
  "subagent": {
    "enabled": true,
    "allowed": ["agent_..."],
    "context": "new"
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `enabled` | boolean | Enables `run_subagent`; omitted or false disables the tool |
| `allowed` | string[] | Predefined same-account agent ids the parent may call; empty means virtual subagents only |
| `context` | enum `"new"` or `"inherited"` | Default child context mode; omitted means `"new"` |

`run_subagent` accepts multiple model-generated tasks. A task may provide one of the allowed `agentId` values, or omit `agentId` to run a virtual one-shot subagent with the parent model and tool config. The runtime generates isolated child conversation keys automatically. Inherited context is passed to the child in memory only and is not copied into the child conversation table. Child results are injected back into the parent conversation as user events so the parent can continue proactively. See [Sub Agents](sub-agents.md).

---

### Workspace Config

Enables workspace-backed features. See [Memory and Session](memory-and-session.md) for the visual model.

```json
{
  "workspace": {
    "enabled": true,
    "needsApproval": true,
    "memory": { "enabled": true, "namespace": "support" },
    "tasks": { "enabled": true }
  }
}
```

| Key | Field | Type | Description |
| ------- | ------ | ------------- | ------------- |
| `enabled` | | boolean | Enables `MEMORY.md` and workspace tools |
| `needsApproval` | | boolean | Requires AI SDK approval before every enabled workspace tool execution |
| `memory` | `enabled` | boolean | Enables or disables `MEMORY.md` when workspace is enabled |
| | `namespace` | string | Session namespace key; `null` means per-conversation state |
| `filesystem` | `enabled` | boolean | Enables or disables the filesystem tool when workspace is enabled |
| `tasks` | `enabled` | boolean | Enables or disables the tasks tool when workspace is enabled |

---

### Session Config

Controls model-visible history management.

```json
{
  "session": {
    "pruning": { "enabled": true },
    "compaction": { "enabled": false, "maxContextLength": 100000 }
  }
}
```

| Key | Field | Type | Description |
| ------- | ------ | ------------- | ------------- |
| `pruning` | `enabled` | boolean | Enables automatic history pruning (default: `true`) |
| `compaction` | `enabled` | boolean | Enables context compaction (default: `false`) |
| | `maxContextLength` | number | Serialized character-length threshold for compaction triggers |

---

### Tools Config

Enables external tools. Omitting `tools` or setting `enabled: false` disables the tool. The tool name must match an available tool; invalid names fail when the harness assembles tools for a turn. Local `execute` tools can set `async: true` to return immediately and inject their completed result into the same conversation later.

Developer guide: [External Tools](tools.md).

Available tools: `tavilySearch`, `tavilyExtract`, `googleSearch`, `test_async`, `test_external_async`.

```json
{
  "tools": {
    "tavilySearch": {
      "enabled": true,
      "async": true,
      "needsApproval": true,
      "apiKey": "...",
      "searchDepth": "advanced",
      "includeAnswer": true,
      "maxResults": 10,
      "topic": "general"
    },
    "tavilyExtract": {
      "enabled": true,
      "apiKey": "...",
      "extractDepth": "advanced",
      "format": "markdown"
    },
    "googleSearch": {
      "enabled": true,
      "searchTypes": {
        "webSearch": {},
        "imageSearch": {}
      },
      "timeRangeFilter": {
        "startTime": "2026-01-01",
        "endTime": "2026-05-01"
      }
    },
    "test_async": {
      "enabled": true,
      "async": true,
      "execution": "same-invocation"
    }
  }
}
```

| Tool | Field | Type | Description |
| ------ | ------- | ------ | ------------- |
| `tavilySearch` | `enabled` | boolean | Enable the tool |
| | `async` | boolean | Return immediately and inject the completed local `execute` result later |
| | `execution` | `same-invocation` \| `external-dispatch` | Async lifecycle; defaults to `same-invocation` |
| | `needsApproval` | boolean | Require AI SDK approval before execution |
| | `apiKey` | string | Tavily API key; required unless `TAVILY_API_KEY` is set |
| | `searchDepth` | `basic` \| `advanced` | Search depth |
| | `includeAnswer` | boolean | Include a direct answer |
| | `maxResults` | number | Max results (1–20, default: 5) |
| | `topic` | `general` \| `news` \| `finance` | Search topic |
| `tavilyExtract` | `enabled` | boolean | Enable the tool |
| | `async` | boolean | Return immediately and inject the completed local `execute` result later |
| | `execution` | `same-invocation` \| `external-dispatch` | Async lifecycle; defaults to `same-invocation` |
| | `needsApproval` | boolean | Require AI SDK approval before execution |
| | `apiKey` | string | Tavily API key; required unless `TAVILY_API_KEY` is set |
| | `extractDepth` | `basic` \| `advanced` | Extraction depth |
| | `format` | `markdown` \| `text` | Output format |
| `googleSearch` | `enabled` | boolean | Enable the tool; requires `config.model.provider` to be `google` |
| | `async` | boolean | Accepted for config consistency, but provider-defined tools without local `execute` cannot use async wrapping |
| | `execution` | `same-invocation` \| `external-dispatch` | Accepted for config consistency, but ignored without local `execute` |
| | `needsApproval` | boolean | Require AI SDK approval before execution |
| | `searchTypes` | object | Keys: `webSearch`, `imageSearch` (each is an empty object or with options) |
| | `timeRangeFilter.startTime` | string | ISO date string, filter results after this date |
| | `timeRangeFilter.endTime` | string | ISO date string, filter results before this date |
| `test_async` | `enabled` | boolean | Enable the local async example tool |
| | `async` | boolean | Return immediately and inject the completed local `execute` result later |
| | `execution` | `same-invocation` \| `external-dispatch` | Async lifecycle; defaults to `same-invocation` |
| | `needsApproval` | boolean | Require AI SDK approval before execution |
| `test_external_async` | `enabled` | boolean | Enable the external-dispatch mock tool fixture |
| | `async` | boolean | Should be `true` for this fixture |
| | `execution` | `external-dispatch` | Dispatch to the mock worker and continue after callback |
| | `completionBaseUrl` | string | Harness `AGENT_SERVICE_URL` used to build the callback URL |
| | `completionBearerToken` | string | Account bearer token used by the mock worker callback |

---

### Channels Config

Provider webhook URLs must include the `accountId` and `agentId`:

Developer guide: [Channels](channels.md).

```bash
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/telegram
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/github
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/slack
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/discord
{AGENT_SERVICE_URL}/webhooks/{accountId}/{agentId}/pancake
```

```json
{
  "channels": {
    "telegram": {
      "botToken": "...",
      "webhookSecret": "...",
      "allowedChatIds": [123456789],
      "reactionEmoji": "👀"
    },
    "github": {
      "webhookSecret": "...",
      "appId": "...",
      "privateKey": "...",
      "allowedRepos": ["owner/repo"]
    },
    "slack": {
      "botToken": "...",
      "signingSecret": "...",
      "allowedChannelIds": ["C123"]
    },
    "discord": {
      "botToken": "...",
      "publicKey": "...",
      "allowedGuildIds": ["123"]
    },
    "pancake": {
      "pageId": "page-id",
      "pageAccessToken": "...",
      "senderId": "optional-staff-user-id"
    }
  }
}
```

| Channel | Field | Type | Description |
| --------- | ------- | ------ | ------------- |
| `telegram` | `botToken` | string | Telegram bot token |
| | `webhookSecret` | string | Webhook verification secret |
| | `allowedChatIds` | number[] | List of allowed chat IDs |
| | `reactionEmoji` | string | Emoji reaction to sent messages |
| `github` | `webhookSecret` | string | Webhook verification secret |
| | `appId` | string | GitHub App ID |
| | `privateKey` | string | GitHub App private key (PEM) |
| | `allowedRepos` | string[] | Allowed repository slugs (`owner/repo`) |
| `slack` | `botToken` | string | Slack bot token |
| | `signingSecret` | string | Slack signing secret |
| | `allowedChannelIds` | string[] | List of allowed channel IDs |
| `discord` | `botToken` | string | Discord bot token |
| | `publicKey` | string | Discord public key for webhook verification |
| | `allowedGuildIds` | string[] | List of allowed guild/server IDs |
| `pancake` | `pageId` | string | Pancake page ID accepted by the webhook |
| | `pageAccessToken` | string | Pancake page access token for replies |
| | `senderId` | string | Optional Pancake staff user ID used when sending replies |

For deploying as a customer service, the owner creates an account and links the bot integration. Customers only interact with the provider bot/app. CI/CD configures the default Telegram account and other providers — see [CI/CD Account Setup](operations.md#ci-cd-account-setup).

Pancake webhooks are page-validated because the public Pancake webhook docs do not document a signature or secret header. Keep the webhook URL private and configure the expected `pageId`.

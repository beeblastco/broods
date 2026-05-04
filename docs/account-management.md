# Account Management

Accounts are the configuration boundary for the harness. Each account has:

- `accountId`: generated stable id used in webhook URLs.
- `username`: required human-readable account name.
- `description`: optional purpose/usage note.
- `accountSecret`: one-time API secret returned on create or rotation.
- `config`: encrypted account configuration used by `harness-processing`.

Account API secrets are stored as hashes. Provider tokens and webhook secrets must be usable at runtime, so they are stored inside the encrypted account config payload.

## Create Account

`POST /accounts` on the `ACCOUNT_SERVICE_URL` is public and IP-rate-limited.

```bash
curl -X POST "$ACCOUNT_SERVICE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Customer support agent for Company A"
  }'
```

Response:

```json
{
  "account": {
    "accountId": "acct_...",
    "username": "company-a",
    "description": "Customer support agent for Company A",
    "status": "active",
    "config": {},
    "createdAt": "2026-05-01T00:00:00.000Z",
    "updatedAt": "2026-05-01T00:00:00.000Z"
  },
  "accountSecret": "fp_acct_..."
}
```

Store `accountSecret` securely. It is not recoverable; rotate it if lost.

If `config` is omitted, the stored config is `{}`. Runtime requests will fail until `config.model.provider`, `config.model.modelId`, and the matching `config.provider.<provider>.apiKey` are configured.

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

Patch account metadata or config:

```bash
curl -X PATCH "$ACCOUNT_SERVICE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated account purpose",
    "config": {
      "workspace": {
        "enabled": true,
        "memory": {
          "namespace": "support"
        }
      },
      "channels": {
        "telegram": {
          "botToken": "...",
          "webhookSecret": "...",
          "allowedChatIds": [123456789]
        }
      }
    }
  }'
```

Patch behavior is a deep merge. Redacted secret placeholders returned by reads (`********`) preserve the existing stored secret if sent back. Set a config field to `null` to delete it, for example `"workspace": { "memory": { "namespace": null } }`.

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
- current account filesystem, memory, and task objects

Response:

```json
{
  "deleted": true,
  "cleanup": {
    "conversationsDeleted": 12,
    "processedEventsDeleted": 14,
    "asyncResultsDeleted": 2,
    "filesystemObjectsDeleted": 8
  }
}
```

## Account Config

The account config is a JSON object passed via `PATCH /accounts/me` (deep-merged). See [`examples/account.config.example.json`](../examples/account.config.example.json) for the full working example.

---

### Provider Config

Stores constructor settings for the AI SDK provider. The selected provider entry must exist and include its `apiKey`. Secret-like fields (`apiKey`, `secret`, `token`, `privateKey`) are encrypted at rest and redacted from reads.

```json
{
  "provider": {
    "google": { "apiKey": "...", "baseURL": "...", "headers": {} },
    "openai": { "apiKey": "...", "baseURL": "...", "organization": "...", "project": "...", "name": "..." },
    "bedrock": { "region": "us-east-1", "apiKey": "...", "accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "..." },
    "gateway": { "apiKey": "...", "baseURL": "...", "headers": {} }
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
    "options": {
      "google": { "thinkingConfig": { "thinkingLevel": "high" } }
    }
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `provider` | string | Provider constructor: `google`, `openai`, `bedrock`, or `gateway` |
| `modelId` | string | Provider-specific model identifier |
| `temperature` | number | Sampling temperature |
| `maxOutputTokens` | number | Maximum tokens in response |
| `topP` | number | Nucleus sampling threshold |
| `topK` | number | Top-k sampling threshold |
| `stopSequences` | string[] | Stop sequences to end the response |
| `headers` | object | Custom HTTP headers |
| `timeout` | number | Request timeout in seconds |
| `options` | object | Provider-specific `providerOptions` (maps to Vercel AI SDK `providerOptions`) |

Other supported `streamText` settings are passed through. Harness-owned fields, including messages, system prompt assembly, tool definitions, callbacks, and stop conditions, are controlled by the runtime and override account-provided values.

---

### Agent Config

Controls harness behavior.

```json
{
  "agent": {
    "maxTurn": 20,
    "system": "Optional account-specific system prompt."
  }
}
```

| Field | Type | Description |
| ------- | ------ | ------------- |
| `maxTurn` | number | Maximum model/tool loop steps per conversation turn |
| `system` | string | Replaces the generated default system prompt (not appended) |

---

### Workspace Config

Enables workspace-backed features. See [Memory and Session](memory-and-session.md) for the visual model.

```json
{
  "workspace": {
    "enabled": true,
    "memory": { "namespace": "support" }
  }
}
```

| Key | Field | Type | Description |
| ------- | ------ | ------------- | ------------- |
| `enabled` | | boolean | Enables `MEMORY.md`, filesystem tool, and tasks tool |
| `memory` | `namespace` | string | Session namespace key; `null` means per-conversation state |

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

Enables inline tools. Omitting `tools` or setting `enabled: false` disables the tool. The tool name must match an available tool; invalid names fail when the harness assembles tools for a turn.

Available tools: `tavilySearch`, `tavilyExtract`, `googleSearch`.

```json
{
  "tools": {
    "tavilySearch": {
      "enabled": true,
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
    }
  }
}
```

| Tool | Field | Type | Description |
| ------ | ------- | ------ | ------------- |
| `tavilySearch` | `enabled` | boolean | Enable the tool |
| | `apiKey` | string | Tavily API key; required unless `TAVILY_API_KEY` is set |
| | `searchDepth` | `basic` \| `advanced` | Search depth |
| | `includeAnswer` | boolean | Include a direct answer |
| | `maxResults` | number | Max results (1–20, default: 5) |
| | `topic` | `general` \| `news` \| `finance` | Search topic |
| `tavilyExtract` | `enabled` | boolean | Enable the tool |
| | `apiKey` | string | Tavily API key; required unless `TAVILY_API_KEY` is set |
| | `extractDepth` | `basic` \| `advanced` | Extraction depth |
| | `format` | `markdown` \| `text` | Output format |
| `googleSearch` | `enabled` | boolean | Enable the tool; requires `config.model.provider` to be `google` |
| | `searchTypes` | object | Keys: `webSearch`, `imageSearch` (each is an empty object or with options) |
| | `timeRangeFilter.startTime` | string | ISO date string, filter results after this date |
| | `timeRangeFilter.endTime` | string | ISO date string, filter results before this date |

---

### Channels Config

Provider webhook URLs must include the account id:

```bash
{AGENT_SERVICE_URL}/webhooks/{accountId}/telegram
{AGENT_SERVICE_URL}/webhooks/{accountId}/github
{AGENT_SERVICE_URL}/webhooks/{accountId}/slack
{AGENT_SERVICE_URL}/webhooks/{accountId}/discord
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

For deploying as a customer service, the owner creates an account and links the bot integration. Customers only interact with the provider bot/app. CI/CD configures the default Telegram account and other providers — see [CI/CD Account Setup](operations.md#ci-cd-account-setup).

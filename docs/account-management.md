# Account Management

Accounts are the configuration boundary for the harness. Each account has:

- `accountId`: generated stable id used in webhook URLs.
- `username`: required human-readable account name.
- `description`: optional purpose/usage note.
- `accountSecret`: one-time API secret returned on create or rotation.
- `config`: encrypted account configuration used by `harness-processing`.

Account API secrets are stored as hashes. Provider tokens and webhook secrets must be usable at runtime, so they are stored inside the encrypted account config payload.

## Create Account

`POST /accounts` on the `account-manage` Function URL is public and IP-rate-limited.

```bash
curl -X POST "$ACCOUNT_MANAGE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Customer support agent for Company A",
    "config": {
      "modelId": "gemma-4-31b-it",
      "memoryNamespace": "support",
      "channels": {}
    }
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
    "config": {
      "modelId": "gemma-4-31b-it",
      "memoryNamespace": "support",
      "channels": {}
    },
    "createdAt": "2026-05-01T00:00:00.000Z",
    "updatedAt": "2026-05-01T00:00:00.000Z"
  },
  "accountSecret": "fp_acct_..."
}
```

Store `accountSecret` securely. It is not recoverable; rotate it if lost.

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
curl -X PATCH "$ACCOUNT_MANAGE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated account purpose",
    "config": {
      "memoryNamespace": "support",
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

Patch behavior is a deep merge. Redacted secret placeholders returned by reads (`********`) preserve the existing stored secret if sent back. Set a config field to `null` to delete it, for example `"memoryNamespace": null`.

## Admin Account

`AdminAccountSecret` is an SST secret. Requests using it can manage all accounts:

- `GET /accounts`
- `GET /accounts/{accountId}`
- `PATCH /accounts/{accountId}`
- `POST /accounts/{accountId}/rotate-secret`
- `DELETE /accounts/{accountId}`

The admin account is virtual; it is not a normal account record.

## Account Config

Top-level runtime config:

```json
{
  "modelId": "gemma-4-31b-it",
  "maxAgentIterations": 20,
  "slidingContextWindow": 20,
  "systemPrompt": "Optional account-specific system prompt.",
  "memoryNamespace": "support",
  "channels": {}
}
```

`memoryNamespace` controls whether memory/files are per conversation or shared across conversations in the same account. See [Memory and Session](memory-and-session.md) for the visual model.

Channel config:

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

Provider webhook URLs must include the account id:

```text
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/telegram
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/github
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/slack
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/discord
```

Customers only interact with the provider bot/app. They do not receive account secrets.

CI/CD keeps the default Telegram bot on the account model by creating or updating a `telegram-default` account and registering Telegram to `/webhooks/{accountId}/telegram` after deploy.

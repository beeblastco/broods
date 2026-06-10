# Data Security

This is an experiment product, so the security model is simple by design. It avoids storing provider secrets as plain JSON in DynamoDB, but it is not a final production-grade secrets system.

## What Is Stored

```mermaid
flowchart TD
  Account["Account record"] --> Meta["Plain metadata<br/>accountId, username, description, status"]
  Account --> Hash["Account secret hash<br/>secretHash"]
  Account --> Agent["Agent records"]
  Agent --> Config["Encrypted agent config blob<br/>model, tool, subagent, and channel settings"]
  Agent --> Workspace["Workspace S3 objects<br/>files and staged skills"]
  Agent --> Skills["Skill S3 objects<br/>account-scoped bundles"]

  Config --> Model["model provider/options"]
  Config --> Tools["tool allowlist/options"]
  Config --> Sandbox["sandbox provider/options"]
  Config --> Subagents["subagent allowlist/context mode"]
  Config --> Telegram["Telegram token / webhook secret"]
  Config --> GitHub["GitHub app id / private key / webhook secret"]
  Config --> Slack["Slack bot token / signing secret"]
  Config --> Discord["Discord bot token / public key"]
  Config --> Pancake["Pancake page access token"]
  Config --> Zalo["Zalo bot token / webhook secret"]
```

The account API secret is never stored directly. It is returned once on create or rotation, then only `secretHash` is stored.

Provider credentials and account-specific runtime options must be usable at runtime, so they cannot be hashed. They are stored inside encrypted account-owned agent config. Normal account and agent responses recursively redact secret-like field names such as `token`, `secret`, `privateKey`, and `apiKey`, including inside tool config.

Workspace files, skill bundles, and uploaded tool bundles are stored as account-scoped S3 objects (workspace, skills, and tool-bundles buckets). The buckets block public access and use a deny-by-default bucket policy that allows only the project runtime roles, sandbox runtime roles, the AWS S3 Files role, and deployment roles for the active stage.

## How Config Encryption Works

```mermaid
sequenceDiagram
  participant API as account-manage
  participant Crypto as AES-256-GCM
  participant DDB as DynamoDB AgentConfig
  participant Harness as harness-processing

  API->>Crypto: encrypt config with ACCOUNT_CONFIG_ENCRYPTION_SECRET
  Crypto->>DDB: store ciphertext + iv + auth tag
  Harness->>DDB: load selected agent record
  Harness->>Crypto: decrypt config
  Harness->>Harness: verify webhooks / send replies
```

Current implementation:

- AES-256-GCM encrypts the config before DynamoDB write.
- `ACCOUNT_CONFIG_ENCRYPTION_SECRET` comes from SST secrets.
- DynamoDB stores encrypted config, not readable provider credentials.
- Lambdas decrypt config only when they need selected agent runtime settings.

## API Responses

Normal account responses redact secret-like fields:

```text
********
```

If a client sends `********` back in a patch, the existing real secret is preserved.

## Why Keep It This Way

This keeps the product easy to run and change:

- No extra Secrets Manager objects per account.
- No KMS decrypt call on every config read.
- Account metadata and agent runtime config stay in DynamoDB without per-provider secret resources.
- Good enough for an experiment product.

## Limits

- `ACCOUNT_CONFIG_ENCRYPTION_SECRET` must be protected.
- Lambdas with the encryption secret and table access can decrypt config.
- Key rotation needs a migration.
- This protects against accidental table-read exposure, not compromised application code.
- Third-party sandbox providers such as E2B, Daytona, and Vercel run outside the AWS Lambda sandbox boundary. Configure them with isolated mounts, minimal environment variables, provider-side egress controls, and no account/provider secrets unless a workload explicitly needs them. Daytona S3 mounts receive short-lived credentials from the dedicated `sandbox-s3mount` IAM role, scoped to the workspace's own key prefix — never the harness runtime's credentials.

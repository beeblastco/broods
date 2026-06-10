# CI/CD

GitHub Actions runs CI on pull requests and pushes. Both workflows skip docs-only changes (`docs/**`, `**/*.md`).

Deploys run on push to two branches, plus manual `workflow_dispatch` with a stage input:

| Branch | Stage | Notes |
| --- | --- | --- |
| `dev` | `dev` | re-runs validation before deploying; DynamoDB storage |
| `main` | `production` | skips re-validation; Convex storage |

A separate workflow (`deploy-docs.yaml`) builds the Docusaurus site on `main` pushes touching docs and syncs it to S3 + CloudFront (vars `DOCS_S3_BUCKET`, `DOCS_DOMAIN`).

## Required Secrets and Variables

The deploy step hard-fails without these repository secrets:

- `SST_SECRET_ADMINACCOUNTSECRET`
- `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`
- `SST_SECRET_GOOGLEAPIKEY`
- `SST_SECRET_TAVILYAPIKEY`
- `DAYTONA_API_KEY` (mapped to the `DaytonaApiKey` SST secret)
- `MOCK_WEBHOOK_SECRET`

`KUBERNETES_SANDBOX_KUBECONFIG` is optional (enables the Kubernetes sandbox provider).

And these repository variables: `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_ACCOUNT_ID`, `PROJECT_NAME`, `PROJECT_OWNER_EMAIL`.

## Account Setup

After a non-`main` deploy (community/dev stages only — production accounts are managed in Convex), the workflow runs channel setup scripts. The scripts share one account, `INTEGRATIONS_ACCOUNT_USERNAME` or `integrations-default`, then create or update one default agent per configured channel.

```bash
bun run scripts/configure-telegram-account.ts
bun run scripts/configure-discord-account.ts
bun run scripts/configure-slack-account.ts
bun run scripts/configure-github-account.ts
bun run scripts/configure-zalo-account.ts
```

Telegram, Discord, and GitHub steps fail the workflow when their credentials are missing; Slack and Zalo skip instead. `scripts/configure-pancake-account.ts` exists for manual use but is not wired into the workflow.

Each script uses `ADMIN_ACCOUNT_SECRET` for auth. Account and agent descriptions are optional; set `INTEGRATIONS_ACCOUNT_DESCRIPTION` or channel-specific `*_AGENT_DESCRIPTION` only when those fields should be stored.

Optional agent-name overrides are available when stable names are needed:

- `TELEGRAM_AGENT_NAME`
- `DISCORD_AGENT_NAME`
- `SLACK_AGENT_NAME`
- `GITHUB_AGENT_NAME`
- `PANCAKE_AGENT_NAME`
- `ZALO_AGENT_NAME`

The integration scripts include `Knowledge cutoff: January 2025.` in `config.agent.system` by default. Override it with `ACCOUNT_MODEL_KNOWLEDGE_CUTOFF` when changing `ACCOUNT_MODEL_ID` to a model with a different cutoff.

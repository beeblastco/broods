# CI/CD

GitHub Actions runs CI on pull requests and non-`main` pushes. Pushes to `main` deploy through SST after the build passes.

## Required Secrets

Deploy requires these repository secrets:

- `SST_SECRET_ADMINACCOUNTSECRET`
- `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`

These map to the SST secrets used by the two public Lambda services.

## Account Setup

After deploy, the workflow can run channel setup scripts when the matching credentials are present. The scripts share one account, `INTEGRATIONS_ACCOUNT_USERNAME` or `integrations-default`, then create or update one default agent per configured channel.

```bash
bun run scripts/configure-telegram-account.ts
bun run scripts/configure-discord-account.ts
bun run scripts/configure-slack-account.ts
bun run scripts/configure-github-account.ts
bun run scripts/configure-pancake-account.ts
```

Each script uses `ADMIN_ACCOUNT_SECRET` for auth. Account and agent descriptions are optional; set `INTEGRATIONS_ACCOUNT_DESCRIPTION` or channel-specific `*_AGENT_DESCRIPTION` only when those fields should be stored.

Optional agent-name overrides are available when stable names are needed:

- `TELEGRAM_AGENT_NAME`
- `DISCORD_AGENT_NAME`
- `SLACK_AGENT_NAME`
- `GITHUB_AGENT_NAME`
- `PANCAKE_AGENT_NAME`

The integration scripts include `Knowledge cutoff: January 2025.` in `config.agent.system` by default. Override it with `ACCOUNT_MODEL_KNOWLEDGE_CUTOFF` when changing `ACCOUNT_MODEL_ID` to a model with a different cutoff.

# Operations

## Configuration

`sst.config.ts` is the source of truth for infra names, tags, regions, secrets, and integration flags.

Use `.env` for local SST inputs and non-secret toggles:

- `AWS_PROFILE`
- `SST_STAGE`
- `ENABLE_DIRECT_API`
- `ENABLE_TELEGRAM_INTEGRATION`
- `ENABLE_GITHUB_INTEGRATION`
- `ENABLE_SLACK_INTEGRATION`
- `ENABLE_DISCORD_INTEGRATION`
- All other variables can be setup, see [`.env.example`](../.env.example).

Use SST secrets for runtime secrets and tokens. See [`secrets.env.example`](../secrets.env.example).

Allow-list semantics:

- In `dev`, you may omit the variable or set it to `open` for intentionally unrestricted local testing.
- Outside `dev`, configure an explicit comma-separated list whenever the integration is enabled.
- Set the value to `closed` to deny all resources until explicit IDs or names are configured.

Important repo conventions:

- Extra channel integrations are opt-in.
- GitHub, Slack, and Discord allow-lists must be explicitly configured outside `dev` when those integrations are enabled.
- The system prompt is bundled at build time by `scripts/system-prompt.ts`.
- There is no `phicks` stage for deployment; use `dev` unless another real stage is intentionally added.

## Local Setup

Install dependencies:

```bash
bun install
```

Copy local config:

```bash
cp .env.example .env
```

Keep `.env` for local SST config only. Use at least these values:

```bash
AWS_PROFILE=default
SST_STAGE=dev
```

Do not put deployed secrets in `.env`.

Set required SST secrets:

```bash
bunx sst secret set GoogleApiKey <value>
```

Optional:

```bash
bunx sst secret set TavilyApiKey <value>
```

If you want the public Function URL to accept direct API requests, also enable `ENABLE_DIRECT_API=true` and set:

```bash
bunx sst secret set DirectApiSecret <value>
```

Or bulk load:

```bash
cp secrets.env.example secrets.env
bunx sst secret load ./secrets.env
```

## Run, Build, and Deploy

```bash
bun run dev
bun run check
bun run build
bun run deploy
```

`bun run deploy` runs `bun run build` first, then `sst deploy`.

If Discord is enabled, sync slash commands with:

```bash
bun run discord:sync
```

## CI and Live Probes

- GitHub Actions runs CI on pull requests and non-`main` pushes, and deploys on pushes to `main`.
- `bun run test` runs the direct API unit tests locally.
- `scripts/manual/direct-api-*.ts` and `scripts/manual/async-api-tool-call.ts` are opt-in live probes for a deployed Function URL; they are not part of CI.
- Use `gh run list` and `gh run view` to inspect pipeline status.

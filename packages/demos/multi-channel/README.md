# Multi-Channel (Slack + Telegram + GitHub)

1. Run `bun install` and `bun run dev` to sync channels.
2. Run `bun run register` to auto-register webhook URLs for all configured channels.

## Slack

Auto-registers via Slack's Manifest API when `SLACK_CONFIG_TOKEN`, `SLACK_APP_ID`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

## Telegram

Auto-registers via the Telegram Bot API when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

## GitHub

Prints the GitHub App webhook URL. Configure it in the GitHub App settings with the same `GITHUB_WEBHOOK_SECRET`.

## Workspace Memory

The demo uses a persistent Lambda MicroVM sandbox attached to an S3-backed workspace. Durable files such as `MEMORY.md` and `TASKS.md` should be written with the workspace file tools; shell state and installed packages are kept while the reserved MicroVM is alive.

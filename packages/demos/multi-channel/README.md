# Multi-Channel (Slack + Telegram)

1. Run `bun install` and `bun run dev` to sync channels.
2. Run `bun run register` to auto-register webhook URLs for all configured channels.

## Slack

Auto-registers via Slack's Manifest API when `SLACK_CONFIG_TOKEN`, `SLACK_APP_ID`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

## Telegram

Auto-registers via the Telegram Bot API when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

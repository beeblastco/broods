# Slack Channel

1. Run `bun install` and `bun run dev` to sync the Slack channel.
2. Run `bun run register` to print the webhook URL and configuration instructions.

To auto-register via Slack's Manifest API, add `SLACK_APP_TOKEN` (xapp- with `manifest` scope) and `SLACK_APP_ID` to `.env.local`.

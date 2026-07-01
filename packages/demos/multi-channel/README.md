# Multi-Channel (Slack + Telegram + GitHub)

1. Run `bun install` and `bun run dev` to sync channels.
2. Run `bun run register` to auto-register webhook URLs for all configured channels.

## Slack

Auto-registers via Slack's Manifest API when `SLACK_CONFIG_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`, and `SLACK_APP_ID` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

Generate the config token pair from the Slack app's App Manifest page. This is separate from OAuth bot-token rotation in OAuth & Permissions; the demo keeps `SLACK_BOT_TOKEN` as the bot token used by the deployed agent and `SLACK_SIGNING_SECRET` as the webhook verification secret.

## Telegram

Auto-registers via the Telegram Bot API when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set in `.env.local`. Otherwise prints the webhook URL for manual configuration.

## GitHub

Auto-registers the GitHub App webhook URL and secret when `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` are set in `.env.local`. `GITHUB_PRIVATE_KEY` may be either a PEM string or a base64-encoded PEM.

In the GitHub App settings, manually subscribe to these webhook events: `issues`, `issue_comment`, `pull_request`, and `pull_request_review_comment`. The app also needs enough repository permissions to read those events and write replies/reactions on issues and pull requests.

The sandbox also uses the same GitHub App credentials for git operations. Install the app on every repository the agent should be allowed to work on and grant at least:

- Metadata: read
- Contents: read and write
- Issues: read and write
- Pull requests: read and write

Grant Workflows read/write too if the agent should edit files under `.github/workflows/`. The persistent sandbox `onCreate` and `onResume` hooks write a GitHub App credential helper for normal HTTPS git commands and a `broods-github-token owner/repo` helper for direct GitHub API calls such as opening pull requests. The hook does not clone a fixed repository or select a branch; the agent chooses the repository from the GitHub issue/PR context or the user's request, and GitHub provides the default branch during clone. The helpers mint short-lived installation tokens on demand, so no long-lived PAT is stored in the workspace.

## Workspace Memory

The demo uses a persistent Lambda MicroVM sandbox attached to an S3-backed workspace. Durable files such as `MEMORY.md` and `TASKS.md` should be written with the workspace file tools; shell state and installed packages are kept while the reserved MicroVM is alive.

# Zalo Channel

Run `bun install`, `bun run dev`, then `bun run register` to register the generated webhook URL with Zalo.

Optional environment variables:

- `ZALO_ALLOWED_USER_IDS`: comma-separated Zalo user IDs allowed to trigger the agent.
- `ZALO_ALLOWED_GROUP_IDS`: comma-separated Zalo group chat IDs the agent answers in.
- `ZALO_BOT_NAME`: name the agent answers to in group chats, matched case-insensitively with an optional leading `@`. Group messages that do not mention it are kept as context instead of running the agent. Unset means every group message runs the agent.

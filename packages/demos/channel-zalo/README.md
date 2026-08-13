# Zalo Channel

Run `bun install`, `bun run dev`, then `bun run register` to register the generated webhook URL with Zalo.

Optional environment variables:

- `ZALO_ALLOWED_USER_IDS`: comma-separated Zalo user IDs allowed to trigger the agent.
- `ZALO_ALLOWED_GROUP_IDS`: comma-separated Zalo group chat IDs the agent answers in.

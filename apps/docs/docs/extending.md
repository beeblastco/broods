# Extending

This page only points at the doc that owns each extension path. The steps live there so they do not drift.

## Add an external tool

Use [External Tools](tools.md) for Tavily-style, Google Search-style, or other agent-configured integrations that call outside services from the model loop.

## Add a channel

Use [Channels](channels/index.md) for Telegram, GitHub, Slack, Discord, or any new communication channel that receives provider webhooks and sends provider replies.

## Add a command

1. Add a new entry to the `commands` array in [`src/shared/commands.ts`](https://github.com/beeblastco/broods/blob/dev/apps/core/src/shared/commands.ts).
2. Include aliases, description, and an execute function.
3. Use the channel-agnostic `ChannelActions` interface from shared code.

Commands should not import channel-specific modules.

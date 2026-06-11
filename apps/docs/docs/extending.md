# Extending

Use this page as a routing guide for extension work. Keep detailed implementation steps in the focused docs so the same instructions do not drift.

## Add an External Tool

Use [External Tools](tools.md) for Tavily-style, Google Search-style, or other agent-configured integrations that call outside services from the model loop.

## Add a Channel

Use [Channels](channels/index.md) for Telegram, GitHub, Slack, Discord, or any new communication channel that receives provider webhooks and sends provider replies.

## Add a Command

1. Add a new entry to the `commands` array in [`functions/_shared/commands.ts`](https://github.com/beeblastco/filthy-panty/blob/dev/apps/core/functions/_shared/commands.ts).
2. Include aliases, description, and an execute function.
3. Use the channel-agnostic `ChannelActions` interface from shared code.

Commands should not import channel-specific modules.

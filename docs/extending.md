# Extending

## Add a Tool

1. Create `functions/harness-processing/tools/<name>.tool.ts`.
2. Export a default tool factory.
3. Put the tool logic directly inside the tool's `execute`.
4. Register the factory in [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts).

Tool execution is inline inside `harness-processing`. Do not add queue-based tool execution or external tool Lambda wiring unless the architecture intentionally changes.

## Add a Channel

1. Implement `ChannelAdapter` in `functions/_shared/<channel>-channel.ts`.
2. Wire normalization and routing into [`functions/harness-processing/integrations.ts`](../functions/harness-processing/integrations.ts).
3. Keep reply formatting and send logic inside that channel module.

Reply sending should stay inside the channel's `ChannelActions`; do not hardcode channel-specific logic into shared handlers or the core agent loop.

## Add a Command

1. Add a new entry to the `commands` array in [`functions/_shared/commands.ts`](../functions/_shared/commands.ts).
2. Include aliases, description, and an execute function.
3. Use the channel-agnostic `ChannelActions` interface from shared code.

Commands should not import channel-specific modules.

# Extending

## Add a Tool

1. Create `functions/harness-processing/tools/<name>.tool.ts`.
2. Export a default tool factory.
3. Put the tool logic directly inside the tool's `execute`.
4. Register the factory in the `toolFactories` map in [`functions/harness-processing/tools/index.ts`](../functions/harness-processing/tools/index.ts).
5. If the tool has account-level options, add only that tool's option validation in [`functions/_shared/accounts.ts`](../functions/_shared/accounts.ts).

Tool execution is inline inside `harness-processing`. Do not add queue-based tool execution or external tool Lambda wiring unless the architecture intentionally changes.

Tools are account-configured and opt-in. `tools/index.ts` should stay focused on static imports, the factory map, and config-driven selection. Keep tool-specific logic in the tool file itself.

Example account config:

```json
{
  "tools": {
    "tavilySearch": { "enabled": true, "maxResults": 5, "needsApproval": true },
    "googleSearch": { "enabled": true }
  }
}
```

Workspace-backed tools are different: `filesystem` and `tasks` live under `workspace`, not the top-level `tools` map:

```json
{
  "workspace": {
    "enabled": true,
    "needsApproval": true,
    "memory": { "enabled": true, "namespace": "support" },
    "tasks": { "enabled": true }
  }
}
```

Set `workspace.needsApproval` when every enabled workspace tool should use the AI SDK tool execution approval flow before its `execute` function runs.

`run_subagent` is also special: it lives under `config.subagent`, not the top-level `tools` map. Keep its model-facing schema in `functions/harness-processing/tools/run-subagent.tool.ts`, and keep dispatch, child runs, result injection, and parent continuation in `functions/harness-processing/subagents.ts`.

If a tool needs account-level options, validate those options in `accounts.ts`, read them from `context.config` in the tool factory, and keep runtime secrets in SST secrets unless they are truly account-specific encrypted config.

## Add a Channel

1. Implement `ChannelAdapter` in `functions/_shared/<channel>-channel.ts`.
2. Add the channel's account config shape and validation to [`functions/_shared/accounts.ts`](../functions/_shared/accounts.ts).
3. Wire account-scoped adapter creation into [`functions/harness-processing/integrations.ts`](../functions/harness-processing/integrations.ts).
4. Document the provider webhook URL as `/webhooks/{accountId}/{agentId}/{channel}`.
5. Keep reply formatting and send logic inside that channel module.

Reply sending should stay inside the channel's `ChannelActions`; do not hardcode channel-specific logic into shared handlers or the core agent loop.

## Add a Command

1. Add a new entry to the `commands` array in [`functions/_shared/commands.ts`](../functions/_shared/commands.ts).
2. Include aliases, description, and an execute function.
3. Use the channel-agnostic `ChannelActions` interface from shared code.

Commands should not import channel-specific modules.

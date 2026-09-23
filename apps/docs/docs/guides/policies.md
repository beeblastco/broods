# Policies

A policy is a list of allow and deny rules for what an agent may do: which tools it calls, which files it reads or writes, which subagents and skills it uses. Attach policies to an agent or to a [channel record](../channels/channel-records.md). Unlike [hooks](hooks.md), an enforced policy fails closed: if the check fails, the action is refused.

```ts title="broods/index.ts"
import { defineAgent, definePolicy } from "broods";

export const workspaceGuard = definePolicy({
  name: "workspace-guard",
  mode: "enforce",
  rules: [
    { id: "allow-read", effect: "allow", actions: ["workspace.read"] },
    {
      id: "deny-secrets",
      effect: "deny",
      actions: ["workspace.read", "workspace.write"],
      resources: { filePaths: ["secrets/"] },
    },
    {
      id: "deny-rm-rf",
      effect: "deny",
      actions: ["workspace.exec"],
      resources: { toolNames: ["bash"] },
      conditions: [
        {
          attribute: "tool.input.command",
          operator: "contains",
          value: "rm -rf",
        },
      ],
    },
    {
      id: "allow-bash",
      effect: "allow",
      actions: ["workspace.exec"],
      resources: { toolNames: ["bash"] },
    },
  ],
});

export const agent = defineAgent({
  name: "agent",
  policies: [workspaceGuard],
});
```

## How rules are evaluated

- A `deny` rule beats an `allow` rule.
- In `enforce` mode, an action with no matching `allow` rule is denied. Allow what you want explicitly.
- Each policy carries its own `mode`:
  - `audit`, the default, records every decision and blocks nothing. Use it to roll out a rule and watch what it would do.
  - `enforce` blocks denied actions, and blocks when the policy engine cannot be reached.
- Several policies on one agent can mix modes, so a new rule can watch while an established one enforces.
- Attaching no policies means no checks at all.

## Actions

| Action            | Covers                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `tool.call`       | Any tool call, including MCP and provider tools                                        |
| `workspace.read`  | `read`, `glob`, `grep`                                                                 |
| `workspace.write` | `write`, `edit`                                                                        |
| `workspace.exec`  | `bash`                                                                                 |
| `subagent.run`    | Starting a subagent                                                                    |
| `skill.load`      | Loading a skill                                                                        |
| `agent.invoke`    | Starting a turn from a channel. See [channel records](../channels/channel-records.md). |

## Selecting resources

`resources` narrows a rule with any of: `toolNames`, `mcpIds`, `filePaths`, `workspaceIds`, `workspaceNames`, `skillPaths`, `subagentIds`.

- `toolNames` are the names the model sees: `bash`, `read`, `googleSearch`, or `<server>__<tool>` for MCP tools.
- `filePaths` are workspace-relative prefixes: `secrets/`, not `/workspace/secrets`.
- `bash` has no file path. Scope shell commands with `toolNames` and conditions.
- A deny on `filePaths: ["secrets/"]` also refuses a `grep` or `glob` rooted above it, including the workspace root, since that search would read the denied files. Search a subdirectory instead. An allow rule does not get that reach.

## Conditions

`conditions` match attributes of the request with an `operator` and `value`. Useful attributes:

| Attribute                          | Value                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| `toolName`, `mcpId`                | The tool and MCP server being called                                |
| `tool.input.<field>`               | A field of the tool input, such as `tool.input.command`             |
| `tool.inputKeys`                   | Sorted list of input field names                                    |
| `filePath`                         | The resolved workspace path                                         |
| `project`, `stage`, `agentId`      | Where the run is                                                    |
| `channel`, `channelId`, `threadId` | Which chat it came from                                             |
| `userId`, `userName`, `userRoles`  | Who sent it. `userRoles` comes from `tagRoles` on a channel record. |
| `sandboxPermissionMode`            | The sandbox's `permissionMode`                                      |

The full schema, including every operator, is `PolicyDocument` in the [API reference](/api-reference).

## Changing and deleting policies

- A policy reference that does not resolve, such as a typo or a deleted policy, makes the agent refuse every action until you fix it. `broods deploy` warns when an agent names a policy the deploy does not declare.
- Deleting a policy is refused while a saved agent config or channel record lists it. `broods deploy --prune` fails for the same reason and names what still uses it.

Runnable example: [`policy-enforcement-lambda` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/policy-enforcement-lambda).

Policies decide what an agent does. To limit what a person or tool can do to your account through the API, use [roles](security.md#roles).

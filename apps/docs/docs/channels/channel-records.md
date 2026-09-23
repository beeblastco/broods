---
title: Channel records
---

# Channel records

A channel record binds one real place, such as a Slack channel, a Discord channel or a repository, to the agents that answer there. It also carries rules for that place, such as extra instructions, workspaces, policies and denied tools.

Every `define*Channel` you declare becomes a record on deploy. Use one when you need any of these:

- one Slack install driving a different agent in each channel
- a room-specific instruction, such as "escalate billing to #finance"
- a tool withheld in one room, or a policy that applies only there
- several agents answering in one room

Without a record, the agent that holds the connection answers everywhere the connection listens.

## Example

```ts title="broods/index.ts"
import {
  defineAgent,
  defineSlackChannel,
  defineSlackConnection,
  env,
} from "broods";

export const slackApp = defineSlackConnection({
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});

export const nhi = defineAgent({ name: "nhi", connections: [slackApp] });
export const scribe = defineAgent({ name: "scribe" });

export const productEng = defineSlackChannel({
  name: "product-eng",
  connection: slackApp,
  channelId: "C042PRODENG",
  teamId: "T09BEEBLAST",
  agents: [nhi, { agent: scribe, reply: false }],
  instructions: "Escalate billing questions to #finance.",
  replyIn: "thread",
});
```

Every agent in `agents` runs when a message arrives. `reply: false` runs one with a silenced channel, so it can work without speaking. Omit `agents` and the connection's own agent answers.

`platform` comes from the connection, and the connection's credentials never copy onto the record.

## Fields

A record narrows and adds. It never grants something the agent lacks, so an agent's own config is still its ceiling. Provider, model and credentials always come from the agent.

| Field           | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `agents`        | agents that run here. `{ agent, reply: false }` runs one silently             |
| `instructions`  | appended after each agent's own system prompt                                 |
| `workspaces`    | picks from the workspaces the agent already attaches. Others are dropped      |
| `policies`      | added to the agent's policies. Each policy keeps its own `mode`               |
| `denyTools`     | withholds tools here, including `bash`, `read` and channel tools              |
| `partition`     | workspace folder split, `{ by: "shared" }` or `{ by: "conversation", alias }` |
| `replyIn`       | Slack only. `thread` or `source`                                              |
| `sandboxImages` | images the agent may stand a sandbox up from for a thread here                |
| `tagRoles`      | named groups of people, readable from policies as `userRoles`                 |

The room id field is named after the provider:

| Provider | Field            | Extra field |
| -------- | ---------------- | ----------- |
| Slack    | `channelId`      | `teamId`    |
| Discord  | `channelId`      | `guildId`   |
| Matrix   | `channelId`      |             |
| GitHub   | `repo`           |             |
| Telegram | `chatId`         |             |
| Zalo     | `chatId`         |             |
| Pancake  | `conversationId` |             |

Notes on the fields:

- `workspaces` selects by workspace id among the ones the agent attaches, with the agent's own mount name and sandbox. A record that names only workspaces the agent lacks runs with no workspace, not with the agent's full list.
- `denyTools` applies to the finished tool set. Naming a tool the agent does not have is ignored. A subagent inherits the parent's denied tools.
- `replyIn: "thread"` threads the reply on the message that tagged the agent. `"source"` answers where the message came from, and threads only when that message was already in a thread. Unset, Slack threads in channels and answers in place in DMs. Other providers always reply where the message came from.

See [Workspaces](../guides/workspaces.md) for `partition` and [Policies](../guides/policies.md) for policy documents.

## Several chats, one set of rules

Zalo's `chatId` also accepts a list:

```ts
export const internalGroups = defineZaloChannel({
  name: "lamy-internal",
  connection: zaloConnection,
  chatId: ["7788", "7789", "7790"],
  instructions: internalPrompt,
  policies: [internalAccess],
  denyTools: ["web_search"],
});
```

That deploys three records, `lamy-internal-7788`, `lamy-internal-7789` and `lamy-internal-7790`. The suffix is the id, so removing one leaves the others' names unchanged. The ids must be known at deploy time.

`"*"` is refused as an id. A record matches one exact room, so a wildcard would open the connection everywhere with none of the rules. To answer everywhere, set `allowedChannelIds: ["*"]` on the connection. Rooms without a record fall back to the connection's own agent.

## Through the account API

The API uses the stored names. It says `externalId` for the room id and `agentBindings` for `agents`. Everything else is spelled the same.

```ts
import { BroodsAccountClient } from "broods/account";

const client = new BroodsAccountClient();

await client.createChannel({
  platform: "slack",
  externalId: "C042PRODENG",
  workspaceRef: "T09BEEBLAST",
  name: "#product-eng",
  config: {
    agentBindings: [{ agentId: "agent_nhi", isDefault: true }],
    instructions: "Escalate billing questions to #finance.",
    // agent_nhi must already attach ws_incidents.
    workspaces: [{ name: "incidents", workspaceId: "ws_incidents" }],
    partition: { alias: "eng", by: "conversation" },
    replyIn: "thread",
    policies: ["policy_prod_data"],
    tagRoles: [{ roleId: "oncall", userIds: ["U777", "U778"] }],
  },
});
```

Only one active record may exist per platform and room. Creating a second is rejected.

## Routing

The webhook URL names no agent. The account's agent whose connection credentials verify the request parses it and sends the reply, because the reply must come from the app that received it. The record for that room then decides which agents run.

If two agents hold the same provider app, the lower agent id receives the request. Do not rely on that order. Declare a record instead.

If the record lookup fails, as opposed to finding nothing, the turn is refused. Running without the room's policies and `denyTools` would grant more than intended.

## Access control

Three separate gates decide what happens in a room.

1. Where the agent listens. Declared channels plus the connection's `allowedChannelIds`. Undeclared rooms are dropped silently, before any policy runs. Policies can narrow this, never widen it.
2. Who may tag the agent. A policy rule on the `agent.invoke` action runs before the turn starts. In `enforce` mode a denial is posted in the room as a sentence. In `audit` mode it is only logged and the turn runs, which is how you roll a rule out.
3. What the agent may reach. Policies see `channelId`, `threadId`, `userId`, `userName`, and `userRoles` from `tagRoles`.

This rule allows `query_prod_db` only for the on-call group:

```json
{
  "version": 1,
  "mode": "enforce",
  "rules": [
    {
      "id": "prod-data-oncall-only",
      "effect": "deny",
      "actions": ["tool.call"],
      "resources": { "toolNames": ["query_prod_db"] },
      "conditions": [
        { "attribute": "userRoles", "operator": "notIn", "value": ["oncall"] }
      ]
    }
  ]
}
```

The `agent.invoke` check costs a policy engine call per message. Use declared channels, not policies, to keep an agent out of rooms that are not its own. The full policy contract is `PolicyDocument` in the [API Reference](/api-reference).

/**
 * Example: bind two Slack channels to two different agents under one Slack app.
 *
 * Needs BROODS_ACCOUNT_SECRET (and BROODS_BASE_URL when self-hosted), plus two
 * agent ids in the same account. Point the Slack app's Event Subscriptions URL
 * at the account-scoped webhook so the records choose who answers:
 *
 *   {BROODS_BASE_URL}/webhooks/{accountId}/slack
 */

import { BroodsAccountClient, type AccountChannel } from "broods/account";

const ENG_CHANNEL_ID = process.env.SLACK_ENG_CHANNEL_ID ?? "C042PRODENG";
const SALES_CHANNEL_ID = process.env.SLACK_SALES_CHANNEL_ID ?? "C042SALES";
const SLACK_TEAM_ID = process.env.SLACK_TEAM_ID ?? "T09BEEBLAST";
const ENG_AGENT_ID = process.env.ENG_AGENT_ID;
const SALES_AGENT_ID = process.env.SALES_AGENT_ID;

if (!ENG_AGENT_ID || !SALES_AGENT_ID) {
  throw new Error(
    "Set ENG_AGENT_ID and SALES_AGENT_ID to agents in this account",
  );
}

const client = new BroodsAccountClient();

async function upsertChannel(input: {
  externalId: string;
  name: string;
  agentId: string;
  instructions: string;
  extra?: Record<string, unknown>;
}): Promise<AccountChannel> {
  const existing = (await client.listChannels()).find(
    (channel) =>
      channel.platform === "slack" && channel.externalId === input.externalId,
  );
  const config = {
    agentBindings: [{ agentId: input.agentId, isDefault: true }],
    instructions: input.instructions,
    // Each thread gets its own private folder under the channel workspace, so
    // two incidents in one channel never read each other's scratch files.
    workspaceScope: { alias: "thread", level: "conversation" } as const,
    threadPolicy: "always-thread" as const,
    ...input.extra,
  };

  if (existing) {
    const updated = await client.updateChannel(existing.channelId, {
      config: config,
    });
    if (!updated) throw new Error(`Channel vanished: ${existing.channelId}`);

    return updated;
  }

  return await client.createChannel({
    platform: "slack",
    externalId: input.externalId,
    workspaceRef: SLACK_TEAM_ID,
    name: input.name,
    config: config,
  });
}

const eng = await upsertChannel({
  externalId: ENG_CHANNEL_ID,
  name: "#product-eng",
  agentId: ENG_AGENT_ID,
  instructions:
    "You are the engineering on-call assistant. Prefer logs and diffs over guesses.",
  extra: {
    // Roles are readable from policy conditions as `actorRoles`.
    tagRoles: [
      {
        roleId: "oncall",
        actorIds: (process.env.ONCALL_SLACK_IDS ?? "")
          .split(",")
          .filter(Boolean),
      },
    ],
  },
});

const sales = await upsertChannel({
  externalId: SALES_CHANNEL_ID,
  name: "#sales",
  agentId: SALES_AGENT_ID,
  instructions: "You are the sales desk assistant. Never quote a discount.",
  extra: {
    // Narrowing only: a channel can take a tool away, never hand one out.
    denyTools: ["bash"],
  },
});

console.log("Bound channels under one Slack app:\n");
for (const channel of [eng, sales]) {
  console.log(
    `  ${channel.name.padEnd(16)} ${channel.externalId.padEnd(14)} -> ${
      channel.config.agentBindings[0]?.agentId
    }`,
  );
}

console.log(
  "\nPoint the Slack app at /webhooks/{accountId}/slack — the record picks the agent.",
);

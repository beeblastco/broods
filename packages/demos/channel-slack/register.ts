import { api } from "./broods/_generated/api.ts";

const host = process.env.BROODS_HOST;
const channelRef = api.channels?.slack;
if (!host) throw new Error("BROODS_HOST is required (set it in .env.local)");
if (!channelRef) throw new Error("No Slack channel found in broods/_generated/api.ts — run `bun run dev` first");

const webhookUrl = `${host.replace(/\/+$/, "")}${channelRef.webhookPath}`;

const appToken = process.env.SLACK_APP_TOKEN;
const appId = process.env.SLACK_APP_ID;

if (appToken && appId) {
  const manifest: Record<string, unknown> = {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: { name: "Broods Agent" },
    features: {
      bot_user: { display_name: "Broods Agent", always_online: true },
      slash_commands: [
        { command: "/new", description: "Clear conversation context and start fresh", url: webhookUrl, should_escape: false },
        { command: "/clear", description: "Clear conversation context and start fresh", url: webhookUrl, should_escape: false },
        { command: "/help", description: "Show available commands", url: webhookUrl, should_escape: false },
      ],
    },
    event_subscriptions: {
      request_url: webhookUrl,
      bot_events: [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "groups:history",
          "im:history",
          "mpim:history",
          "reactions:read",
          "reactions:write",
        ],
      },
    },
    settings: {
      event_subscriptions: { request_url: webhookUrl, bot_events: ["app_mention"] },
      interactivity: { is_enabled: true, request_url: webhookUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };

  const updateRes = await fetch("https://slack.com/api/apps.manifest.update", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, manifest }),
  });
  const updateData = await updateRes.json() as { ok: boolean; error?: string };
  if (!updateData.ok) {
    throw new Error(`Slack manifest update failed: ${updateData.error}`);
  }
  console.log(`Registered Slack webhook: ${webhookUrl}`);
} else {
  console.log(`\nBroods Slack webhook URL:\n\n  ${webhookUrl}\n`);
  console.log("Configure this URL in your Slack app at https://api.slack.com/apps:");
  console.log("  1. Event Subscriptions → enable → paste URL as Request URL");
  console.log("  2. Subscribe to bot events: app_mention, message.channels, message.im");
  console.log("  3. Add Slash Commands (/new, /clear, /help) pointing to the same URL");
  console.log("\nTo auto-register, add SLACK_APP_TOKEN (xapp-) and SLACK_APP_ID to .env.local");
}

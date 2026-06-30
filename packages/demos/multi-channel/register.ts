import { api } from "./broods/_generated/api.ts";

const host = process.env.BROODS_HOST;
if (!host) throw new Error("BROODS_HOST is required (set it in .env.local)");
const baseUrl = host.replace(/\/+$/, "");

// ── Slack ──────────────────────────────────────────────────────────
const slackRef = api.channels?.slack;

if (slackRef) {
  const webhookUrl = `${baseUrl}${slackRef.webhookPath}`;
  const configToken = process.env.SLACK_CONFIG_TOKEN ?? process.env.SLACK_APP_CONFIG_TOKEN;
  const appId = process.env.SLACK_APP_ID;

  const botEvents = [
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
  ];

  if (configToken && appId) {
    const manifest: Record<string, unknown> = {
      _metadata: { major_version: 1, minor_version: 1 },
      display_information: { name: "Tracy" },
      features: {
        bot_user: { display_name: "Tracy", always_online: true },
        slash_commands: [
          { command: "/new", description: "Clear conversation context and start fresh", url: webhookUrl, should_escape: false },
          { command: "/clear", description: "Clear conversation context and start fresh", url: webhookUrl, should_escape: false },
          { command: "/help", description: "Show available commands", url: webhookUrl, should_escape: false },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "chat:write",
            "commands",
            "groups:history",
            "im:history",
            "mpim:history",
            "reactions:read",
            "reactions:write",
          ],
        },
      },
      settings: {
        event_subscriptions: { request_url: webhookUrl, bot_events: botEvents },
        interactivity: { is_enabled: true, request_url: webhookUrl },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    };

    const updateRes = await fetch("https://slack.com/api/apps.manifest.update", {
      method: "POST",
      headers: { Authorization: `Bearer ${configToken}`, "Content-Type": "application/json" },
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
    console.log(`  2. Subscribe to bot events: ${botEvents.join(", ")}`);
    console.log("  3. Add Slash Commands (/new, /clear, /help) pointing to the same URL");
    console.log("\nTo auto-register, add SLACK_CONFIG_TOKEN (app configuration token) and SLACK_APP_ID to .env.local");
    if (process.env.SLACK_APP_TOKEN?.startsWith("xapp-")) {
      console.log("Note: SLACK_APP_TOKEN is an xapp token; Slack does not accept it for apps.manifest.update.");
    }
  }
} else {
  console.log("No Slack channel defined — skipping Slack registration.");
}

// ── Telegram ───────────────────────────────────────────────────────
const telegramRef = api.channels?.telegram;

if (telegramRef) {
  const telegramUrl = `${baseUrl}${telegramRef.webhookPath}`;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (botToken && webhookSecret) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      body: new URLSearchParams({
        url: telegramUrl,
        secret_token: webhookSecret,
        allowed_updates: JSON.stringify(["message", "edited_message"]),
      }),
    });
    if (!response.ok) {
      throw new Error(`Telegram setWebhook failed: ${response.status} ${await response.text()}`);
    }
    console.log(`Registered Telegram webhook: ${telegramUrl}`);
  } else {
    console.log(`\nBroods Telegram webhook URL:\n\n  ${telegramUrl}\n`);
    console.log("To auto-register, add TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to .env.local");
  }
} else {
  console.log("No Telegram channel defined — skipping Telegram registration.");
}

// ── GitHub ─────────────────────────────────────────────────────────
const githubRef = api.channels?.github;

if (githubRef) {
  const githubUrl = `${baseUrl}${githubRef.webhookPath}`;
  console.log(`\nBroods GitHub webhook URL:\n\n  ${githubUrl}\n`);
  console.log("Configure this URL in your GitHub App webhook settings.");
} else {
  console.log("No GitHub channel defined — skipping GitHub registration.");
}

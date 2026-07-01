import { api } from "./broods/_generated/api.ts";
import Bun from "bun";
import { createSign } from "node:crypto";

const host = process.env.BROODS_HOST;
if (!host) throw new Error("BROODS_HOST is required (set it in .env.local)");
const baseUrl = host.replace(/\/+$/, "");

// ── Helpers ───────────────────────────────────────────────────────
/**
 * Rotate a Slack app configuration token using its long-lived xoxe- refresh
 * token. Returns the new access + refresh tokens. The new refresh token
 * supersedes the previous one.
 *
 * https://docs.slack.dev/reference/methods/tooling.tokens.rotate/
 */
async function rotateSlackConfigToken(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
  const res = await fetch("https://slack.com/api/tooling.tokens.rotate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: cleanEnvToken(refreshToken) }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    token?: string;
    refresh_token?: string;
    error?: string;
    response_metadata?: { messages?: string[] };
  };
  if (!data.ok || !data.token || !data.refresh_token) {
    const details = data.response_metadata?.messages?.join("; ");
    throw new Error(`Slack token rotation failed: ${data.error ?? "missing tokens in response"}${details ? ` (${details})` : ""}`);
  }
  return { token: data.token, refreshToken: data.refresh_token };
}

function cleanEnvToken(token: string): string {
  return token.trim().replace(/^['"]|['"]$/g, "");
}

/**
 * Persist rotated Slack tokens back to .env.local so subsequent runs use
 * them. Only touches the two lines; leaves everything else untouched and
 * preserves quoting/formatting on the lines it rewrites.
 */
async function persistRotatedSlackTokens(newToken: string, newRefreshToken: string): Promise<void> {
  const envPath = `${import.meta.dir}/.env.local`;
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    console.warn(`Could not persist rotated tokens: ${envPath} not found`);
    return;
  }
  const original = await file.text();
  let updated = upsertEnvValue(original, "SLACK_CONFIG_TOKEN", newToken);
  updated = upsertEnvValue(updated, "SLACK_CONFIG_REFRESH_TOKEN", newRefreshToken);
  if (updated === original) {
    console.warn(`Could not persist rotated tokens to ${envPath}`);
    return;
  }
  await Bun.write(envPath, updated);
  console.log("Persisted rotated Slack tokens to .env.local");
}

function upsertEnvValue(source: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  return `${source.trimEnd()}\n${line}\n`;
}

async function updateGitHubAppWebhook(options: {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  webhookUrl: string;
  apiUrl?: string;
}): Promise<void> {
  const baseApiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const response = await fetch(`${baseApiUrl}/app/hook/config`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${createGitHubAppJwt(options.appId, options.privateKey)}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      url: options.webhookUrl,
      content_type: "json",
      secret: options.webhookSecret,
      insecure_ssl: "0",
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub app webhook update failed: ${response.status} ${await response.text()}`);
  }
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: cleanEnvToken(appId),
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(normalizeGitHubPrivateKey(privateKey));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

function normalizeGitHubPrivateKey(value: string): string {
  const cleaned = cleanEnvToken(value).replace(/\\n/g, "\n");
  if (cleaned.includes("-----BEGIN")) return cleaned;
  return Buffer.from(cleaned, "base64").toString("utf8");
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ── Slack ──────────────────────────────────────────────────────────
const slackRef = api.channels?.slack;

if (slackRef) {
  const webhookUrl = `${baseUrl}${slackRef.webhookPath}`;
  const configToken = process.env.SLACK_CONFIG_TOKEN ?? process.env.SLACK_APP_CONFIG_TOKEN;
  const configRefreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  const appId = process.env.SLACK_APP_ID;

  const botEvents = [
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
  ];

  if ((configToken || configRefreshToken) && appId) {
    // Rotate the app configuration token first so we never hit a token_expired window.
    // This is separate from OAuth bot token rotation in the Slack app settings.
    let activeToken = configToken ?? "";
    if (configRefreshToken) {
      try {
        const rotated = await rotateSlackConfigToken(configRefreshToken);
        activeToken = rotated.token;
        await persistRotatedSlackTokens(rotated.token, rotated.refreshToken);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`\nSlack token rotation failed: ${msg}\n`);
        console.error("tooling.tokens.rotate requires the xoxe-* app configuration refresh token.");
        console.error("\nGenerate a fresh configuration token pair at https://api.slack.com/apps -> your app ->");
        console.error("  Features -> App Manifest -> Generate Token.");
        console.error("Then put the returned access token in SLACK_CONFIG_TOKEN and refresh token in");
        console.error("SLACK_CONFIG_REFRESH_TOKEN.\n");
        throw err;
      }
    } else if (configToken) {
      console.warn("SLACK_CONFIG_REFRESH_TOKEN is not set — cannot rotate. Add it to .env.local to avoid token_expired errors.");
    }

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
      },
    };

    const updateRes = await fetch("https://slack.com/api/apps.manifest.update", {
      method: "POST",
      headers: { Authorization: `Bearer ${activeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, manifest: JSON.stringify(manifest) }),
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
    console.log("\nTo auto-register, add SLACK_CONFIG_TOKEN, SLACK_CONFIG_REFRESH_TOKEN, and SLACK_APP_ID to .env.local");
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
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const apiUrl = process.env.GITHUB_API_URL;

  if (appId && privateKey && webhookSecret) {
    await updateGitHubAppWebhook({
      appId,
      privateKey,
      webhookSecret,
      webhookUrl: githubUrl,
      apiUrl,
    });
    console.log(`Registered GitHub App webhook: ${githubUrl}`);
    console.log("GitHub App events must include: issues, issue_comment, pull_request, pull_request_review_comment");
  } else {
    console.log(`\nBroods GitHub webhook URL:\n\n  ${githubUrl}\n`);
    console.log("To auto-register, add GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET to .env.local");
    console.log("GitHub App events must include: issues, issue_comment, pull_request, pull_request_review_comment");
  }
} else {
  console.log("No GitHub channel defined — skipping GitHub registration.");
}

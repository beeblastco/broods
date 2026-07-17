const botToken = process.env.ZALO_BOT_TOKEN;
const webhookSecret = process.env.ZALO_WEBHOOK_SECRET;
const url = process.env.CHANNEL_WEBHOOK_URL;
if (!botToken || !webhookSecret || !url)
  throw new Error(
    "ZALO_BOT_TOKEN, ZALO_WEBHOOK_SECRET, and CHANNEL_WEBHOOK_URL are required",
  );
const response = await fetch(
  `https://bot-api.zaloplatforms.com/bot${botToken}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: webhookSecret }),
  },
);
const body = await response.text();
if (!response.ok)
  throw new Error(`Zalo setWebhook failed: ${response.status} ${body}`);
console.log(`Registered Zalo webhook: ${url}`);

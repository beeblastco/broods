const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.CHANNEL_WEBHOOK_URL;
if (!botToken || !webhookSecret || !url) throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and CHANNEL_WEBHOOK_URL are required");
const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  body: new URLSearchParams({ url, secret_token: webhookSecret, allowed_updates: JSON.stringify(["message", "edited_message"]) }),
});
if (!response.ok) throw new Error(`Telegram setWebhook failed: ${response.status} ${await response.text()}`);
console.log(`Registered Telegram webhook: ${url}`);

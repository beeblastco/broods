import { assertStep, type VerifyContext } from "../harness.ts";

/** Signed malformed Telegram webhooks are acknowledged without starting a run. */
export async function channelWebhook(context: VerifyContext): Promise<void> {
  const secret = `webhook-${context.runId}`;
  const account = await context.account.getAccount();
  await context.account.createAgent({
    name: `webhook-${context.runId}`,
    config: {
      ...context.model,
      instructions: "Reply with OK.",
      channels: {
        telegram: {
          id: "local-telegram",
          botToken: "local-test-token",
          webhookSecret: secret,
        },
      },
    },
  });
  const url = context.account.webhookUrl(account.accountId, "telegram");
  for (const body of [
    "{",
    "null",
    '{"update_id":1,"message":{"chat":null}}',
    '{"update_id":2}',
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: body,
    });
    assertStep(
      "Telegram webhook safely acknowledges unusable input",
      response.status === 200,
      `${response.status}: ${await response.text()}`,
    );
  }
}

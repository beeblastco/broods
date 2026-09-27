import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, lastJsonLine, type VerifyContext } from "../harness.ts";

interface WebhookLog {
  agentId: string;
  kind: string;
  message: string;
}

/** A real local stage acknowledges malformed Telegram deliveries without admission. */
export async function channelWebhook(context: VerifyContext): Promise<void> {
  const secret = `webhook-${context.runId}`;
  const accountSecret = await context.prepareProjectAccount();
  const sync = new BroodsSyncClient({
    baseUrl: context.gatewayUrl,
    token: accountSecret,
  });
  const result = await sync.putManifest(
    {
      version: 1,
      project: `webhook-${context.runId}`,
      stage: "development",
      resources: [
        {
          kind: "agent",
          name: "webhook",
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
        },
      ],
    },
    false,
  );
  assertStep(
    "webhook stage deployed locally",
    Boolean(result.deployment),
    "No stage deployment returned",
  );
  const url = context.client.stageWebhookUrl(
    result.deployment!.accountId,
    result.deployment!.endpointId,
    "telegram",
  );
  const agentId = result.ids.agents.webhook;
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
    const parsed = lastJsonLine<WebhookLog>(
      context.coreLogPath,
      (record): boolean =>
        record.agentId === agentId &&
        record.message === "Channel webhook parsed",
    );
    assertStep(
      "webhook is ignored before run admission",
      parsed?.kind === "ignore",
      JSON.stringify(parsed),
    );
  }
}

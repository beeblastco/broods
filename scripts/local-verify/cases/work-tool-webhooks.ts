import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { BroodsAccountApiError } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

export async function workToolWebhooks(context: VerifyContext): Promise<void> {
  const linear = {
    id: "linear",
    apiKey: `lin_api_${context.runId}`,
    webhookSecret: `lin-${context.runId}`,
    userName: "verify-agent",
    allowedChannelIds: ["*"],
  };
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: `work-tools-${context.runId}`,
        config: { ...context.model, channels: { linear: linear } },
      }),
  );
  const stored = await context.account.getAgent(agentId);
  assertStep(
    "Linear secrets come back redacted",
    stored?.config.channels?.linear?.apiKey === "********" &&
      stored.config.channels.linear.webhookSecret === "********" &&
      stored.config.channels.linear.userName === "verify-agent",
    JSON.stringify(stored?.config.channels ?? null),
  );

  const refused = await context.account
    .createAgent({
      name: `work-tools-nameless-${context.runId}`,
      config: {
        ...context.model,
        channels: { linear: { ...linear, userName: undefined } },
      },
    })
    .then(
      (): string => "created",
      (err: unknown): string =>
        err instanceof BroodsAccountApiError ? err.body : String(err),
    );
  assertStep(
    "a Linear key without userName is refused",
    refused.includes("config.channels.linear.userName is required"),
    refused,
  );

  // The scan skips an agent with no deployment, so core's channel tests cover the signatures.
  const account = await context.account.getAccount();
  const response = await context.measure(
    "linear webhook",
    (): Promise<Response> =>
      fetch(context.client.accountWebhookUrl(account.accountId, "linear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      }),
  );
  const body = await response.text();
  assertStep(
    "a linear delivery reaches the channel scan, which finds no deployed agent",
    response.status === 503 && body.includes("linear"),
    `${response.status} ${body.slice(0, 200)}`,
  );
}

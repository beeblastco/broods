import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { BroodsAccountApiError } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The config plane stores a Linear and a Notion connection, answers them back
 * with every secret redacted, and refuses a Linear key with no `userName`,
 * since that name is what mentions the agent. The webhook
 * URL for each reaches core's channel scan through the gateway. An agent with
 * no deployment is no candidate there, so the signature checks themselves are
 * covered by core's channel tests.
 */
export async function workToolWebhooks(context: VerifyContext): Promise<void> {
  const channels = {
    linear: {
      id: "linear",
      apiKey: `lin_api_${context.runId}`,
      webhookSecret: `lin-${context.runId}`,
      userName: "verify-agent",
      allowedChannelIds: ["*"],
    },
    notion: {
      id: "notion",
      token: `ntn_${context.runId}`,
      allowedChannelIds: ["*"],
    },
  };
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: `work-tools-${context.runId}`,
        config: { ...context.model, channels: channels },
      }),
  );
  const stored = await context.account.getAgent(agentId);
  assertStep(
    "Linear and Notion secrets come back redacted",
    stored?.config.channels?.linear?.apiKey === "********" &&
      stored.config.channels.linear.webhookSecret === "********" &&
      stored.config.channels.notion?.token === "********" &&
      stored.config.channels.linear.userName === "verify-agent",
    JSON.stringify(stored?.config.channels ?? null),
  );

  const refused = await context.account
    .createAgent({
      name: `work-tools-nameless-${context.runId}`,
      config: {
        ...context.model,
        channels: { linear: { ...channels.linear, userName: undefined } },
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

  const account = await context.account.getAccount();
  for (const channel of ["linear", "notion"] as const) {
    const response = await context.measure(
      `${channel} webhook`,
      (): Promise<Response> =>
        fetch(context.client.accountWebhookUrl(account.accountId, channel), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        }),
    );
    const body = await response.text();
    assertStep(
      `a ${channel} delivery reaches the channel scan, which finds no deployed agent`,
      response.status === 503 && body.includes(channel),
      `${response.status} ${body.slice(0, 200)}`,
    );
  }
}

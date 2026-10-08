import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The config plane stores a Gmail connection and answers it back with the
 * OAuth secrets redacted. The webhook URL reaches core's channel scan through
 * the gateway. Google signs every push, so the token check, the inbox listing
 * and the watch call are covered by core's and Convex's own tests.
 */
export async function gmailChannel(context: VerifyContext): Promise<void> {
  const gmail = {
    id: "gmail",
    clientId: "client.apps.googleusercontent.com",
    clientSecret: `secret-${context.runId}`,
    refreshToken: `refresh-${context.runId}`,
    mailbox: "agent@example.com",
    serviceAccountEmail: "push@project.iam.gserviceaccount.com",
    subscription: "projects/p/subscriptions/gmail",
    topicName: "projects/p/topics/gmail",
    allowedChannelIds: ["*"],
    allowedUserIds: ["boss@example.com"],
  };
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: `gmail-${context.runId}`,
        config: { ...context.model, channels: { gmail: gmail } },
      }),
  );
  const stored = await context.account.getAgent(agentId);
  assertStep(
    "Gmail secrets come back redacted",
    stored?.config.channels?.gmail?.clientSecret === "********" &&
      stored.config.channels.gmail.refreshToken === "********" &&
      stored.config.channels.gmail.mailbox === "agent@example.com",
    JSON.stringify(stored?.config.channels ?? null),
  );

  const account = await context.account.getAccount();
  const response = await context.measure(
    "gmail webhook",
    (): Promise<Response> =>
      fetch(context.client.accountWebhookUrl(account.accountId, "gmail"), {
        method: "POST",
        headers: {
          authorization: "Bearer unsigned",
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      }),
  );
  const body = await response.text();
  assertStep(
    "a gmail push reaches the channel scan, which finds no deployed agent",
    response.status === 503 && body.includes("gmail"),
    `${response.status} ${body.slice(0, 200)}`,
  );
}

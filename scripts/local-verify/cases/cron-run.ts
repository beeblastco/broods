import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import {
  OK_AGENT,
  assertStep,
  convexResult,
  type VerifyContext,
} from "../harness.ts";

const SETTLE_TIMEOUT_MS = 60_000;

// A fired job's run row names its envelope, which the dead-run sweep and an approval's turn read.
export async function cronRun(context: VerifyContext): Promise<void> {
  const key = `cron-${context.runId}`;
  const { accountId } = await context.account.getAccount();
  const { agentId } = await context.measure(
    "create cron agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: { ...context.model, agent: OK_AGENT },
      }),
  );
  const cron = await context.account.createCron({
    name: key,
    agentId: agentId,
    events: [{ role: "user", content: "Say OK." }],
    scheduleExpression: "rate(1 day)",
  });
  await context.measure("fire cron run", async (): Promise<void> => {
    convexResult(
      context,
      "agent/crons:dispatch",
      { accountId: accountId, cronId: cron.cronId },
      "the cron dispatch reaches core",
    );
  });

  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let status: string | undefined;
  while (Date.now() < deadline) {
    status = (await context.account.getCron(cron.cronId))?.lastStatus;
    if (status === "completed" || status === "failed") break;
    await Bun.sleep(500);
  }
  const expected = context.hasModelKey ? "completed" : "failed";
  assertStep("the cron run settles", status === expected, String(status));

  const [run] = convexResult<
    {
      conversationKey: string;
      eventId: string;
      ingressConversationKey?: string;
      ingressEventId?: string;
    }[]
  >(
    context,
    "agent/crons:listRuns",
    { accountId: accountId, cronId: cron.cronId },
    "agent/crons:listRuns answers",
  );
  assertStep(
    "the run row names its envelope by scoped id, not the public one",
    Boolean(
      run?.ingressEventId &&
      run.ingressEventId !== run.eventId &&
      run.ingressConversationKey &&
      run.ingressConversationKey !== run.conversationKey,
    ),
    JSON.stringify(run),
  );
  await context.account.deleteCron(cron.cronId);
}

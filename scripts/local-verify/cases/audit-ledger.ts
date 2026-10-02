import { BroodsAccountApiError } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/** The audit ledger records config writes and run lifecycle, verifies, and refuses a non-public sink. */
export async function auditLedger(context: VerifyContext): Promise<void> {
  const name = `audit-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: name,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
    },
  });
  if (context.hasModelKey) {
    await context.measure("audit run", () =>
      context.client
        .agent(name, agentId)
        .run({ conversationKey: name, input: "Say OK." }),
    );
  }

  const page = await context.measure("audit list", () =>
    context.account.audit.list({ limit: 500 }),
  );
  const actions = page.events.map(
    (event) => `${event.resource.kind}:${event.action}`,
  );
  assertStep(
    "audit ledger holds the agent create",
    actions.includes("agent:created"),
    JSON.stringify(actions),
  );
  if (context.hasModelKey) {
    assertStep(
      "audit ledger holds the run lifecycle",
      actions.includes("run:run.started") &&
        actions.includes("run:run.completed"),
      JSON.stringify(actions),
    );
  }
  const last = page.events[page.events.length - 1];
  assertStep(
    "audit head is the last row",
    page.head?.seq === last?.seq && page.head?.hash === last?.hash,
    JSON.stringify({ head: page.head, last: last?.seq }),
  );

  const verified = await context.measure("audit verify", () =>
    context.account.audit.verify(),
  );
  assertStep("audit chain verifies", verified.ok, JSON.stringify(verified));

  const refused = await context.account.audit
    .setSink({ url: "http://127.0.0.1:1/audit", secret: "s" })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assertStep(
    "audit sink refuses a non-public url",
    refused instanceof BroodsAccountApiError && refused.status === 400,
    String(refused),
  );
}

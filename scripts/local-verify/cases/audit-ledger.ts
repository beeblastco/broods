import {
  BroodsAccountApiError,
  type AuditEvent,
  type AuditPage,
} from "../../../packages/broods/src/account.ts";
import {
  assertStep,
  pollUntil,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * The audit ledger records a config write and a finished run, verifies, and
 * refuses a non-public sink. A run that fails at the provider call (no model
 * key) still finishes through the usage write, so its row lands either way.
 */
export async function auditLedger(context: VerifyContext): Promise<void> {
  const name = `audit-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: name,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
    },
  });
  await context.measure("audit run", () =>
    runToTerminal(context, {
      agentId: agentId,
      conversationKey: name,
      eventId: name,
      text: "Say OK.",
    }),
  );

  // The usage write that appends the row lands just after the run's status.
  const page = await context.measure("audit list", () =>
    pollUntil(
      { initialIntervalMs: 50, maxIntervalMs: 400, timeoutMs: 5_000 },
      async (): Promise<AuditPage | null> => {
        const listed = await context.account.audit.list({ limit: 500 });

        return listed.events.some(finishedRunOf(agentId)) ? listed : null;
      },
    ),
  );
  const events = page?.events ?? [];
  const run = events.find(finishedRunOf(agentId));
  const details: { startedAt?: number; durationMs?: number } = JSON.parse(
    run?.detailsJson ?? "{}",
  );
  assertStep(
    "audit ledger holds the finished run with its start and duration",
    typeof details.startedAt === "number" &&
      typeof details.durationMs === "number",
    JSON.stringify(run ?? null),
  );
  assertStep(
    "the finished run records who asked",
    run?.actor.chain?.[0]?.kind === "api",
    JSON.stringify(run?.actor ?? null),
  );
  assertStep(
    "audit ledger holds the agent create",
    events.some(
      (event: AuditEvent): boolean =>
        event.resource.kind === "agent" && event.action === "created",
    ),
    JSON.stringify(events.map((event: AuditEvent): string => event.action)),
  );
  const last = events[events.length - 1];
  assertStep(
    "audit head is the last row",
    page?.head?.seq === last?.seq && page?.head?.hash === last?.hash,
    JSON.stringify({ head: page?.head, last: last?.seq }),
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

/** Matches the `run.completed` row one agent's run appended. */
function finishedRunOf(agentId: string): (event: AuditEvent) => boolean {
  return (event: AuditEvent): boolean =>
    event.action === "run.completed" && event.actor.agentId === agentId;
}

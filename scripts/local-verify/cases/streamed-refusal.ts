import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { BroodsApiError } from "../../../packages/broods/src/api-error.ts";
import { OK_AGENT, assertStep, type VerifyContext } from "../harness.ts";

export async function streamedRefusal(context: VerifyContext): Promise<void> {
  const key = `refusal-${context.runId}`;
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: { ...context.model, agent: OK_AGENT },
      }),
  );
  const run = (input: string): Promise<unknown> =>
    context.client
      .run({
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        input: input,
      })
      .then(
        (): null => null,
        (error: unknown): unknown => error,
      );

  await context.measure("streamed run", (): Promise<unknown> => run("Say OK."));
  const refused = await context.measure(
    "streamed run reusing its eventId with another input",
    (): Promise<unknown> => run("Say NO."),
  );
  assertStep(
    "a streamed run refused before it starts throws the same code as a background one",
    refused instanceof BroodsApiError &&
      refused.status === 409 &&
      refused.code === "idempotency_conflict" &&
      refused.type === "conflict_error",
    String(refused),
  );
}

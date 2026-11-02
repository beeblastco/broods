import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import {
  OK_AGENT,
  MODEL_KEY_HINT,
  assertStep,
  type VerifyContext,
} from "../harness.ts";

// More than core's default MAX_INPROCESS_WORKERS (8), so some streams queue.
const STREAMS = 12;

interface StreamOutcome {
  text: string;
  error: string | null;
}

export async function streamedBurst(context: VerifyContext): Promise<void> {
  const key = `burst-${context.runId}`;
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: {
          ...context.model,
          agent: OK_AGENT,
        },
      }),
  );

  const outcomes = await context.measure(
    `${STREAMS} streamed runs at once`,
    (): Promise<StreamOutcome[]> =>
      Promise.all(
        Array.from(
          { length: STREAMS },
          async (_, index): Promise<StreamOutcome> => {
            let text = "";
            try {
              for await (const part of context.client.stream({
                agentId: agentId,
                conversationKey: `${key}-${index}`,
                eventId: `${key}-${index}`,
                input: "Say OK.",
              })) {
                if (part.type === "text-delta") text += part.text;
              }
            } catch (err) {
              // The SDK throws on a failed run's error part, so the error is the outcome.
              return {
                text: text,
                error: err instanceof Error ? err.message : String(err),
              };
            }

            return { text: text, error: null };
          },
        ),
      ),
  );
  const answered = outcomes.filter(
    (outcome): boolean => outcome.error === null && outcome.text.length > 0,
  ).length;
  // The run's own SSE error proves the stream opened and got a slot; a 503 reads "Run failed:".
  const ranToError = outcomes.filter(
    (outcome): boolean =>
      outcome.error?.startsWith("Agent run failed:") === true,
  ).length;
  assertStep(
    context.hasModelKey
      ? `all ${STREAMS} streamed runs answered through the worker queue`
      : `all ${STREAMS} streamed runs got a slot and ran (${MODEL_KEY_HINT})`,
    context.hasModelKey
      ? answered === STREAMS
      : answered + ranToError === STREAMS,
    JSON.stringify(outcomes),
  );
}

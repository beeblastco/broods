import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { MODEL_KEY_HINT, assertStep, type VerifyContext } from "../harness.ts";

// More than core's default MAX_INPROCESS_WORKERS (8), so some streams queue.
const STREAMS = 12;

interface StreamOutcome {
  text: string;
  error: string | null;
}

/**
 * Streamed runs take a worker slot like every other run. A burst wider than
 * the pool queues the rest, and every queued stream must still open, wait and
 * end in its own outcome rather than hang or be dropped.
 */
export async function streamedBurst(context: VerifyContext): Promise<void> {
  const key = `burst-${context.runId}`;
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: {
          ...context.model,
          instructions: "Reply with the single word OK.",
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
  // Without a model each run fails at the provider call, and that failure
  // arrives as the run's own SSE error part, which proves the stream opened
  // and the run got its slot. An HTTP refusal such as a 503 is "Run failed:".
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

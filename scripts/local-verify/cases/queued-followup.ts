import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import type { AsyncAgentRun } from "../../../packages/broods/src/client.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { MODEL_KEY_HINT, assertStep, type VerifyContext } from "../harness.ts";

const FOLLOWUP_TIMEOUT_MS = 120_000;

/**
 * A streamed run owns the conversation while a follow-up queues behind it.
 * The streamed run settles as it hands off, so the follow-up must start on
 * its own and finish, and the streamed run must keep its own outcome.
 */
export async function queuedFollowup(context: VerifyContext): Promise<void> {
  const key = `followup-${context.runId}`;
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

  let queued: AsyncAgentRun | null = null;
  // The SDK throws on a failed run's error part, so the error is the outcome.
  const streamError = await context.measure(
    "streamed run",
    async (): Promise<string | null> => {
      try {
        for await (const _part of context.client.stream({
          agentId: agentId,
          conversationKey: key,
          eventId: `${key}-first`,
          input: "Say OK.",
        })) {
          // The first part means this run owns the conversation, so the next
          // message has to queue behind it.
          queued ??= await context.client.runAsync({
            agentId: agentId,
            conversationKey: key,
            eventId: `${key}-queued`,
            input: "Say OK again.",
            mode: "followup",
          });
        }
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      return null;
    },
  );
  assertStep(
    "follow-up admitted",
    queued !== null,
    streamError ?? "the stream ended before its first part",
  );
  // Without a model the streamed run can end before the follow-up lands, so
  // only a real model run proves the follow-up queued behind it.
  assertStep(
    context.hasModelKey
      ? "follow-up queued behind the streamed run"
      : `follow-up admitted as ${queued.status} (${MODEL_KEY_HINT})`,
    !context.hasModelKey || queued.status === "queued",
    JSON.stringify(queued),
  );
  assertStep(
    context.hasModelKey
      ? "streamed run completed"
      : `streamed run reached a terminal state (${MODEL_KEY_HINT})`,
    !context.hasModelKey || streamError === null,
    streamError ?? "",
  );

  const status = await context.measure(
    "queued follow-up",
    (): Promise<AsyncStatus> =>
      queued!.wait({ intervalMs: 500, timeoutMs: FOLLOWUP_TIMEOUT_MS }),
  );
  assertStep(
    context.hasModelKey
      ? `queued follow-up completed on ${context.model.model.modelId}`
      : `queued follow-up reached a terminal state (${MODEL_KEY_HINT})`,
    context.hasModelKey
      ? status.status === "completed"
      : status.status === "completed" || status.status === "failed",
    JSON.stringify(status),
  );
}

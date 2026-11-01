import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import type { AsyncAgentRun } from "../../../packages/broods/src/client.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  OK_AGENT,
  MODEL_KEY_HINT,
  assertStep,
  type VerifyContext,
} from "../harness.ts";

const FOLLOWUP_TIMEOUT_MS = 120_000;

export async function queuedFollowup(context: VerifyContext): Promise<void> {
  const key = `followup-${context.runId}`;
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

  const { queued, streamError } = await context.measure(
    "streamed run",
    async (): Promise<{
      queued: AsyncAgentRun | null;
      streamError: string | null;
    }> => {
      let admitted: AsyncAgentRun | null = null;
      try {
        for await (const _part of context.client.stream({
          agentId: agentId,
          conversationKey: key,
          eventId: `${key}-first`,
          input: "Say OK.",
        })) {
          admitted ??= await context.client.runAsync({
            agentId: agentId,
            conversationKey: key,
            eventId: `${key}-queued`,
            input: "Say OK again.",
            mode: "followup",
          });
        }
      } catch (err) {
        // The SDK throws on a failed run's error part, so the error is the outcome.
        return {
          queued: admitted,
          streamError: err instanceof Error ? err.message : String(err),
        };
      }

      return { queued: admitted, streamError: null };
    },
  );
  assertStep(
    "follow-up admitted",
    queued !== null,
    streamError ?? "the stream ended before its first part",
  );
  // Without a model the stream can end before the follow-up lands; only a model proves it queued.
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
      queued.wait({ intervalMs: 500, timeoutMs: FOLLOWUP_TIMEOUT_MS }),
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

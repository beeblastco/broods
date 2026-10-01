import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import type {
  AgentRunResult,
  AsyncAgentRun,
} from "../../../packages/broods/src/client.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { MODEL_KEY_HINT, assertStep, type VerifyContext } from "../harness.ts";

const COMPACT_TIMEOUT_MS = 120_000;
const COMPACTED = /^Context compacted\. \d+ message\(s\) summarized\.$/;

/**
 * `/compact` sent while a run owns the conversation waits behind it, even
 * sent as a steer, and runs in place of a model turn once that run has ended.
 * On an idle conversation a sync run answers it straight away.
 */
export async function queuedCompact(context: VerifyContext): Promise<void> {
  const key = `compact-${context.runId}`;
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

  const queued = await context.measure(
    "streamed run",
    async (): Promise<AsyncAgentRun | null> => {
      let admitted: AsyncAgentRun | null = null;
      try {
        for await (const _part of context.client.stream({
          agentId: agentId,
          conversationKey: key,
          eventId: `${key}-first`,
          input: "Say OK.",
        })) {
          // The first part means this run owns the conversation. A steer
          // would join it; a command must wait for it to end instead.
          admitted ??= await context.client.runAsync({
            agentId: agentId,
            conversationKey: key,
            eventId: `${key}-compact`,
            input: "/compact keep the greeting",
            mode: "steer",
          });
        }
      } catch {
        // Without a model the streamed run fails; the command still runs.
      }

      return admitted;
    },
  );
  assertStep(
    "/compact admitted",
    queued !== null,
    "the stream ended before its first part",
  );
  assertStep(
    context.hasModelKey
      ? "/compact queued behind the streamed run"
      : `/compact admitted as ${queued.status} (${MODEL_KEY_HINT})`,
    !context.hasModelKey || queued.status === "queued",
    JSON.stringify(queued),
  );

  const status = await context.measure(
    "queued /compact",
    (): Promise<AsyncStatus> =>
      queued.wait({ intervalMs: 500, timeoutMs: COMPACT_TIMEOUT_MS }),
  );
  assertStep(
    "/compact ran as a follow-up, not a steer",
    status.requestedMode === "followup",
    JSON.stringify(status),
  );
  assertStep(
    context.hasModelKey
      ? "queued /compact summarized the finished turn"
      : `queued /compact completed (${MODEL_KEY_HINT})`,
    status.status === "completed" &&
      (!context.hasModelKey || COMPACTED.test(String(status.response))),
    JSON.stringify(status),
  );

  const idle = await context.measure(
    "idle /compact",
    (): Promise<AgentRunResult> =>
      context.client.run({
        agentId: agentId,
        conversationKey: key,
        eventId: `${key}-idle`,
        input: "/compact",
      }),
  );
  assertStep(
    "idle /compact answers on the sync stream",
    idle.text === "Nothing to compact yet." ||
      COMPACTED.test(idle.text) ||
      (!context.hasModelKey && idle.text.length > 0),
    idle.text,
  );
}

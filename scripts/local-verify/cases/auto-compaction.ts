import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import type { AgentRunResult } from "../../../packages/broods/src/client.ts";
import { MODEL_KEY_HINT, assertStep, type VerifyContext } from "../harness.ts";

/**
 * Auto-compaction folds the history once a turn has finished. A `/compact`
 * after that turn then finds nothing new on an agent whose threshold the turn
 * crossed, and the whole turn still there on an agent that turned it off.
 */
export async function autoCompaction(context: VerifyContext): Promise<void> {
  const reply = async (
    name: string,
    autoCompaction?: { enabled: boolean; maxContextLength: number },
  ): Promise<string> => {
    const key = `${name}-${context.runId}`;
    const { agentId } = await context.measure(
      `create ${name} agent`,
      (): Promise<CreateAgentResult> =>
        context.account.createAgent({
          name: key,
          config: {
            ...context.model,
            instructions: "Reply with the single word OK.",
            ...(autoCompaction
              ? { session: { autoCompaction: autoCompaction } }
              : {}),
          },
        }),
    );
    const run = (eventId: string, input: string): Promise<string> =>
      context.client
        .run({
          agentId: agentId,
          conversationKey: key,
          eventId: `${key}-${eventId}`,
          input: input,
        })
        .then(
          (result: AgentRunResult): string => result.text,
          (err: unknown): string => String(err),
        );
    await context.measure(`${name} turn`, (): Promise<string> =>
      run("turn", "Say OK."),
    );

    return context.measure(`${name} /compact`, (): Promise<string> =>
      run("compact", "/compact"),
    );
  };

  const compacted = await reply("auto-compacting", {
    enabled: true,
    maxContextLength: 1,
  });
  const kept = await reply("not-compacting", {
    enabled: false,
    maxContextLength: 1,
  });
  const defaultThreshold = await reply("default-auto-compacting");
  if (!context.hasModelKey) {
    // Without a model no turn finishes, so nothing auto-compacts.
    assertStep(
      `auto-compaction needs a finished turn (${MODEL_KEY_HINT})`,
      compacted.length > 0 && kept.length > 0 && defaultThreshold.length > 0,
      `${compacted} | ${kept} | ${defaultThreshold}`,
    );

    return;
  }
  assertStep(
    "a turn past the threshold compacted itself once it finished",
    compacted === "Nothing to compact yet.",
    compacted,
  );
  assertStep(
    "a turn with auto-compaction off kept its history",
    /^Context compacted\. \d+ message\(s\) summarized\.$/.test(kept),
    kept,
  );
  assertStep(
    "a short turn stays below the model-aware default threshold",
    /^Context compacted\. \d+ message\(s\) summarized\.$/.test(
      defaultThreshold,
    ),
    defaultThreshold,
  );
}

import { assertStep, type VerifyContext } from "../harness.ts";

// Every field of the AI SDK's TimeoutConfiguration.
const TIMEOUT = {
  totalMs: 600_000,
  stepMs: 240_000,
  firstChunkMs: 120_000,
  chunkMs: 60_000,
  toolMs: 120_000,
  tools: { bashMs: 300_000 },
};

/**
 * `model.timeout` takes the AI SDK's own shape: the config plane stores every
 * field as sent, and refuses a misspelled field or a limit that is not a
 * positive integer before it reaches a run.
 */
export async function modelTimeout(context: VerifyContext): Promise<void> {
  const key = `model-timeout-${context.runId}`;
  const refused = await context.account
    .createAgent({
      name: `${key}-bad`,
      config: {
        ...context.model,
        model: { ...context.model.model, timeout: { firstChunkMs: 0 } },
      },
    })
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a zero model.timeout.firstChunkMs is refused",
    refused.includes(
      "config.model.timeout.firstChunkMs must be an integer from 1 to 2147483647",
    ),
    refused,
  );

  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      model: { ...context.model.model, timeout: TIMEOUT },
    },
  });
  try {
    const stored = await context.account.getAgent(agentId);
    assertStep(
      "every AI SDK timeout field is stored as sent",
      JSON.stringify(stored?.config.model?.timeout) === JSON.stringify(TIMEOUT),
      JSON.stringify(stored?.config.model),
    );
  } finally {
    await context.account.deleteAgent(agentId);
  }
}

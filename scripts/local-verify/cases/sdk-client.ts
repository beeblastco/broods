import type { AgentRunResult } from "../../../packages/broods/src/client.ts";
import { MODEL_KEY_HINT, assertStep, type VerifyContext } from "../harness.ts";

/** BroodsClient.run streams a reply over core SSE through the gateway. Needs a model key. */
export async function sdkClient(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip SDK stream (${MODEL_KEY_HINT})`);
    return;
  }
  const name = `sdk-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: name,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
    },
  });
  const result = await context.measure(
    "sdk stream run",
    (): Promise<AgentRunResult> =>
      context.client
        .agent(name, agentId)
        .run({ conversationKey: name, input: "Say OK." }),
  );
  assertStep(
    "SDK client streamed a reply through the gateway",
    result.text.trim().length > 0,
    JSON.stringify(result.events.slice(-5)),
  );
}

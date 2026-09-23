/**
 * The published SDK client against the local gateway: `BroodsClient.run`
 * streams a reply over core SSE. Needs a model key, since without one the
 * stream carries only the provider error.
 */

import { BroodsClient } from "../../../packages/broods/src/client.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  createAgent,
  type VerifyCase,
  type VerifyContext,
} from "../harness.ts";

export const sdkClientCase: VerifyCase = {
  name: "sdk client",
  run: async (context: VerifyContext): Promise<void> => {
    if (!context.hasModelKey) {
      console.log(`  skip SDK stream (${MODEL_KEY_HINT})`);

      return;
    }

    const name = `sdk-${context.runId}`;
    const agentId = await createAgent(context, name, {
      instructions: "Reply with the single word OK.",
    });
    const client = new BroodsClient({
      apiKey: context.accountSecret,
      baseUrl: context.gatewayUrl,
    });
    const result = await context.measure("sdk stream run", () =>
      client.agent(name, agentId).run({
        conversationKey: name,
        input: "Say OK.",
      }),
    );
    assertStep(
      "SDK client streamed a reply through the gateway",
      result.text.trim().length > 0,
      JSON.stringify(result.events.slice(-5)),
    );
  },
};

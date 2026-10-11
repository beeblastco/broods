import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import { BroodsWebSocketClient } from "../../../packages/broods/src/websocket.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

const SETTLE_MS = 1_500;

/**
 * BroodsWebSocketClient.attach through the gateway: a plain attach replays a
 * finished run, while an attach aborted on its first frame, or before it
 * opens, delivers nothing more and reports one abort. Runs without a model
 * key, since a run that fails at the provider still has frames to replay.
 */
export async function websocketAttachAbort(
  context: VerifyContext,
): Promise<void> {
  const key = `attach-${context.runId}`;
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: { ...context.model, instructions: "Reply with OK." },
      }),
  );
  const { runId } = await runToTerminal(context, {
    agentId: agentId,
    conversationKey: key,
    eventId: key,
    text: "Say OK.",
  });
  assertStep("the run to attach to has an id", runId !== undefined, key);
  const client = new BroodsWebSocketClient({
    baseUrl: context.edgeUrl,
    apiKey: context.accountSecret,
  });
  const attach = async (
    signal: AbortSignal | undefined,
    onFirst: () => void,
  ): Promise<{ errors: string[]; seen: string[] }> => {
    const seen: string[] = [];
    const errors: string[] = [];
    const subscription = client.attach(
      {
        endpointId: agentId,
        agentId: agentId,
        requestId: `${key}-${crypto.randomUUID()}`,
        runId: runId,
        eventId: key,
        conversationKey: key,
        signal: signal,
      },
      {
        onMessage: (message): void => {
          seen.push(message.type);
          if (seen.length === 1) onFirst();
        },
        onError: (error): void => {
          errors.push(error.message);
        },
      },
    );
    await Bun.sleep(SETTLE_MS);
    subscription.close();

    return { errors: errors, seen: seen };
  };

  const plain = await attach(undefined, (): void => undefined);
  assertStep(
    "a plain attach replays the finished run through the gateway",
    plain.seen.length > 1 && plain.errors.length === 0,
    JSON.stringify(plain),
  );
  const later = new AbortController();
  const aborted = await attach(later.signal, (): void => later.abort());
  assertStep(
    "an attach aborted on its first frame delivers nothing after it",
    aborted.seen.length === 1 &&
      aborted.errors.join() === "WebSocket attach aborted.",
    JSON.stringify(aborted),
  );
  const early = await attach(AbortSignal.abort(), (): void => undefined);
  assertStep(
    "an attach aborted before it opens delivers nothing",
    early.seen.length === 0 &&
      early.errors.join() === "WebSocket attach aborted.",
    JSON.stringify(early),
  );
}

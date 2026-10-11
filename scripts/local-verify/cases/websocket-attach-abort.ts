import {
  BroodsClient,
  type AgentReference,
} from "../../../packages/broods/src/client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { BroodsWebSocketClient } from "../../../packages/broods/src/websocket.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

const SETTLE_MS = 1_500;

/**
 * BroodsWebSocketClient.attach through the gateway on a stage's runtime key:
 * a plain attach replays a finished run, while an attach aborted on its first
 * frame, or before it opens, delivers nothing more and reports one abort.
 * Runs without a model key: a run that fails at the provider still replays.
 */
export async function websocketAttachAbort(
  context: VerifyContext,
): Promise<void> {
  const project = `attach-${context.runId}`;
  const deployed = await context.measure("deploy stage", () =>
    new BroodsSyncClient({
      baseUrl: context.edgeUrl,
      token: context.accountSecret,
    }).putManifest(
      {
        version: 1,
        project: project,
        stage: "development",
        resources: [
          {
            kind: "agent",
            name: "chat",
            config: {
              model: context.model.model,
              agent: { system: "Reply with OK." },
            },
          },
        ],
      },
      true,
    ),
  );
  const { deployment } = deployed;
  const agentId = deployed.ids.agents.chat;
  assertStep(
    "the deploy returned a runtime key and the agent id",
    deployment != null && agentId !== undefined,
    JSON.stringify(deployed.ids),
  );
  const agent: AgentReference = {
    kind: "agent",
    name: "chat",
    id: agentId,
    project: project,
    stage: "development",
    endpointId: deployment.endpointId,
    projectSlug: deployment.projectSlug,
    stageSlug: deployment.stageSlug,
  };
  const accepted = await new BroodsClient({
    apiKey: deployment.apiKey,
    baseUrl: context.edgeUrl,
  }).runAsync(agent, { conversationKey: project, input: "Say OK." });
  await context.measure("run to terminal", (): Promise<AsyncStatus> =>
    accepted.wait({ intervalMs: 200, timeoutMs: 120_000 }),
  );
  const client = new BroodsWebSocketClient({
    baseUrl: context.edgeUrl,
    apiKey: deployment.apiKey,
  });
  const attach = async (
    signal: AbortSignal | undefined,
    onFirst: () => void,
  ): Promise<{ errors: string[]; seen: string[] }> => {
    const seen: string[] = [];
    const errors: string[] = [];
    const subscription = client.attach(
      {
        agent: agent,
        agentId: agentId,
        requestId: crypto.randomUUID(),
        runId: accepted.runId,
        eventId: accepted.eventId,
        conversationKey: accepted.conversationKey,
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

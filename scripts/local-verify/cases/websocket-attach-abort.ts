import {
  BroodsClient,
  type AgentReference,
} from "../../../packages/broods/src/client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { BroodsWebSocketClient } from "../../../packages/broods/src/websocket.ts";
import { sealStageSessionTicket } from "../../../packages/convex/model/stageSessionTicket.ts";
import { assertStep, pollUntil, type VerifyContext } from "../harness.ts";

const ATTACH_TIMEOUT_MS = 15_000;
// Attach replays from JetStream; the local stack runs no NATS, in CI too.
const NO_NATS = "Gateway requires NATS_URL";

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
    "the deploy returned its endpoint and the agent id",
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
  // The runtime key cannot reach a private agent; a member's stage ticket can.
  const ticket = await sealStageSessionTicket(
    {
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
      projectId: project,
      projectSlug: deployment.projectSlug,
      stageId: deployment.stageSlug,
      stageSlug: deployment.stageSlug,
      expiresAt: Date.now() + 15 * 60_000,
    },
    context.stageTicketSecret,
  );
  const accepted = await new BroodsClient({
    apiKey: ticket,
    baseUrl: context.edgeUrl,
  }).runAsync(agent, { conversationKey: project, input: "Say OK." });
  await context.measure("run to terminal", (): Promise<AsyncStatus> =>
    accepted.wait({ intervalMs: 200, timeoutMs: 120_000 }),
  );
  const client = new BroodsWebSocketClient({
    baseUrl: context.edgeUrl,
    apiKey: ticket,
  });
  // Ends at `done` or an error frame, or quietMs after an aborted view reports its abort.
  const attach = async (
    signal: AbortSignal | undefined,
    onFirst: () => void,
    quietMs: number,
  ): Promise<{ errors: string[]; ms: number; seen: string[] }> => {
    const seen: string[] = [];
    const errors: string[] = [];
    let ended = false;
    const started = Date.now();
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
        onDone: (): void => {
          ended = true;
        },
        onError: (error): void => {
          errors.push(error.message);
          ended = true;
        },
      },
    );
    await pollUntil(
      {
        initialIntervalMs: 20,
        maxIntervalMs: 200,
        timeoutMs: ATTACH_TIMEOUT_MS,
      },
      async (): Promise<true | null> => (ended ? true : null),
    );
    const ms = Date.now() - started;
    await Bun.sleep(quietMs);
    subscription.close();

    return { errors: errors, ms: ms, seen: seen };
  };

  const plain = await attach(undefined, (): void => undefined, 0);
  if (plain.errors.includes(NO_NATS)) {
    console.log(`  skip attach replay (gateway has no NATS_URL)`);
  } else {
    assertStep(
      "a plain attach replays the finished run through the gateway",
      plain.seen.length > 1,
      JSON.stringify(plain),
    );
  }
  // Long enough for the whole replay the plain attach saw to arrive again.
  const quietMs = Math.max(plain.ms * 2, 500);
  const later = new AbortController();
  const aborted = await attach(
    later.signal,
    (): void => later.abort(),
    quietMs,
  );
  // Its first frame may be an error frame: that error must not reach onError.
  assertStep(
    "an attach aborted on its first frame delivers nothing after it",
    aborted.seen.length === 1 &&
      aborted.errors.join() === "WebSocket attach aborted.",
    JSON.stringify(aborted),
  );
  const early = await attach(
    AbortSignal.abort(),
    (): void => undefined,
    quietMs,
  );
  assertStep(
    "an attach aborted before it opens delivers nothing",
    early.seen.length === 0 &&
      early.errors.join() === "WebSocket attach aborted.",
    JSON.stringify(early),
  );
}

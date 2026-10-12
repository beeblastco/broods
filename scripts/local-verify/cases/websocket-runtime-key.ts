import {
  BroodsClient,
  type AgentReference,
} from "../../../packages/broods/src/client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { WebSocketServerMessage } from "../../../packages/broods/src/websocket-contracts.ts";
import { BroodsWebSocketClient } from "../../../packages/broods/src/websocket.ts";
import { sealStageSessionTicket } from "../../../packages/convex/model/stageSessionTicket.ts";
import {
  MODEL_KEY_HINT,
  OK_AGENT,
  assertStep,
  pollUntil,
  type VerifyContext,
} from "../harness.ts";

const SOCKET_TIMEOUT_MS = 30_000;
// The gateway streams a turn from JetStream. The local stack, in CI too, runs
// no NATS unless NATS_URL is set; a deployed gateway does.
const NO_NATS = "Gateway requires NATS_URL";

/**
 * The stage's runtime key, as `broods dev` writes it to BROODS_API_KEY, on the
 * gateway's sockets: it opens its stage's agent socket and runs a turn of a
 * `publicAccess` agent, is refused a private agent's turn and run, and never
 * opens the logs socket. The upgrade and attach checks need neither a model
 * key nor NATS. Without NATS the turns skip, and without a model key the
 * public turn only has to end.
 */
export async function websocketRuntimeKey(
  context: VerifyContext,
): Promise<void> {
  const project = `runtime-key-${context.runId}`;
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
            name: "public",
            config: {
              ...context.model,
              agent: OK_AGENT,
              publicAccess: true,
            },
          },
          {
            kind: "agent",
            name: "private",
            config: { ...context.model, agent: OK_AGENT },
          },
        ],
      },
      true,
    ),
  );
  const { deployment } = deployed;
  const publicId = deployed.ids.agents.public;
  const privateId = deployed.ids.agents.private;
  assertStep(
    "the deploy returned its runtime key and both agent ids",
    deployment?.apiKey.startsWith("bsk_") === true &&
      publicId !== undefined &&
      privateId !== undefined,
    JSON.stringify(deployed.ids),
  );
  const runtimeKey = deployment.apiKey;
  const reference = (name: string, id: string): AgentReference => ({
    kind: "agent",
    name: name,
    id: id,
    project: project,
    stage: "development",
    endpointId: deployment.endpointId,
    projectSlug: deployment.projectSlug,
    stageSlug: deployment.stageSlug,
  });
  const publicAgent = reference("public", publicId);
  const privateAgent = reference("private", privateId);
  const stagePath = `/v1/projects/${deployment.projectSlug}/stages/${deployment.stageSlug}`;

  /** The status the edge answers a WebSocket upgrade with. */
  const upgrade = async (path: string): Promise<number> => {
    const response = await fetch(`${context.edgeUrl}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": btoa(crypto.randomUUID().slice(0, 16)),
        "sec-websocket-protocol": `broods.v1, broods.token.${runtimeKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };
  const agentSocket = await upgrade(
    `${stagePath}/agents/${deployment.endpointId}/ws`,
  );
  assertStep(
    "the runtime key opens its stage's agent socket",
    agentSocket === 101,
    `status ${agentSocket}`,
  );
  const otherStage = await upgrade(
    `/v1/projects/${deployment.projectSlug}/stages/production/agents/${deployment.endpointId}/ws`,
  );
  assertStep(
    "the runtime key cannot open another stage's agent socket",
    otherStage === 403,
    `status ${otherStage}`,
  );
  const logs = await upgrade(`${stagePath}/observability/ws`);
  assertStep(
    "the runtime key cannot open the logs socket",
    logs === 401,
    `status ${logs}`,
  );

  const socket = new BroodsWebSocketClient({
    baseUrl: context.edgeUrl,
    apiKey: runtimeKey,
  });
  /** Every frame one socket view delivered, and the error it ended on. */
  const collect = async (
    open: (handlers: {
      onMessage: (message: WebSocketServerMessage) => void;
      onDone: () => void;
      onError: (error: Error) => void;
    }) => { close: () => void },
    endsOn: (message: WebSocketServerMessage) => boolean = (): boolean => false,
  ): Promise<{ error?: string; frames: WebSocketServerMessage[] }> => {
    const frames: WebSocketServerMessage[] = [];
    let ended = false;
    let error: string | undefined;
    const view = open({
      onMessage: (message): void => {
        frames.push(message);
        if (endsOn(message)) ended = true;
      },
      onDone: (): void => {
        ended = true;
      },
      onError: (failure): void => {
        error = failure.message;
        ended = true;
      },
    });
    await pollUntil(
      {
        initialIntervalMs: 20,
        maxIntervalMs: 200,
        timeoutMs: SOCKET_TIMEOUT_MS,
      },
      async (): Promise<true | null> => (ended ? true : null),
    );
    view.close();

    return { frames: frames, ...(error !== undefined ? { error: error } : {}) };
  };
  const turn = (agent: AgentReference): ReturnType<typeof collect> =>
    context.measure(`runtime key ${agent.name} turn`, () =>
      collect((handlers) =>
        socket.subscribe(
          {
            agent: agent,
            sessionId: `${project}-${agent.name}`,
            input: "Say OK.",
          },
          handlers,
        ),
      ),
    );
  // A run is accepted over HTTP, then attached to over the socket. The attach
  // asks core for the run's status with the runtime key before any NATS read.
  const attach = async (
    agent: AgentReference,
    apiKey: string,
  ): ReturnType<typeof collect> => {
    const accepted = await new BroodsClient({
      apiKey: apiKey,
      baseUrl: context.edgeUrl,
    }).runAsync(agent, {
      conversationKey: `${project}-${agent.name}-attach`,
      input: "Say OK.",
    });

    return context.measure(`runtime key ${agent.name} attach`, () =>
      collect(
        (handlers) =>
          socket.attach(
            {
              agent: agent,
              agentId: agent.id,
              requestId: crypto.randomUUID(),
              runId: accepted.runId,
              eventId: accepted.eventId,
              conversationKey: accepted.conversationKey,
            },
            handlers,
          ),
        (message): boolean =>
          message.type === "replay_unavailable" || message.type === "attached",
      ),
    );
  };

  // A run of the private agent only a member's stage ticket can start.
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
  const privateAttach = await attach(privateAgent, ticket);
  assertStep(
    "the runtime key cannot attach to a private agent's run",
    privateAttach.frames.some(
      (frame): boolean => frame.type === "replay_unavailable",
    ) &&
      !privateAttach.frames.some((frame): boolean => frame.type === "attached"),
    JSON.stringify(privateAttach),
  );
  const publicAttach = await attach(publicAgent, runtimeKey);
  assertStep(
    "the runtime key attaches to its public agent's run",
    publicAttach.error === NO_NATS ||
      publicAttach.frames.some((frame): boolean => frame.type === "attached"),
    JSON.stringify(publicAttach),
  );

  const privateTurn = await turn(privateAgent);
  if (privateTurn.error === NO_NATS) {
    console.log("  skip socket turns (gateway has no NATS_URL)");

    return;
  }
  assertStep(
    "the runtime key is refused a private agent's turn",
    privateTurn.error?.includes("is not publicly accessible") === true,
    JSON.stringify(privateTurn),
  );
  const publicTurn = await turn(publicAgent);
  assertStep(
    "the runtime key ran a public agent's turn on the socket",
    publicTurn.frames.some((frame): boolean => frame.type === "meta") &&
      (context.hasModelKey
        ? publicTurn.error === undefined &&
          publicTurn.frames.some(
            (frame): boolean => frame.type === "text-delta",
          )
        : publicTurn.error !== undefined &&
          !publicTurn.error.includes("is not publicly accessible")),
    JSON.stringify(publicTurn),
  );
  if (!context.hasModelKey) {
    console.log(`  the public turn ended at the provider (${MODEL_KEY_HINT})`);
  }
}

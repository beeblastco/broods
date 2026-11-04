import type { BroodsSyncClient as SyncClient } from "../../../packages/broods/src/sync.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import {
  toWebSocketBaseUrl,
  webSocketSubprotocols,
} from "../../../packages/broods/src/websocket.ts";
import { sealObservabilityTicket } from "../../../packages/convex/model/observabilityTicket.ts";
import { OK_AGENT, assertStep, type VerifyContext } from "../harness.ts";

// The dock agent's log credential: it reads one stage's logs and is refused everywhere else.
export async function observabilityTicket(
  context: VerifyContext,
): Promise<void> {
  const project = `observe-${context.runId}`;
  const owner: SyncClient = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const synced = await owner.putManifest(
    {
      version: 1,
      project: project,
      stage: "development",
      resources: [
        {
          kind: "agent",
          name: "reader",
          config: { ...context.model, agent: OK_AGENT },
        },
      ],
    },
    true,
  );
  const deployment = synced.deployment;
  const ticket = await sealObservabilityTicket(
    {
      accountId: deployment?.accountId ?? "",
      endpointId: deployment?.endpointId ?? "",
      projectSlug: deployment?.projectSlug ?? project,
      stageSlug: deployment?.stageSlug ?? "development",
      expiresAt: Date.now() + 60_000,
    },
    context.stageTicketSecret,
  );

  const projectSlug = deployment?.projectSlug ?? project;
  const opened = await context.measure(
    "open logs with a read-only ticket",
    () =>
      socketAnswer(
        context.edgeUrl,
        ticket,
        projectSlug,
        deployment?.stageSlug ?? "development",
      ),
  );
  const otherStage = await socketAnswer(
    context.edgeUrl,
    ticket,
    projectSlug,
    "production",
  );
  const forged = await socketAnswer(
    context.edgeUrl,
    `${ticket}x`,
    projectSlug,
    deployment?.stageSlug ?? "development",
  );
  assertStep(
    "a read-only ticket opens its stage's logs, no other stage's, and only when genuine",
    opened === "answered" && otherStage === "refused" && forged === "refused",
    JSON.stringify({ opened: opened, otherStage: otherStage, forged: forged }),
  );

  const status = async (path: string, method: string): Promise<number> => {
    const response = await fetch(`${context.edgeUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${ticket}`,
        "Content-Type": "application/json",
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    await response.body?.cancel();

    return response.status;
  };
  const refused = {
    run: await status("/v1/runs", "POST"),
    agents: await status("/v1/agents", "GET"),
    env: await status("/v1/env/X", "PUT"),
    sandboxes: await status("/v1/sandboxes", "GET"),
    audit: await status("/v1/audit", "GET"),
  };
  assertStep(
    "a read-only ticket is refused on every run and account route",
    Object.values(refused).every((code) => code === 401),
    JSON.stringify(refused),
  );
}

// What the gateway itself answers, with none of the client's retries in the way.
function socketAnswer(
  baseUrl: string,
  token: string,
  project: string,
  stage: string,
): Promise<"answered" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `${toWebSocketBaseUrl(baseUrl)}/v1/projects/${project}/stages/${stage}/observability/ws`,
      webSocketSubprotocols(token),
    );
    const timer = setTimeout((): void => {
      socket.close();
      resolve("timeout");
    }, 10_000);
    const settle = (answer: "answered" | "refused"): void => {
      clearTimeout(timer);
      socket.close();
      resolve(answer);
    };
    socket.onopen = (): void => {
      // The stack has no live transport; a trace read is answered only on an accepted socket.
      socket.send(
        JSON.stringify({ type: "fetchTrace", traceId: "a".repeat(32) }),
      );
    };
    socket.onmessage = (event: MessageEvent): void => {
      if (String(event.data).includes('"backfill"')) settle("answered");
    };
    socket.onerror = (): void => settle("refused");
    socket.onclose = (): void => settle("refused");
  });
}

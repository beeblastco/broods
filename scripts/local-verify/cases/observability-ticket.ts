import type { BroodsSyncClient as SyncClient } from "../../../packages/broods/src/sync.ts";
import { BroodsAccountClient } from "../../../packages/broods/src/account.ts";
import { fetchObservabilityLogs } from "../../../packages/broods/src/observability-client.ts";
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

  const upgrade = await fetch(
    `${context.edgeUrl}/v1/projects/${projectSlug}/stages/${deployment?.stageSlug ?? "development"}/observability/ws`,
    {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": btoa("the sample nonce"),
        "Sec-WebSocket-Protocol": webSocketSubprotocols(ticket).join(", "),
        "Sec-WebSocket-Extensions": "permessage-deflate",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  await upgrade.body?.cancel();
  const extensions = upgrade.headers.get("sec-websocket-extensions") ?? "";
  assertStep(
    "the edge carries a compression offer to the gateway, which accepts it",
    upgrade.status === 101 && extensions.includes("permessage-deflate"),
    `status ${upgrade.status}, extensions "${extensions}"`,
  );

  const account = new BroodsAccountClient({
    baseUrl: context.edgeUrl,
    accountSecret: context.accountSecret,
  });
  const audit = await account.readAudit({ limit: 3 });
  const usage = await account.readUsage(
    { project: projectSlug, stage: deployment?.stageSlug ?? "development" },
    "1d",
  );
  const logsWithoutLogin = await account
    .readLogs({
      project: projectSlug,
      stage: deployment?.stageSlug ?? "development",
    })
    .then(
      (): string => "read",
      (error: unknown): string => String(error),
    );
  assertStep(
    "the account reads audit and usage, and logs still need a login",
    audit.events.length > 0 &&
      !JSON.stringify(audit).includes("prevHash") &&
      usage?.totals !== undefined &&
      logsWithoutLogin.includes("403"),
    JSON.stringify({
      events: audit.events.length,
      usage: usage?.range,
      logsWithoutLogin: logsWithoutLogin.slice(0, 120),
    }),
  );

  const history = await fetchObservabilityLogs(
    {
      baseUrl: context.edgeUrl,
      credential: async (): Promise<string> => ticket,
      project: projectSlug,
      stage: deployment?.stageSlug ?? "development",
    },
    { limit: 5 },
  ).then(
    (): string => "read",
    (error: unknown): string => String(error),
  );
  // The stack has no NATS and no Loki: reaching Loki's error proves no live consumer was needed.
  assertStep(
    "a one-shot log read needs no live transport",
    history.includes("Log history is not configured"),
    history,
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

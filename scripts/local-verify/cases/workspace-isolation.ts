import type { AccountWorkspace } from "../../../packages/broods/src/account.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * Workspace isolation levels through the config plane and core: a level is
 * stored as sent, a boolean is refused, and a direct run on an agent-isolated
 * workspace resolves its namespace from the run's own agent. The local stack
 * has no bucket, so that run ends at the mount, past the namespace it had to
 * resolve first.
 */
export async function workspaceIsolation(
  context: VerifyContext,
): Promise<void> {
  const key = `isolation-${context.runId}`;
  const created = await context.measure(
    "create agent-isolated workspace",
    (): Promise<AccountWorkspace> =>
      context.account.createWorkspace({
        name: `${key}-agent`,
        config: { storage: { provider: "s3" }, isolation: "agent" },
      }),
  );
  const perAgent = await context.account.getWorkspace(created.workspaceId);
  assertStep(
    'isolation "agent" is stored as sent',
    perAgent?.config.isolation === "agent",
    JSON.stringify(perAgent),
  );
  // A raw request, since the SDK type no longer lets a boolean through.
  const boolean = await fetch(`${context.edgeUrl}/v1/workspaces`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accountSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `${key}-boolean`,
      config: { storage: { provider: "s3" }, isolation: true },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  await boolean.body?.cancel();
  assertStep(
    "isolation true is refused",
    boolean.status === 400,
    `status ${boolean.status}`,
  );
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
      workspaces: [
        { name: "scratch", workspaceId: created.workspaceId, sandbox: null },
      ],
    },
  });
  const status = await context.measure(
    "agent-isolated workspace run",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "a run on an agent-isolated workspace gets past namespace resolution",
    (status.status === "completed" || status.status === "failed") &&
      !(status.error ?? "").includes("Workspace isolation"),
    JSON.stringify(status),
  );
}

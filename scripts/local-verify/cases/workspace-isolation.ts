import type { AccountWorkspace } from "../../../packages/broods/src/account.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * Workspace isolation levels through the config plane and core: a level is
 * stored as sent, `true` is stored as "conversation", and a direct run on an
 * agent-isolated workspace resolves its namespace from the run's own agent.
 * The local stack has no bucket, so that run ends at the mount, past the
 * namespace it had to resolve first.
 */
export async function workspaceIsolation(
  context: VerifyContext,
): Promise<void> {
  const key = `isolation-${context.runId}`;
  const stored = await context.measure(
    "create isolated workspaces",
    (): Promise<(AccountWorkspace | null)[]> =>
      Promise.all(
        (["agent", true] as const).map(
          async (isolation): Promise<AccountWorkspace | null> => {
            const created = await context.account.createWorkspace({
              name: `${key}-${isolation}`,
              config: { storage: { provider: "s3" }, isolation: isolation },
            });

            return context.account.getWorkspace(created.workspaceId);
          },
        ),
      ),
  );
  const [perAgent, legacy] = stored;
  assertStep(
    'isolation "agent" is stored as sent',
    perAgent?.config.isolation === "agent",
    JSON.stringify(perAgent),
  );
  assertStep(
    "isolation true is stored as the conversation level",
    legacy?.config.isolation === "conversation",
    JSON.stringify(legacy),
  );
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
      workspaces: [
        { name: "scratch", workspaceId: perAgent.workspaceId, sandbox: null },
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

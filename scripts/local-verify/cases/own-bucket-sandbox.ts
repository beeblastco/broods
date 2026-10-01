import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * A workspace on its own bucket behind a deny-all lambda sandbox can never
 * mount, so the run is refused at resolve time with a clear error. It fails
 * before any model or AWS call, so it needs no model key.
 */
export async function ownBucketSandbox(context: VerifyContext): Promise<void> {
  const key = `own-bucket-${context.runId}`;
  const sandbox = await context.account.createSandbox({
    name: key,
    config: { provider: "lambda", network: { mode: "deny-all" } },
  });
  const workspace = await context.account.createWorkspace({
    name: key,
    config: {
      storage: {
        provider: "s3",
        bucket: `${key}-bucket`,
        prefix: "agents/",
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::123456789012:role/broods-mount",
        },
      },
    },
  });
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
      sandboxes: [sandbox.sandboxId],
      workspaces: [{ name: "byo", workspaceId: workspace.workspaceId }],
    },
  });
  const status = await context.measure(
    "own bucket on deny-all run",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "a deny-all lambda sandbox on an own-bucket workspace is refused",
    status.status === "failed" &&
      (status.error ?? "").includes('Workspace "byo" uses its own bucket'),
    JSON.stringify(status),
  );
}

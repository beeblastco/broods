import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * An MCP server whose header names a stage variable, `"Bearer ${NAME}"`, as the
 * docs say to write it. The sync resolves the ref into the agent, so its run
 * reaches the model instead of failing on the unresolved header. The server
 * itself is unreachable, which only costs the run its tools.
 */
export async function mcpHeaderEnv(context: VerifyContext): Promise<void> {
  const client = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const project = `mcp-env-${context.runId}`;
  const manifest: CliManifest = {
    version: 1,
    project: project,
    stage: "development",
    resources: [
      {
        kind: "mcp",
        name: "search",
        config: {
          transport: "http",
          url: "https://example.com/search/mcp",
          headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
        },
      },
      {
        kind: "agent",
        name: "reader",
        config: {
          model: context.model.model,
          agent: { system: "Reply with the single word OK." },
          mcp: { search: { enabled: true } },
        },
      },
    ],
  };
  await client.setEnv(project, "development", "SEARCH_TOKEN", "tok-local");
  const deployed = await context.measure(
    "sync an mcp server with a ${NAME} header",
    (): ReturnType<typeof client.putManifest> =>
      client.putManifest(manifest, true),
  );
  const agentId = deployed.ids.agents.reader;
  assertStep(
    "the sync created the agent",
    agentId !== undefined,
    JSON.stringify(deployed.ids),
  );

  const key = `mcp-env-${context.runId}`;
  const status = await context.measure(
    "run the agent connected to it",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId!,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "the header's ${NAME} ref resolved before the run",
    !status.error?.includes("still carries a ${NAME} ref"),
    JSON.stringify(status),
  );
  assertStep(
    context.hasModelKey
      ? `the run completed on ${context.model.model.modelId}`
      : `the run reached a terminal state (${MODEL_KEY_HINT})`,
    context.hasModelKey
      ? status.status === "completed"
      : status.status === "completed" || status.status === "failed",
    JSON.stringify(status),
  );
}

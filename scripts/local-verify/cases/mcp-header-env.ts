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
 * itself is unreachable, which only costs the run its tools. A role session
 * that may write MCP servers but not read env vars cannot repoint the server
 * the agent sends that resolved header to.
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
          ...context.model,
          agent: { system: "Reply with the single word OK." },
          // The CLI copies the server's headers here; core reads them from the agent.
          mcp: {
            search: {
              enabled: true,
              headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
            },
          },
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

  const send = async (
    method: string,
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<Response> =>
    await fetch(`${context.edgeUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  const created = await send("POST", "/v1/roles", context.accountSecret, {
    name: `mcp-writer-${context.runId}`,
    policy: {
      version: 1,
      rules: [{ id: "mcp", effect: "allow", actions: ["mcp:write"] }],
    },
  });
  const { roleId } = (await created.json()) as { roleId: string };
  const assumed = await send(
    "POST",
    "/v1/account/assume-role",
    context.accountSecret,
    { roleId: roleId },
  );
  const { token } = (await assumed.json()) as { token: string };
  const repointed = await context.measure(
    "repoint the mcp server from a role session",
    (): Promise<Response> =>
      send("PATCH", `/v1/mcp/${deployed.ids.mcp.search}`, token, {
        url: "https://attacker.example/mcp",
      }),
  );
  const refusal = await repointed.text();
  assertStep(
    "a role that may not read SEARCH_TOKEN cannot repoint the server that receives it",
    repointed.status === 400 && refusal.includes("SEARCH_TOKEN"),
    `${repointed.status} ${refusal.slice(0, 200)}`,
  );
  await send("DELETE", `/v1/roles/${roleId}`, context.accountSecret);
}

/**
 * Dashboard-facing MCP runtime verbs (#331): tools/list and tools/call
 * through the same client the agent harness uses, driven by the Convex
 * mcpService actions over the service-auth bridge. A `probe` body verifies an
 * uploaded bundle or external url before its row exists.
 */

import {
  callMcpToolResult,
  listMcpTools,
  mcpConnection,
  type McpConnection,
} from "../harness/mcp/client.ts";
import {
  sandboxMcpTarget,
  type SandboxMcpTarget,
} from "../harness/mcp/sandbox.ts";
import { getSandboxReservationRecord } from "../harness/sandbox/instance-store.ts";
import { sandboxReservationKey } from "../harness/sandbox/utils.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import type { McpRecord } from "../shared/domain/mcp.ts";
import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  type CoreRequest,
} from "../shared/http.ts";
import { isPlainObject, isStringRecord } from "../shared/object.ts";
import { getStorage } from "../shared/storage.ts";
import { resolveAgentRuntime } from "../shared/workspaces.ts";

const RPC_TIMEOUT_MS = 30_000;
// The agent id the explorer reserves a lambda sandbox's VM under when no agent
// of the stage runs on that sandbox.
const MCP_EXPLORER_AGENT_ID = "mcp-explorer";

/** An agent's VM for a sandbox-hosted row, and when its reservation was claimed. */
interface AgentSandboxCandidate {
  agent: AgentRecord;
  target: SandboxMcpTarget;
  claimedAt: number | undefined;
}

/** An unsaved row to verify: the minimal record fields a connection needs. */
interface McpProbe {
  name: string;
  transport: "http" | "hosted";
  url?: string;
  headers?: Record<string, string>;
  bundleStorageKey?: string;
  sha256?: string;
  workersCompatible?: boolean;
}

/**
 * Runs tools/list or tools/call against a saved server (dashboard MCP explorer)
 * or an unsaved probe (save-time check). Called from the account handler's
 * /v1/mcp-service/rpc route.
 */
export async function handleMcpServiceRpc(
  accountId: string,
  request: CoreRequest,
): Promise<Response> {
  const body = parseJsonBody(request);
  if (!isPlainObject(body)) {
    return errorResponse(400, "Request body must be a JSON object");
  }
  const method = body.method;
  if (method !== "tools/list" && method !== "tools/call") {
    return errorResponse(400, "method must be tools/list or tools/call");
  }

  let connection: McpConnection;
  if (typeof body.serverId === "string") {
    const record = await getStorage().mcp.getById(accountId, body.serverId);
    if (!record || record.status !== "active") {
      return errorResponse(404, "MCP server not found");
    }
    connection = {
      ...mcpConnection(record, undefined),
      sandbox: await explorerSandboxTarget(accountId, record),
    };
  } else {
    const probe = parseProbe(body.probe);
    if (typeof probe === "string") return errorResponse(400, probe);
    connection = {
      ...mcpConnection(probeRecord(accountId, probe), undefined),
      uncached: true,
    };
  }

  if (method === "tools/list") {
    const tools = await listMcpTools(connection);

    return jsonResponse(200, { tools: tools });
  }

  if (typeof body.toolName !== "string" || !body.toolName) {
    return errorResponse(400, "tools/call needs a toolName");
  }
  const args = isPlainObject(body.args) ? body.args : {};
  const started = Date.now();
  const result = await callMcpToolResult(connection, body.toolName, args, {
    abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  return jsonResponse(200, {
    result: result,
    durationMs: Date.now() - started,
  });
}

/**
 * The VM `agent` reaches `record` on and whether its reservation is live.
 * Undefined when the agent's config no longer resolves: its own runs fail on
 * that, and the explorer moves on to the next agent.
 */
async function agentSandboxCandidate(
  accountId: string,
  record: McpRecord,
  agent: AgentRecord,
): Promise<AgentSandboxCandidate | undefined> {
  const runtime = await resolveAgentRuntime(agent.config, {
    accountId: accountId,
    agentId: agent.agentId,
  }).catch((): undefined => undefined);
  const target = runtime && sandboxMcpTarget(record, runtime);
  const key = target && sandboxReservationKey(target.reservation);
  if (!target || !key) return undefined;
  const reservation = await getSandboxReservationRecord(
    target.config.provider,
    key,
  );

  return {
    agent: agent,
    target: target,
    claimedAt: reservation?.claimedAt,
  };
}

/**
 * Where the explorer reaches a row on a lambda sandbox of the row's stage: an
 * agent's VM, resolved the way that agent's run resolves it, so the explorer
 * never boots a second VM beside the agent's. In order: the stage's agent on
 * that sandbox whose reservation is live (most recently claimed first), else
 * the first agent by id that uses this server, so its next run lands on the VM
 * the explorer started, else a VM of the explorer's own. Undefined for any
 * other row.
 */
async function explorerSandboxTarget(
  accountId: string,
  record: McpRecord,
): Promise<SandboxMcpTarget | undefined> {
  if (record.transport !== "machine") return undefined;
  const storage = getStorage();
  const [sandboxes, agents] = await Promise.all([
    storage.sandboxConfigs.list(accountId),
    storage.agents.listForStage(accountId, record.projectId, record.stageId),
  ]);
  const host = sandboxes.find(
    (sandbox) =>
      sandbox.name === record.sandbox && sandbox.stageId === record.stageId,
  );
  if (host?.config.provider !== "lambda") return undefined;
  const candidates = (
    await Promise.all(
      agents
        .filter(
          (agent): boolean =>
            agent.config.sandboxes?.includes(host.sandboxId) === true,
        )
        .toSorted((left, right): number =>
          left.agentId.localeCompare(right.agentId),
        )
        .map((agent): Promise<AgentSandboxCandidate | undefined> =>
          agentSandboxCandidate(accountId, record, agent),
        ),
    )
  ).filter(
    (candidate): candidate is AgentSandboxCandidate => candidate !== undefined,
  );
  const [live] = candidates
    .filter((candidate): boolean => candidate.claimedAt !== undefined)
    .toSorted(
      (left, right): number => (right.claimedAt ?? 0) - (left.claimedAt ?? 0),
    );
  const user = candidates.find((candidate): boolean => {
    const entry = candidate.agent.config.mcp?.[record.serverId];

    return entry !== undefined && entry.enabled !== false;
  });
  const chosen = live ?? user;
  if (chosen) return chosen.target;
  const runtime = await resolveAgentRuntime(
    { sandboxes: [host.sandboxId] },
    { accountId: accountId, agentId: MCP_EXPLORER_AGENT_ID },
  );

  return sandboxMcpTarget(record, runtime);
}

/**
 * Validates the rpc body's probe object into an McpProbe, or returns the 400
 * error message.
 */
function parseProbe(value: unknown): McpProbe | string {
  if (!isPlainObject(value)) return "rpc needs a serverId or a probe object";
  const {
    name,
    transport,
    url,
    headers,
    bundleStorageKey,
    sha256,
    workersCompatible,
  } = value;
  if (typeof name !== "string" || !name) return "probe needs a name";
  if (headers !== undefined && !isStringRecord(headers)) {
    return "probe headers must be a string record";
  }
  const shared = {
    name: name,
    ...(headers !== undefined ? { headers: headers } : {}),
  };
  if (transport === "http") {
    if (typeof url !== "string" || !url) return "an http probe needs a url";

    return { ...shared, transport: transport, url: url };
  }
  if (transport === "hosted") {
    if (typeof bundleStorageKey !== "string" || typeof sha256 !== "string") {
      return "a hosted probe needs bundleStorageKey and sha256";
    }
    if (
      workersCompatible !== undefined &&
      typeof workersCompatible !== "boolean"
    ) {
      return "probe workersCompatible must be a boolean";
    }

    return {
      ...shared,
      transport: transport,
      bundleStorageKey: bundleStorageKey,
      sha256: sha256,
      ...(workersCompatible !== undefined
        ? { workersCompatible: workersCompatible }
        : {}),
    };
  }

  return "probe transport must be http or hosted";
}

/**
 * A synthetic one-shot record for verification. Its connection is marked
 * uncached, so a probe neither reads nor fills the MCP client caches.
 */
function probeRecord(accountId: string, probe: McpProbe): McpRecord {
  const now = new Date().toISOString();

  return {
    accountId: accountId,
    serverId: `probe-${crypto.randomUUID()}`,
    projectId: "probe",
    stageId: "probe",
    name: probe.name,
    transport: probe.transport,
    ...(probe.workersCompatible !== undefined
      ? { workersCompatible: probe.workersCompatible }
      : {}),
    ...(probe.url !== undefined ? { url: probe.url } : {}),
    ...(probe.headers !== undefined ? { headers: probe.headers } : {}),
    ...(probe.bundleStorageKey !== undefined
      ? { bundleStorageKey: probe.bundleStorageKey }
      : {}),
    ...(probe.sha256 !== undefined ? { sha256: probe.sha256 } : {}),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

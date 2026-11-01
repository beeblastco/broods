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
import { agentOwnWorkspace } from "../harness/tools/filesystem-utils.ts";
import { isToolEnabled } from "../harness/tools/index.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import type { McpRecord } from "../shared/domain/mcp.ts";
import type { SandboxConfigRecord } from "../shared/domain/sandbox-config.ts";
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
const MCP_EXPLORER_AGENT_ID = "mcp-explorer";

interface AgentSandboxCandidate {
  target: SandboxMcpTarget;
  liveSince: number | undefined;
}

// A row checked at save time, before it exists.
interface McpProbe {
  name: string;
  transport: "http" | "hosted";
  url?: string;
  headers?: Record<string, string>;
  bundleStorageKey?: string;
  sha256?: string;
  workersCompatible?: boolean;
}

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

async function agentSandboxCandidate(
  accountId: string,
  record: McpRecord,
  agent: AgentRecord,
  host: SandboxConfigRecord,
): Promise<AgentSandboxCandidate | undefined> {
  const ownsHost = agent.config.sandboxes?.[0] === host.sandboxId;
  const runtime = await resolveAgentRuntime(
    {
      sandboxes: [host.sandboxId],
      workspaces: ownsHost
        ? (agent.config.workspaces ?? []).filter(
            (ref): boolean =>
              ref.sandbox === undefined || ref.sandbox === host.sandboxId,
          )
        : [],
    },
    { accountId: accountId, agentId: agent.agentId },
  ).catch((): undefined => undefined);
  if (!runtime) return undefined;
  // Each conversation reserves its own VM there, and the explorer has no conversation.
  if (agentOwnWorkspace(runtime)?.config.isolation === "conversation") {
    return undefined;
  }
  const target = sandboxMcpTarget(record, runtime);
  const key = target && sandboxReservationKey(target.reservation);
  if (!target || !key) return undefined;
  const reservation = await getSandboxReservationRecord(
    target.config.provider,
    key,
  );
  const live =
    reservation !== null &&
    reservation.expiresAt >= Math.floor(Date.now() / 1000);

  return {
    target: target,
    liveSince: live ? reservation.claimedAt : undefined,
  };
}

async function explorerSandboxTarget(
  accountId: string,
  record: McpRecord,
): Promise<SandboxMcpTarget | undefined> {
  if (record.transport !== "machine") return undefined;
  const storage = getStorage();
  const sandboxes = await storage.sandboxConfigs.list(accountId);
  const host = sandboxes.find(
    (sandbox) =>
      sandbox.name === record.sandbox && sandbox.stageId === record.stageId,
  );
  if (host?.config.provider !== "lambda") return undefined;
  const agents = await storage.agents.listForStage(
    accountId,
    record.projectId,
    record.stageId,
  );
  const candidates = (
    await Promise.all(
      agents
        .filter(
          (agent): boolean =>
            agent.config.sandboxes?.includes(host.sandboxId) === true &&
            isToolEnabled(agent.config.mcp?.[record.serverId]),
        )
        .toSorted((left, right): number =>
          left.agentId.localeCompare(right.agentId),
        )
        .map((agent): Promise<AgentSandboxCandidate | undefined> =>
          agentSandboxCandidate(accountId, record, agent, host),
        ),
    )
  ).filter(
    (candidate): candidate is AgentSandboxCandidate => candidate !== undefined,
  );
  // Reuse an agent's VM so the explorer never boots a second: the live one claimed first
  // keeps calls on one VM, else the first agent by id so its next run lands on this VM.
  const [chosen] = candidates.toSorted(
    (left, right): number =>
      (left.liveSince ?? Infinity) - (right.liveSince ?? Infinity),
  );
  if (chosen) return chosen.target;
  const runtime = await resolveAgentRuntime(
    { sandboxes: [host.sandboxId] },
    { accountId: accountId, agentId: MCP_EXPLORER_AGENT_ID },
  );

  return sandboxMcpTarget(record, runtime);
}

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

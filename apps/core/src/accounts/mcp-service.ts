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
} from "../harness/mcp/client.ts";
import type { McpRecord } from "../shared/domain/mcp.ts";
import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  type CoreRequest,
} from "../shared/http.ts";
import { isPlainObject } from "../shared/object.ts";
import { getStorage } from "../shared/storage.ts";

const RPC_TIMEOUT_MS = 30_000;

/** An unsaved row to verify: the minimal record fields a connection needs. */
interface McpProbe {
  name: string;
  transport: "http" | "hosted";
  url?: string;
  headers?: Record<string, string>;
  bundleStorageKey?: string;
  sha256?: string;
}

export async function handleMcpServiceRpc(
  accountId: string,
  request: CoreRequest,
): Promise<Response> {
  const body = parseJsonBody(request.body ? request : { body: "{}" });
  if (!isPlainObject(body)) {
    return errorResponse(400, "Request body must be a JSON object");
  }
  const method = body.method;
  if (method !== "tools/list" && method !== "tools/call") {
    return errorResponse(400, "method must be tools/list or tools/call");
  }

  let record: McpRecord | null;
  if (typeof body.serverId === "string") {
    record = await getStorage().mcp.getById(accountId, body.serverId);
    if (!record || record.status !== "active") {
      return errorResponse(404, "MCP server not found");
    }
  } else {
    const probe = parseProbe(body.probe);
    if (typeof probe === "string") return errorResponse(400, probe);
    record = probeRecord(accountId, probe);
  }

  const connection = mcpConnection(record, undefined);
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

function parseProbe(value: unknown): McpProbe | string {
  if (!isPlainObject(value)) return "rpc needs a serverId or a probe object";
  const { name, transport, url, headers, bundleStorageKey, sha256 } = value;
  if (typeof name !== "string" || !name) return "probe needs a name";
  if (transport === "http") {
    if (typeof url !== "string" || !url) return "an http probe needs a url";
  } else if (transport === "hosted") {
    if (typeof bundleStorageKey !== "string" || typeof sha256 !== "string") {
      return "a hosted probe needs bundleStorageKey and sha256";
    }
  } else {
    return "probe transport must be http or hosted";
  }
  if (headers !== undefined) {
    if (
      !isPlainObject(headers) ||
      Object.values(headers).some((header) => typeof header !== "string")
    ) {
      return "probe headers must be a string record";
    }
  }

  return {
    name: name,
    transport: transport,
    ...(typeof url === "string" ? { url: url } : {}),
    ...(headers !== undefined
      ? { headers: headers as Record<string, string> }
      : {}),
    ...(typeof bundleStorageKey === "string"
      ? { bundleStorageKey: bundleStorageKey }
      : {}),
    ...(typeof sha256 === "string" ? { sha256: sha256 } : {}),
  };
}

/**
 * A synthetic one-shot record for verification. The unique serverId/updatedAt
 * pair keeps probe results out of the per-row era and listing caches' way.
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

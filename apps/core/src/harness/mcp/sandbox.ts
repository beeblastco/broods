// The lambda sandbox image serves `POST /mcp`, keeping each row's stdio server for the VM's life.

import { randomUUID } from "node:crypto";
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCRequest,
} from "@modelcontextprotocol/client";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import type { ResolvedAgentRuntime } from "../../shared/workspaces.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxReservedTarget,
} from "../sandbox/types.ts";
import { mergeSandboxEnv } from "../sandbox/utils.ts";
import {
  agentOwnWorkspace,
  sandboxTimeoutSeconds,
  statelessReservationKeyFor,
  workspaceRootFor,
} from "../tools/filesystem-utils.ts";

// Browser steps run longer than bash's 30 s default; the operator's ceiling still caps it.
const DEFAULT_TIMEOUT_SECONDS = 120;
const SERVER_START_MS = 30_000;

export interface SandboxMcpTarget {
  config: SandboxExecutorConfig;
  reservation: SandboxReservedTarget;
  command: string[];
}

export type SandboxMcpExecutor = Pick<SandboxExecutor, "postReserved">;

export async function sandboxMcpRequest(
  target: SandboxMcpTarget,
  serverName: string,
  message: Pick<JSONRPCRequest, "method" | "params">,
  abortSignal?: AbortSignal,
  executor: SandboxMcpExecutor = createSandboxExecutor(target.config),
): Promise<unknown> {
  if (!executor.postReserved) {
    throw new Error(
      `MCP server ${serverName} needs a lambda sandbox; ${target.config.provider} has no MCP host`,
    );
  }
  const timeoutMs =
    sandboxTimeoutSeconds(target.config, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const reply = await executor
    .postReserved({
      ...target.reservation,
      path: "/mcp",
      body: {
        server: serverName,
        command: target.command,
        // No run identity: the server outlives the run. The image restarts it when env changes.
        env: mergeSandboxEnv(target.config.envVars, undefined),
        message: {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: message.method,
          params: message.params,
        },
        timeout_ms: timeoutMs,
      },
      timeoutMs: timeoutMs + SERVER_START_MS,
      abortSignal: abortSignal,
    })
    .catch((error: unknown) => {
      throw new Error(
        `MCP server ${serverName} on its sandbox failed: ${toErrorMessage(error)}`,
      );
    });
  if (isJSONRPCErrorResponse(reply)) {
    throw new Error(`MCP server ${serverName}: ${reply.error.message}`);
  }
  if (!isJSONRPCResultResponse(reply)) {
    throw new Error(
      `MCP server ${serverName} answered with no JSON-RPC result`,
    );
  }

  return reply.result;
}

export function sandboxMcpTarget(
  record: McpRecord,
  runtime: Partial<ResolvedAgentRuntime>,
): SandboxMcpTarget | undefined {
  const host = runtime.sandboxes?.find(
    (entry) => entry.name === record.sandbox,
  );
  if (record.transport !== "machine" || host?.sandbox.provider !== "lambda") {
    return undefined;
  }
  if (!record.command) {
    throw new Error(
      `config.mcp.${record.serverId} runs on lambda sandbox "${host.name}" and needs command`,
    );
  }
  const workspace =
    host === runtime.sandboxes?.[0]
      ? agentOwnWorkspace({
          workspaces: runtime.workspaces ?? [],
          sandboxes: runtime.sandboxes,
        })
      : undefined;
  const config = workspace?.sandbox ?? host.sandbox;
  // The same target runSandbox gives bash, so both reach one VM.
  const reservation: SandboxReservedTarget = workspace
    ? {
        namespace: workspace.namespace,
        workspaceRoot: workspaceRootFor(config),
      }
    : { reservationKey: statelessReservationKeyFor(host.sandbox) };
  if (
    config.persistent !== true ||
    !(reservation.namespace ?? reservation.reservationKey)
  ) {
    throw new Error(
      `config.mcp.${record.serverId} runs on lambda sandbox "${host.name}", which must be persistent`,
    );
  }

  return { config: config, reservation: reservation, command: record.command };
}

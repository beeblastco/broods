/**
 * MCP servers on a lambda sandbox. The sandbox image serves `POST /mcp` on the
 * VM's proxy port: it spawns the row's stdio `command` on first use, runs the
 * MCP handshake itself and keeps the process for the VM's lifetime, so a
 * server's state (a browser session) lasts as long as the reservation. Core
 * relays one JSON-RPC request per listing or call through the MicroVM
 * executor, which owns reaching the VM; this file owns only the envelope.
 */

import { randomUUID } from "node:crypto";
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCRequest,
} from "@modelcontextprotocol/client";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { workspaceSandboxLimits } from "../../shared/sandbox.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../../shared/workspaces.ts";
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

// A tool call on a sandbox with no `timeout` of its own: browser steps run
// longer than bash's 30 s default. The operator's ceiling still caps it.
const DEFAULT_TIMEOUT_SECONDS = 120;
// The image may spend up to this long starting a server and running its
// handshake before the tool's own timeout begins.
const SERVER_START_MS = 30_000;

/** Which VM serves the row and what it runs: bash's sandbox and reservation. */
export interface SandboxMcpTarget {
  config: SandboxExecutorConfig;
  reservation: SandboxReservedTarget;
  command: string[];
}

/** The executor call the relay makes; tests pass a fake. */
export type SandboxMcpExecutor = Pick<SandboxExecutor, "postReserved">;

/**
 * Send one JSON-RPC request to a server on a lambda sandbox and return its
 * result. mcp/client.ts calls it for `tools/list` and `tools/call` when the
 * connection carries a lambda sandbox. The executor checks the account's
 * sandbox budget first, as it does for bash.
 */
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
    (target.config.timeout === undefined
      ? Math.min(
          DEFAULT_TIMEOUT_SECONDS,
          workspaceSandboxLimits(target.config.provider).maxTimeoutSeconds,
        )
      : sandboxTimeoutSeconds(target.config)) * 1000;
  const reply = await executor
    .postReserved({
      ...target.reservation,
      path: "/mcp",
      body: {
        server: serverName,
        command: target.command,
        // The server sees the env vars bash sees, minus the run identity: it
        // outlives the run. The image restarts the server when they change.
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

/**
 * Where a row runs when it names a lambda sandbox among `runtime.sandboxes`:
 * the VM bash reaches on that sandbox, which is the workspace's when one mounts
 * the agent's first sandbox. Undefined for any other row (a machine sandbox's
 * daemon serves it). A missing command or a non-persistent sandbox is a config
 * error, not a quiet skip. Agent tool registration and the dashboard explorer
 * both resolve a row here, each with its own runtime.
 */
export function sandboxMcpTarget(
  record: McpRecord,
  runtime: {
    sandboxes?: ResolvedAgentSandbox[];
    workspaces?: ResolvedWorkspace[];
  },
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

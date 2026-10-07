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
import { toErrorMessage } from "../../shared/errors.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
} from "../sandbox/types.ts";
import { sandboxTimeoutSeconds } from "../tools/filesystem-utils.ts";

// The image may spend up to this long starting a server and running its
// handshake before the tool's own timeout begins.
const SERVER_START_MS = 30_000;

/** Which VM serves the row and what it runs: bash's sandbox and reservation. */
export interface SandboxMcpTarget {
  config: SandboxExecutorConfig;
  reservationKey: string;
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
  const timeoutMs = sandboxTimeoutSeconds(target.config) * 1000;
  const reply = await executor
    .postReserved({
      reservationKey: target.reservationKey,
      path: "/mcp",
      body: {
        server: serverName,
        command: target.command,
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

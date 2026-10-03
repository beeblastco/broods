/**
 * MCP servers on a lambda sandbox. The sandbox image serves `POST /mcp` on the
 * VM's proxy port: it spawns the row's stdio `command` on first use, runs the
 * MCP handshake itself and keeps the process for the VM's lifetime, so a
 * server's state (a browser session) lasts as long as the reservation. Core
 * relays one JSON-RPC request per listing or call. Reserving the VM and minting
 * its auth token stay in the MicroVM executor; this file owns only the relay.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { assertSandboxBudget } from "../plan-limits.ts";
import {
  EXEC_GRACE_MS,
  MICROVM_PROXY_PORT,
  MicrovmSandboxExecutor,
  WARMUP_BUDGET_MS,
  WARMUP_RETRY_MAX_DELAY_MS,
  WARMUP_RETRY_MIN_DELAY_MS,
} from "../sandbox/microvm-executor.ts";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;

/** The reservation calls the relay makes; tests pass a fake. */
export type SandboxMcpExecutor = Pick<
  MicrovmSandboxExecutor,
  "acquireHarnessReservation" | "createHarnessAuthToken"
>;

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Send one JSON-RPC request to a server on a lambda sandbox and return its
 * result. mcp/client.ts calls it for `tools/list` and `tools/call` when the
 * connection carries a lambda sandbox. Host failures come back as a JSON-RPC
 * error and throw with the server's message.
 */
export async function sandboxMcpRequest(
  sandbox: SandboxExecutorConfig,
  server: Pick<McpRecord, "name" | "command">,
  message: { method: string; params: Record<string, unknown> },
  executor: SandboxMcpExecutor = new MicrovmSandboxExecutor(sandbox),
): Promise<unknown> {
  const reservationKey = sandbox.options?.reservationKey;
  if (
    sandbox.persistent !== true ||
    typeof reservationKey !== "string" ||
    reservationKey.length === 0
  ) {
    throw new Error(
      `MCP server ${server.name} runs on a lambda sandbox, which must be persistent`,
    );
  }
  const accountId = sandbox.controlPlane?.accountId;
  if (accountId && !sandbox.controlPlane?.ownCredentials) {
    await assertSandboxBudget(accountId);
  }
  // Shared: bash and other conversations use the same VM, so a failed first
  // setup must not release it from under them.
  const { microvmId, endpoint } = await executor.acquireHarnessReservation({
    reservationKey: reservationKey,
    shared: true,
  });
  const token = await executor.createHarnessAuthToken(
    microvmId,
    MICROVM_PROXY_PORT,
  );
  const timeoutMs = (sandbox.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const response = await postWhenReady(
    `https://${endpoint.replace(/^https?:\/\//, "")}/mcp`,
    token,
    JSON.stringify({
      server: server.name,
      command: server.command,
      message: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: message.method,
        params: message.params,
      },
      timeout_ms: timeoutMs,
    }),
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `MCP server ${server.name} on its sandbox failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const reply = JSON.parse(text) as JsonRpcResponse;
  if (reply.error) {
    throw new Error(`MCP server ${server.name}: ${reply.error.message}`);
  }

  return reply.result;
}

/**
 * POST to the VM, retrying while it restores its snapshot: the proxy answers
 * 502/503 or refuses the connection until the guest is up. A timeout is not
 * retried, since the request may already be running.
 */
async function postWhenReady(
  url: string,
  token: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + WARMUP_BUDGET_MS;
  let wait = WARMUP_RETRY_MIN_DELAY_MS;
  for (;;) {
    let status: number | string;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-aws-proxy-auth": token,
          "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
        },
        body: body,
        signal: AbortSignal.timeout(timeoutMs + EXEC_GRACE_MS),
      });
      if (response.status !== 502 && response.status !== 503) return response;
      status = response.status;
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw error;
      }
      status = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `MicroVM did not become ready within ${WARMUP_BUDGET_MS}ms (last status ${status})`,
      );
    }
    await sleep(wait);
    wait = Math.min(wait * 2, WARMUP_RETRY_MAX_DELAY_MS);
  }
}

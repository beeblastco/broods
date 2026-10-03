/**
 * MCP servers on a lambda sandbox. The sandbox image serves `POST /mcp` on the
 * VM's proxy port: it spawns the row's stdio `command` on first use, runs the
 * MCP handshake itself and keeps the process for the VM's lifetime, so a
 * server's state (a browser session) lasts as long as the reservation. Core
 * relays one JSON-RPC request per listing or call. Reserving the VM and minting
 * its auth token stay in the MicroVM executor; this file owns only the relay.
 */

import { randomUUID } from "node:crypto";
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/client";
import { assertSandboxBudget } from "../plan-limits.ts";
import {
  EXEC_GRACE_MS,
  MICROVM_PROXY_PORT,
  MicrovmSandboxExecutor,
} from "../sandbox/microvm-executor.ts";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
// The image may spend up to this long starting a server and running its
// handshake before the tool's own timeout begins.
const SERVER_START_MS = 30_000;
// A VM reached this recently is still warm, so its endpoint and token are reused
// instead of a full reservation per call. Past it the next call reserves again,
// which also wakes a VM that suspended while idle.
const WARM_MS = 60_000;

/** Which VM serves the row: the sandbox config and the reservation bash also uses. */
export interface SandboxMcpTarget {
  config: SandboxExecutorConfig;
  reservationKey: string;
}

/** The reservation calls the relay makes; tests pass a fake. */
export type SandboxMcpExecutor = Pick<
  MicrovmSandboxExecutor,
  "acquireHarnessReservation" | "createHarnessAuthToken" | "reportBurst"
>;

interface WarmVm {
  microvmId: string;
  endpoint: string;
  token: string;
  lastUsed: number;
}

const warmVms = new Map<string, WarmVm>();

/**
 * Send one JSON-RPC request to a server on a lambda sandbox and return its
 * result. mcp/client.ts calls it for `tools/list` and `tools/call` when the
 * connection carries a lambda sandbox. It never resends: the reservation waits
 * for the VM to be ready, and a request that failed after reaching the guest
 * may already have run.
 */
export async function sandboxMcpRequest(
  target: SandboxMcpTarget,
  server: { name: string; command: string[] },
  message: { method: string; params: Record<string, unknown> },
  abortSignal?: AbortSignal,
  executor: SandboxMcpExecutor = new MicrovmSandboxExecutor(target.config),
): Promise<unknown> {
  const timeoutMs = (target.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const vm = await warmVm(target, executor);
  const deadline = AbortSignal.timeout(
    timeoutMs + SERVER_START_MS + EXEC_GRACE_MS,
  );
  let response: Response;
  try {
    response = await fetch(`https://${vm.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-aws-proxy-auth": vm.token,
        "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
      },
      body: JSON.stringify({
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
      signal: abortSignal ? AbortSignal.any([deadline, abortSignal]) : deadline,
    });
  } catch (error) {
    warmVms.delete(target.reservationKey);
    throw error;
  }
  if (!response.ok) {
    warmVms.delete(target.reservationKey);
    throw new Error(
      `MCP server ${server.name} on its sandbox failed (${response.status}): ${(await response.text()) || response.statusText}`,
    );
  }
  vm.lastUsed = Date.now();
  executor.reportBurst(vm.microvmId, burstTotals(response.headers));
  const reply: unknown = await response.json();
  if (isJSONRPCErrorResponse(reply)) {
    throw new Error(`MCP server ${server.name}: ${reply.error.message}`);
  }
  if (!isJSONRPCResultResponse(reply)) {
    throw new Error(
      `MCP server ${server.name} answered with no JSON-RPC result`,
    );
  }

  return reply.result;
}

/** The VM's endpoint and token: reused while warm, else reserved again. */
async function warmVm(
  target: SandboxMcpTarget,
  executor: SandboxMcpExecutor,
): Promise<WarmVm> {
  const cached = warmVms.get(target.reservationKey);
  if (cached && Date.now() - cached.lastUsed < WARM_MS) return cached;
  const accountId = target.config.controlPlane?.accountId;
  if (accountId && !target.config.controlPlane?.ownCredentials) {
    await assertSandboxBudget(accountId);
  }
  // Shared: bash and other conversations use the same VM, so a failed first
  // setup must not release it from under them.
  const { microvmId, endpoint } = await executor.acquireHarnessReservation({
    reservationKey: target.reservationKey,
    shared: true,
  });
  const vm: WarmVm = {
    microvmId: microvmId,
    endpoint: endpoint.replace(/^https?:\/\//, ""),
    token: await executor.createHarnessAuthToken(microvmId, MICROVM_PROXY_PORT),
    lastUsed: Date.now(),
  };
  warmVms.set(target.reservationKey, vm);

  return vm;
}

/** The VM's burst totals from the image's `x-sandbox-burst` header, if it sent them. */
function burstTotals(
  headers: Headers,
): { vcpu_seconds: number; gb_seconds: number } | undefined {
  const header = headers.get("x-sandbox-burst");
  if (!header) return undefined;
  const totals: unknown = JSON.parse(header);
  if (
    typeof totals !== "object" ||
    totals === null ||
    !("vcpu_seconds" in totals) ||
    !("gb_seconds" in totals) ||
    typeof totals.vcpu_seconds !== "number" ||
    typeof totals.gb_seconds !== "number"
  ) {
    return undefined;
  }

  return { vcpu_seconds: totals.vcpu_seconds, gb_seconds: totals.gb_seconds };
}

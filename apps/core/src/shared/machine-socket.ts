/**
 * Wire contract of the machine sandbox socket, shared by core (the server
 * side, harness/sandbox/machine-executor.ts) and the gateway, which relays
 * the daemon's socket to core byte for byte. The CLI daemon mirrors these
 * shapes in packages/broods/src/machine-contracts.ts; move both together.
 *
 * JSON text frames. `hello` claims a sandbox record by name, `ready` confirms
 * it, then `exec` and `result` pair by id so calls may overlap.
 */

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

export const MACHINE_CLOSE = {
  badFrame: { code: 4400, reason: "Malformed frame" },
  replaced: { code: 4409, reason: "Replaced by a newer connection" },
  unauthorized: { code: 4401, reason: "Unauthorized" },
  unknownSandbox: {
    code: 4404,
    reason: "No machine sandbox with that name in this account",
  },
} as const;

export interface MachineExecFrame {
  type: "exec";
  id: string;
  code: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds: number;
  outputLimitBytes: number;
}

export interface MachineHelloFrame {
  type: "hello";
  sandbox: string;
  hostname?: string;
  platform?: string;
}

export interface MachineReadyFrame {
  type: "ready";
  sandboxId: string;
}

export interface MachineResultFrame {
  type: "result";
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export type MachineFrame =
  | MachineExecFrame
  | MachineHelloFrame
  | MachineReadyFrame
  | MachineResultFrame;

/** The daemon socket URL on a core or gateway base URL. */
export function machineSocketUrl(baseUrl: string): string {
  const url = new URL(MACHINE_WEBSOCKET_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export function parseMachineFrame(raw: unknown): MachineFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    if (
      type === "exec" ||
      type === "hello" ||
      type === "ready" ||
      type === "result"
    ) {
      return parsed as MachineFrame;
    }
  } catch {
    return null;
  }

  return null;
}

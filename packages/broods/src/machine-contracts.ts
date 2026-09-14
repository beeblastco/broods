/**
 * Wire contract of the machine sandbox socket, the daemon side. Mirrors
 * apps/core/src/shared/machine-socket.ts; move both together.
 */

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

/** Close codes core answers with. Any of these means "stop, do not reconnect". */
export const MACHINE_FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4401, 4404, 4409,
]);

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

export type MachineServerFrame = MachineExecFrame | MachineReadyFrame;

export function machineSocketUrl(baseUrl: string): string {
  const url = new URL(MACHINE_WEBSOCKET_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export function parseMachineServerFrame(
  raw: unknown,
): MachineServerFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    if (type === "exec" || type === "ready")
      return parsed as MachineServerFrame;
  } catch {
    return null;
  }

  return null;
}

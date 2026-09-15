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

/**
 * Parse one frame from core. Every field is checked: an exec without a limit
 * or timeout would otherwise run unbounded on the user's computer.
 */
export function parseMachineServerFrame(
  raw: unknown,
): MachineServerFrame | null {
  const fields = jsonFields(raw);
  if (!fields) return null;
  if (fields.type === "exec") return execFrame(fields);
  if (fields.type === "ready") return readyFrame(fields);

  return null;
}

function execFrame(fields: Record<string, unknown>): MachineExecFrame | null {
  if (
    typeof fields.id !== "string" ||
    typeof fields.code !== "string" ||
    !isPositiveNumber(fields.timeoutSeconds) ||
    !isPositiveNumber(fields.outputLimitBytes) ||
    !isOptionalString(fields.cwd) ||
    !isOptionalStringRecord(fields.env)
  ) {
    return null;
  }

  return {
    type: "exec",
    id: fields.id,
    code: fields.code,
    ...(fields.cwd !== undefined ? { cwd: fields.cwd } : {}),
    ...(fields.env !== undefined ? { env: fields.env } : {}),
    timeoutSeconds: fields.timeoutSeconds,
    outputLimitBytes: fields.outputLimitBytes,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalStringRecord(
  value: unknown,
): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function jsonFields(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readyFrame(fields: Record<string, unknown>): MachineReadyFrame | null {
  if (typeof fields.sandboxId !== "string") return null;

  return { type: "ready", sandboxId: fields.sandboxId };
}

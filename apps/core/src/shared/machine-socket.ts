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

/**
 * Parse one text frame off the socket. Every field is checked, so a frame that
 * names a `type` but lacks the fields that go with it is dropped as malformed
 * rather than settling a pending exec with holes in it.
 */
export function parseMachineFrame(raw: unknown): MachineFrame | null {
  const fields = jsonFields(raw);
  if (!fields) return null;
  if (fields.type === "exec") return execFrame(fields);
  if (fields.type === "hello") return helloFrame(fields);
  if (fields.type === "ready") return readyFrame(fields);
  if (fields.type === "result") return resultFrame(fields);

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

function helloFrame(fields: Record<string, unknown>): MachineHelloFrame | null {
  if (
    typeof fields.sandbox !== "string" ||
    fields.sandbox.length === 0 ||
    !isOptionalString(fields.hostname) ||
    !isOptionalString(fields.platform)
  ) {
    return null;
  }

  return {
    type: "hello",
    sandbox: fields.sandbox,
    ...(fields.hostname !== undefined ? { hostname: fields.hostname } : {}),
    ...(fields.platform !== undefined ? { platform: fields.platform } : {}),
  };
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
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

function resultFrame(
  fields: Record<string, unknown>,
): MachineResultFrame | null {
  if (
    typeof fields.id !== "string" ||
    (fields.exitCode !== null && typeof fields.exitCode !== "number") ||
    typeof fields.stdout !== "string" ||
    typeof fields.stderr !== "string" ||
    typeof fields.durationMs !== "number" ||
    !isOptionalBoolean(fields.timedOut) ||
    !isOptionalBoolean(fields.truncated)
  ) {
    return null;
  }

  return {
    type: "result",
    id: fields.id,
    exitCode: fields.exitCode,
    stdout: fields.stdout,
    stderr: fields.stderr,
    durationMs: fields.durationMs,
    ...(fields.timedOut !== undefined ? { timedOut: fields.timedOut } : {}),
    ...(fields.truncated !== undefined ? { truncated: fields.truncated } : {}),
  };
}

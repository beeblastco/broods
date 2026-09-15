/**
 * Wire contract of the machine sandbox socket: JSON text frames between the
 * `broods machine` daemon (packages/broods/src/cli/machine.ts bundles this
 * file) and core (harness/sandbox/machine-executor.ts), relayed unchanged by
 * the gateway. `hello` claims a sandbox record by name and `ready` confirms
 * it; after that a request and its reply share an id, so calls may overlap.
 */

import { isPlainObject, isStringRecord } from "./object.ts";

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

export const MACHINE_CLOSE = {
  badFrame: { code: 4400, reason: "Malformed frame" },
  replaced: { code: 4409, reason: "Replaced by a newer connection" },
  unauthorized: { code: 4401, reason: "Unauthorized; check BROODS_API_KEY" },
  unknownSandbox: {
    code: 4404,
    reason: "No machine sandbox with that name in this account",
  },
} as const;

/** Frames core sends. */
export type MachineCoreFrame = MachineExecFrame | MachineReadyFrame;

/** Frames the daemon sends. */
export type MachineDaemonFrame = MachineHelloFrame | MachineResultFrame;

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
  timedOut: boolean;
  truncated: boolean;
}

export function machineSocketUrl(baseUrl: string): string {
  const url = new URL(MACHINE_WEBSOCKET_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

/** A frame from core, or null. An exec without a timeout or limit never runs. */
export function parseCoreFrame(raw: unknown): MachineCoreFrame | null {
  const fields = jsonFields(raw);
  if (fields?.type === "exec") return execFrame(fields);
  if (fields?.type === "ready") return readyFrame(fields);

  return null;
}

/** A frame from the daemon, or null. A reply with holes never settles a call. */
export function parseDaemonFrame(raw: unknown): MachineDaemonFrame | null {
  const fields = jsonFields(raw);
  if (fields?.type === "hello") return helloFrame(fields);
  if (fields?.type === "result") return resultFrame(fields);

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
    cwd: fields.cwd,
    env: fields.env,
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
    hostname: fields.hostname,
    platform: fields.platform,
  };
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
    typeof fields.timedOut !== "boolean" ||
    typeof fields.truncated !== "boolean"
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
    timedOut: fields.timedOut,
    truncated: fields.truncated,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalStringRecord(
  value: unknown,
): value is Record<string, string> | undefined {
  return value === undefined || isStringRecord(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function jsonFields(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

import type { StatusTone } from "@/app/components/StatusDot";
import type { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

// Core stamps `lastSeenAt` every minute: two missed heartbeats plus slack means offline.
const HEARTBEAT_GRACE_MS = 150_000;

export const MACHINE_LABEL = "broods machine";

export const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  connected: "Connected",
  never: "Not connected yet",
  offline: "Offline",
};

export const MACHINE_TONE: Record<MachineState, StatusTone> = {
  connected: "ok",
  never: "ended",
  offline: "warn",
};

export type MachineConnection = FunctionReturnType<
  typeof api.sandbox.machines.listForActiveOrg
>[number];

export type MachineState = "connected" | "never" | "offline";

export function machineStartCommand(
  name: string,
  connection: MachineConnection | null | undefined,
): string {
  const flags = [
    ...(connection?.computer ? ["--computer"] : []),
    ...(connection?.mcp.length ? ["--mcp <file>"] : []),
  ];

  return ["broods machine", name, ...flags].join(" ");
}

export function machineState(
  connection: MachineConnection | null | undefined,
  now: number,
): MachineState {
  if (!connection) return "never";

  return connection.disconnectedAt === undefined &&
    now - connection.lastSeenAt < HEARTBEAT_GRACE_MS
    ? "connected"
    : "offline";
}

export function machineStateByName(
  connections: readonly MachineConnection[] | undefined,
  name: string,
  now: number,
): MachineState | undefined {
  if (connections === undefined) return undefined;

  return machineState(
    connections.find((connection) => connection.name === name),
    now,
  );
}

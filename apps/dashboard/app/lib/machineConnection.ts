/**
 * How the dashboard reads a machine sandbox's daemon connection
 * (packages/convex/sandbox/machines.ts). Core stamps `lastSeenAt` every minute,
 * so a row quiet for longer reads as offline even when its disconnect never
 * landed.
 */

import type { StatusTone } from "@/app/components/StatusDot";
import type { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

// Two missed heartbeats plus slack.
const HEARTBEAT_GRACE_MS = 150_000;

/** What a machine sandbox is called wherever a provider name is shown. */
export const MACHINE_LABEL = "your computer";

export const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  connected: "Connected",
  never: "Not connected yet",
  offline: "Offline",
};

export const MACHINE_TONE: Record<MachineState, StatusTone> = {
  connected: "ok",
  never: "ended",
  offline: "ended",
};

export type MachineConnection = FunctionReturnType<
  typeof api.sandbox.machines.listForActiveOrg
>[number];

export type MachineState = "connected" | "never" | "offline";

/** The command to run on that computer, with the flags it last started with. */
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

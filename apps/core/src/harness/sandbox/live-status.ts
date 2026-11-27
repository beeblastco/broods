// Occupancy lives in memory: core runs one replica. These <environment> lines ride after the
// cached prompt prefix, never in it.

import type { BroodsSandboxDriverSession } from "@broods/ai-sdk-sandbox";
import type { SandboxInstanceInfo } from "./types.ts";
import { configString, configuredSandboxSpecs } from "./utils.ts";
import type { SandboxSpecs } from "../../shared/sandbox-sizes.ts";
import type { ResolvedAgentSandbox } from "../../shared/workspaces.ts";

const OCCUPANT_STALE_MS = 6 * 60 * 60 * 1000;
const USAGE_TIMEOUT_MS = 3_000;
// One exec, one fixed key per line, so a missing tool only blanks its own field.
const USAGE_PROBE = [
  'echo "cpus $(nproc 2>/dev/null)"',
  "echo \"load $(cut -d' ' -f1 /proc/loadavg 2>/dev/null)\"",
  "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print \"mem\", t, a}' /proc/meminfo 2>/dev/null",
  "df -Pk / 2>/dev/null | awk 'NR==2{print \"disk\", $2, $3}'",
].join("; ");

export interface SandboxUsage {
  cpus?: number;
  diskTotalGb?: number;
  diskUsedGb?: number;
  load1?: number;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
}

export interface SandboxOccupant {
  agentId?: string;
  conversationKey: string;
  since: number;
}

export interface SandboxStatus {
  name: string;
  provider: string;
  specs?: SandboxSpecs;
  state?: SandboxInstanceInfo["state"];
  shared: boolean;
  usage?: SandboxUsage;
  neighbours: SandboxOccupant[];
}

const occupants = new Map<string, Map<string, SandboxOccupant>>();

export function agentSandboxStatus(
  entry: ResolvedAgentSandbox | undefined,
  eventId: string,
): SandboxStatus | undefined {
  const reservationKey = configString(entry?.sandbox.options?.reservationKey);
  if (!entry || entry.sandbox.persistent !== true || !reservationKey) {
    return undefined;
  }

  return {
    name: entry.name,
    provider: entry.sandbox.provider,
    specs: configuredSandboxSpecs(entry.sandbox),
    shared: true,
    neighbours: sandboxNeighbours(reservationKey, eventId),
  };
}

export function formatSandboxStatus(status: SandboxStatus): string[] {
  const disk =
    status.specs?.storageGb === undefined
      ? ""
      : `, ${status.specs.storageGb} GB disk`;
  const specs = status.specs
    ? `, ${status.specs.vcpu} vCPU, ${formatMegabytes(status.specs.memoryMb)} RAM${disk}`
    : "";
  const sharing = status.shared
    ? "shared: other conversations of this agent run on it too, each in its own folder"
    : "isolated: only this conversation runs on it";
  const neighbours =
    status.neighbours.length === 0
      ? "none"
      : `${status.neighbours.length} (${status.neighbours
          .map((one): string => one.agentId ?? "unknown agent")
          .join(", ")})`;

  return [
    `your machine: ${status.name} (${status.provider}${specs}), ${sharing}`,
    ...(status.state === undefined && status.usage === undefined
      ? []
      : [`machine now: ${formatMachineNow(status)}`]),
    `other runs on it now: ${neighbours}`,
    ...(status.shared && status.neighbours.length > 0
      ? [
          "stay in your own folder, leave processes and ports you did not start alone, and expect CPU and memory to be shared",
        ]
      : []),
  ];
}

export function occupySandbox(
  reservationKey: string,
  eventId: string,
  occupant: Omit<SandboxOccupant, "since">,
): () => void {
  const holders = occupants.get(reservationKey) ?? new Map();
  holders.set(eventId, { ...occupant, since: Date.now() });
  occupants.set(reservationKey, holders);

  return (): void => {
    holders.delete(eventId);
    if (holders.size === 0 && occupants.get(reservationKey) === holders) {
      occupants.delete(reservationKey);
    }
  };
}

export function parseSandboxUsage(stdout: string): SandboxUsage {
  const fields = new Map<string, number[]>();
  for (const line of stdout.split("\n")) {
    const [key, ...values] = line.trim().split(/\s+/);
    if (key) fields.set(key, values.map(Number));
  }
  const [cpus] = fields.get("cpus") ?? [];
  const [load1] = fields.get("load") ?? [];
  const [memoryTotalKb, memoryAvailableKb] = fields.get("mem") ?? [];
  const [diskTotalKb, diskUsedKb] = fields.get("disk") ?? [];
  const usage: SandboxUsage = {};
  if (isReading(cpus)) usage.cpus = cpus;
  if (isReading(load1)) usage.load1 = load1;
  if (isReading(memoryTotalKb) && isReading(memoryAvailableKb)) {
    usage.memoryTotalMb = Math.round(memoryTotalKb / 1024);
    usage.memoryUsedMb = Math.round((memoryTotalKb - memoryAvailableKb) / 1024);
  }
  if (isReading(diskTotalKb) && isReading(diskUsedKb)) {
    usage.diskTotalGb = roundTenth(diskTotalKb / 1024 / 1024);
    usage.diskUsedGb = roundTenth(diskUsedKb / 1024 / 1024);
  }

  return usage;
}

export async function reportSandboxUsage(
  session: BroodsSandboxDriverSession,
  onUsage: ((usage: SandboxUsage) => void) | undefined,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!onUsage || abortSignal?.aborted) return;
  const deadline = AbortSignal.timeout(USAGE_TIMEOUT_MS);
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, deadline])
    : deadline;
  try {
    const result = await Promise.race([
      session.runCommand({ command: USAGE_PROBE, abortSignal: signal }),
      new Promise<never>((_, reject): void => {
        signal.addEventListener("abort", (): void => reject(signal.reason), {
          once: true,
        });
      }),
    ]);
    if (result.exitCode === 0) onUsage(parseSandboxUsage(result.stdout));
  } catch {
    // Usage is best effort: the status block goes without it.
  }
}

export function sandboxNeighbours(
  reservationKey: string,
  eventId: string,
): SandboxOccupant[] {
  const holders = occupants.get(reservationKey);
  if (!holders) return [];
  const staleBefore = Date.now() - OCCUPANT_STALE_MS;
  for (const [id, one] of holders) {
    if (one.since <= staleBefore) holders.delete(id);
  }
  if (holders.size === 0) occupants.delete(reservationKey);

  return [...holders.entries()]
    .filter(([id]): boolean => id !== eventId)
    .map(([, one]): SandboxOccupant => one)
    .sort((a, b): number => a.since - b.since);
}

function formatMachineNow(status: SandboxStatus): string {
  const usage = status.usage;
  const parts: string[] = [status.state ?? "running"];
  if (usage?.load1 !== undefined) {
    parts.push(
      `load ${usage.load1} on ${usage.cpus ?? "?"} CPU${usage.cpus === 1 ? "" : "s"}`,
    );
  }
  if (usage?.memoryUsedMb !== undefined) {
    parts.push(`RAM ${usage.memoryUsedMb} of ${usage.memoryTotalMb} MB used`);
  }
  if (usage?.diskUsedGb !== undefined) {
    parts.push(`disk ${usage.diskUsedGb} of ${usage.diskTotalGb} GB used`);
  }

  return parts.join(", ");
}

function formatMegabytes(megabytes: number): string {
  return megabytes >= 1024 ? `${megabytes / 1024} GB` : `${megabytes} MB`;
}

function isReading(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Live state of the machine a run works on, for the <environment> block: its size,
 * whether it is up, what the guest reports for CPU, memory and disk, and which other
 * runs hold it right now. Occupancy is in memory because core runs one replica. The
 * lines are built per run and ride after the cached prompt prefix, never in it.
 */

import type { BroodsSandboxDriverSession } from "@broods/ai-sdk-sandbox";
import { createSandboxExecutor } from "./index.ts";
import type { SandboxInstanceInfo } from "./types.ts";
import { configString } from "./utils.ts";
import type { SandboxSpecs } from "../../shared/sandbox-sizes.ts";
import type { ResolvedAgentSandbox } from "../../shared/workspaces.ts";

// A run that never settled (a crashed pod keeps nothing, but a leaked entry would
// read as a neighbour forever) stops counting after this long.
const OCCUPANT_STALE_MS = 6 * 60 * 60 * 1000;
// Reading the provider state or probing the guest must not hold a turn up when
// either is slow; past this the status goes without that part.
const STATE_TIMEOUT_MS = 2_000;
const USAGE_TIMEOUT_MS = 3_000;
// One exec, one fixed key per line, so a missing tool only blanks its own field.
const USAGE_PROBE = [
  'echo "cpus $(nproc 2>/dev/null)"',
  "echo \"load $(cut -d' ' -f1 /proc/loadavg 2>/dev/null)\"",
  "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print \"mem\", t, a}' /proc/meminfo 2>/dev/null",
  "df -Pk / 2>/dev/null | awk 'NR==2{print \"disk\", $2, $3}'",
].join("; ");

/** What the guest reported about itself. Every field is absent when it could not be read. */
export interface SandboxUsage {
  cpus?: number;
  diskTotalGb?: number;
  diskUsedGb?: number;
  load1?: number;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
}

/** One run holding a machine. */
export interface SandboxOccupant {
  agentId?: string;
  conversationKey: string;
  since: number;
}

export interface SandboxStatus {
  name: string;
  provider: string;
  specs?: SandboxSpecs;
  /** `undefined` when the provider was not asked, `null` when nothing is reserved yet. */
  state?: SandboxInstanceInfo["state"] | null;
  /** Whether other conversations may land on the same machine. */
  shared: boolean;
  usage?: SandboxUsage;
  /** The other runs on it, this one excluded. */
  neighbours: SandboxOccupant[];
}

const occupants = new Map<string, Map<string, SandboxOccupant>>();

/**
 * Status of the persistent sandbox a bash-only run defaults to, read without
 * waking it. Undefined when that sandbox reserves nothing.
 */
export async function agentSandboxStatus(
  entry: ResolvedAgentSandbox | undefined,
  eventId: string,
): Promise<SandboxStatus | undefined> {
  const reservationKey = configString(entry?.sandbox.options?.reservationKey);
  if (!entry || entry.sandbox.persistent !== true || !reservationKey) {
    return undefined;
  }
  const executor = createSandboxExecutor(entry.sandbox);
  const info = executor.getInstanceInfo
    ? await Promise.race([
        executor.getInstanceInfo({ reservationKey: reservationKey }),
        new Promise<undefined>((resolve): void => {
          setTimeout(resolve, STATE_TIMEOUT_MS).unref();
        }),
      ]).catch((): undefined => undefined)
    : undefined;

  return {
    name: entry.name,
    provider: entry.sandbox.provider,
    specs: entry.sandbox.controlPlane?.specs,
    state: info === undefined ? undefined : (info?.state ?? null),
    shared: true,
    neighbours: sandboxNeighbours(reservationKey, eventId),
  };
}

/** The <environment> lines for one machine. */
export function formatSandboxStatus(status: SandboxStatus): string[] {
  const specs = status.specs
    ? `, ${status.specs.vcpu} vCPU, ${formatMegabytes(status.specs.memoryMb)} RAM, ${status.specs.storageGb} GB disk`
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

/**
 * Registers a run on a machine until the returned release is called. The same
 * event registering twice replaces its own entry.
 */
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

/** Parses the probe's `key value...` lines. Exported for tests. */
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

/**
 * Runs the usage probe on a freshly acquired harness session and hands the
 * result over. Best effort and bounded: a failed, slow or cancelled probe only
 * leaves the usage out, and the caller checks its own signal afterwards.
 */
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
    // The status block just goes without usage.
  }
}

/** The runs on a machine other than `eventId`, oldest first. */
export function sandboxNeighbours(
  reservationKey: string,
  eventId: string,
): SandboxOccupant[] {
  const holders = occupants.get(reservationKey);
  if (!holders) return [];
  // A run that never released is dropped here, so leaked entries cannot pile up.
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
  const state =
    status.state === null
      ? "not created yet, the first bash call boots it"
      : (status.state ?? "running");
  const parts = [state];
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

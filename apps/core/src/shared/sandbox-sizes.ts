/**
 * Predefined sandbox sizes — the canonical (vcpu, memoryMb, storageGb) catalog
 * shared by sandbox config validation, the workdir resource mapping, and the
 * Convex `sandboxInstances` mirror. Sizes are the user-facing knob (`config.size`)
 * that reconciles issue #78's tiers with each backend's real limits.
 *
 * The specs are canonical/advisory: workdir applies them as create-time resources
 * (clamping vcpu to its allowed set); MicroVM bakes size into the image so the
 * specs are display-only there; daytona/e2b/vercel size natively. The control-plane
 * mirror type lives here too so the Convex writer and the executors share one shape
 * without importing across the _shared/harness boundary.
 */

import type { SandboxNetworkMode, SandboxPermissionMode } from "./storage/sandbox-config.ts";

export type SandboxSize = "tiny" | "xsmall" | "small" | "medium" | "large";

/** Compute footprint of a sandbox instance, mirrored into Convex for the dashboard. */
export interface SandboxSpecs {
  vcpu: number;
  memoryMb: number;
  storageGb: number;
}

/** Non-secret execution ownership metadata mirrored for dashboard diagnostics. */
export interface SandboxRunMetadata {
  traceId?: string;
  taskId?: string;
  agentId?: string;
  conversationKey?: string;
  workspaceName?: string;
  workspaceId?: string;
}

/**
 * Canonical size catalog. Free tier = `tiny` + `xsmall` (quota enforcement is a
 * later usage workstream); `small`+ are paid. Disk is fixed per size to stay valid
 * on both self-hosted backends (workdir disk ∈ {8,16,32,64}; MicroVM disk is fixed).
 */
export const SANDBOX_SIZES: Record<SandboxSize, SandboxSpecs> = {
  tiny: { vcpu: 0.25, memoryMb: 512, storageGb: 8 },
  xsmall: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
  small: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
  medium: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
  large: { vcpu: 4, memoryMb: 8192, storageGb: 32 },
};

export const SANDBOX_SIZE_NAMES: readonly SandboxSize[] = ["tiny", "xsmall", "small", "medium", "large"];

/** The size used for the mirror specs when a config pins no explicit size or resources. */
const DEFAULT_SIZE: SandboxSize = "xsmall";

/** vcpu values workdir accepts; the catalog's `tiny` (0.25) clamps up to 0.5. */
const WORKDIR_CPU_CHOICES: readonly number[] = [0.5, 1, 2, 4];

/**
 * Control-plane metadata threaded from the runtime resolver to an executor so a
 * freshly reserved sandbox can mirror itself into the Convex `sandboxInstances`
 * registry. Absent for synthetic/stateless configs (the mirror then no-ops).
 */
export interface SandboxControlPlane {
  accountId: string;
  /** Optional SaaS route scope for dashboard live views. */
  projectId?: string;
  environmentId?: string;
  /** The owning sandbox config row, so the dashboard can drive its write-path. */
  sandboxConfigId?: string;
  name: string;
  specs: SandboxSpecs;
  /** Snapshot/image the instance launched from, when pinned. */
  snapshotId?: string;
  /** Non-secret egress policy (config `network.mode`), mirrored for the dashboard Networking view. */
  egress?: SandboxNetworkMode;
  /** Tool approval policy (`edit`/`ask`/`bypass`), mirrored for the dashboard Security view. */
  permissionMode?: SandboxPermissionMode;
}

/**
 * Resolve the specs to mirror for a sandbox config. A pinned `size` wins; otherwise
 * the explicit workdir resource options (`cpu`/`memoryMb`/`diskGb`) and
 * `memoryLimit` fill in, defaulting each missing dimension from the `xsmall` row.
 * @param input the size + raw provider options + memory limit from the config.
 * @returns the canonical specs.
 */
export function resolveSandboxSpecs(input: {
  size?: SandboxSize;
  options?: Record<string, unknown>;
  memoryLimit?: number;
}): SandboxSpecs {
  if (input.size) {
    return SANDBOX_SIZES[input.size];
  }
  const base = SANDBOX_SIZES[DEFAULT_SIZE];
  const options = input.options ?? {};
  return {
    vcpu: numberOrUndefined(options.cpu) ?? base.vcpu,
    memoryMb: numberOrUndefined(options.memoryMb) ?? input.memoryLimit ?? base.memoryMb,
    storageGb: numberOrUndefined(options.diskGb) ?? base.storageGb,
  };
}

/**
 * Workdir create-time resources for a pinned size, clamping vcpu up to the nearest
 * value workdir accepts.
 * @param size the pinned sandbox size.
 * @returns the cpu/memoryMb/diskGb to request from workdir.
 */
export function workdirSizeResources(size: SandboxSize): { cpu: number; memoryMb: number; diskGb: number } {
  const specs = SANDBOX_SIZES[size];
  const cpu = WORKDIR_CPU_CHOICES.find((choice) => choice >= specs.vcpu) ?? WORKDIR_CPU_CHOICES[WORKDIR_CPU_CHOICES.length - 1]!;

  return { cpu, memoryMb: specs.memoryMb, diskGb: specs.storageGb };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

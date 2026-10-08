/**
 * Predefined sandbox sizes, the canonical (vcpu, memoryMb, storageGb) catalog
 * shared by sandbox config validation, the workdir resource mapping, and the
 * Convex `sandboxInstances` mirror. `config.size` is the user-facing knob that
 * reconciles issue #78's tiers with each backend's real limits.
 *
 * The specs are advisory: workdir applies them as create-time resources (clamping
 * vcpu to its allowed set), cloudflare starts the nearest instance type, a lambda
 * MicroVM always reports the one size AWS gives it, and daytona/e2b/vercel size
 * natively, so their executors mirror the size the provider reports instead.
 * The control-plane mirror type lives here too so the Convex writer and the
 * executors share one shape without importing across the shared/harness boundary.
 */

import type {
  SandboxNetworkMode,
  SandboxPermissionMode,
  SandboxProvider,
} from "./domain/sandbox-config.ts";

export type SandboxSize = "tiny" | "xsmall" | "small" | "medium" | "large";

/**
 * Compute footprint of a sandbox instance, mirrored into Convex for the dashboard.
 * `storageGb` is absent when the provider does not report its disk (e2b, vercel).
 */
export interface SandboxSpecs {
  vcpu: number;
  memoryMb: number;
  storageGb?: number;
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
 * Control-plane metadata threaded from the runtime resolver to an executor so a
 * freshly reserved sandbox can mirror itself into the Convex `sandboxInstances`
 * registry. Absent for synthetic/stateless configs (the mirror then no-ops).
 */
export interface SandboxControlPlane {
  accountId: string;
  /** Optional SaaS route scope for dashboard live views. */
  projectId?: string;
  stageId?: string;
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
  /** The account's own provider credentials pay for it, so the platform does not meter it. */
  ownCredentials?: true;
  /** Idle seconds before the sweeper releases the reservation; unset keeps the 7-day default. */
  releaseAfterIdleSeconds?: number;
  /** Idle seconds before the provider suspends it, which is how long it is billed idle. */
  idleTimeoutSeconds?: number;
}

/**
 * Canonical size catalog. Free tier = `tiny` + `xsmall` (quota enforcement is a
 * later usage workstream); `small`+ are paid. Disk is fixed per size to stay valid
 * on both self-hosted backends (workdir disk ∈ {8,16,32,64}; MicroVM disk is fixed).
 */
export const SANDBOX_SIZES: Record<SandboxSize, Required<SandboxSpecs>> = {
  tiny: { vcpu: 0.25, memoryMb: 512, storageGb: 8 },
  xsmall: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
  small: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
  medium: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
  large: { vcpu: 4, memoryMb: 8192, storageGb: 32 },
};

export const SANDBOX_SIZE_NAMES: readonly SandboxSize[] = [
  "tiny",
  "xsmall",
  "small",
  "medium",
  "large",
];

/**
 * Cloudflare's named instance type nearest each size, with its documented specs
 * (developers.cloudflare.com/containers/platform/limits). A custom type needs a
 * whole vCPU, so the small sizes take `standard-1`.
 */
export const CLOUDFLARE_INSTANCE_TYPES: Record<
  SandboxSize,
  { name: string; specs: Required<SandboxSpecs> }
> = {
  tiny: {
    name: "standard-1",
    specs: { vcpu: 0.5, memoryMb: 4096, storageGb: 8 },
  },
  xsmall: {
    name: "standard-1",
    specs: { vcpu: 0.5, memoryMb: 4096, storageGb: 8 },
  },
  small: {
    name: "standard-2",
    specs: { vcpu: 1, memoryMb: 6144, storageGb: 12 },
  },
  medium: {
    name: "standard-3",
    specs: { vcpu: 2, memoryMb: 8192, storageGb: 16 },
  },
  large: {
    name: "standard-4",
    specs: { vcpu: 4, memoryMb: 12288, storageGb: 20 },
  },
};

// What every lambda MicroVM runs as: the images ask AWS for no size, so each gets
// the platform default, a 2 GB baseline that bursts to 4 vCPU and 8 GB, on an 8 GB disk.
const MICROVM_SPECS: SandboxSpecs = { vcpu: 4, memoryMb: 8192, storageGb: 8 };

/**
 * Providers whose machine is the size resolveSandboxSpecs derives: workdir creates
 * the VM with those resources, a MicroVM is one fixed size, and cloudflare starts
 * that instance type. Anywhere else the derived size is only a guess (it is what
 * the meter bills when a provider reports nothing), so it is never shown as fact.
 */
export const KNOWN_SIZE_PROVIDERS: ReadonlySet<SandboxProvider> = new Set([
  "cloudflare",
  "lambda",
  "sandbox",
]);

/** The size used for the mirror specs when a config pins no explicit size or resources. */
const DEFAULT_SIZE: SandboxSize = "xsmall";

/** vcpu values workdir accepts; the catalog's `tiny` (0.25) clamps up to 0.5. */
const WORKDIR_CPU_CHOICES: readonly number[] = [0.5, 1, 2, 4];

// The size each reserved sandbox's provider last reported, by reservation key, so
// the agent's status line names the same size as the dashboard row.
const REPORTED_SPECS = new Map<string, SandboxSpecs>();

/**
 * The size a reserved sandbox really has, for the agent's status line: what its
 * provider reported, else the derived size where that is what the machine gets.
 * Undefined whenever the size is not known to be true.
 */
export function knownSandboxSpecs(
  provider: SandboxProvider,
  reservationKey: string | undefined,
  configSpecs: SandboxSpecs | undefined,
): SandboxSpecs | undefined {
  const reported = reservationKey
    ? REPORTED_SPECS.get(reservationKey)
    : undefined;
  if (reported) return reported;

  return KNOWN_SIZE_PROVIDERS.has(provider) ? configSpecs : undefined;
}

/**
 * Remembers what a reserved sandbox's provider reported, or with no specs forgets
 * it. The instance mirror calls it on reserve and on remove.
 */
export function rememberReportedSpecs(
  reservationKey: string,
  specs: SandboxSpecs | undefined,
): void {
  if (specs) {
    REPORTED_SPECS.set(reservationKey, specs);
  } else {
    REPORTED_SPECS.delete(reservationKey);
  }
}

/**
 * Resolve the specs to mirror (and bill) for a sandbox config. A workdir (`sandbox`)
 * config bills exactly the resources its VM is created with (see workdirResources),
 * a cloudflare config the instance type it starts, and a lambda config reports the
 * MicroVM's real size whatever it asks for. Daytona, e2b and vercel executors
 * replace these with what the provider reports once the machine exists.
 * Elsewhere a pinned `size` wins; otherwise the explicit resource options
 * (`cpu`/`memoryMb`/`diskGb`) and `memoryLimit` fill in. Each missing dimension
 * defaults from the `xsmall` row.
 * @param input the provider, size, raw provider options and memory limit from the config.
 * @returns the canonical specs.
 */
export function resolveSandboxSpecs(input: {
  provider?: SandboxProvider;
  size?: SandboxSize;
  options?: Record<string, unknown>;
  memoryLimit?: number;
}): SandboxSpecs {
  const base = SANDBOX_SIZES[DEFAULT_SIZE];
  if (input.provider === "sandbox") {
    const resources = workdirResources(input);

    return {
      vcpu: resources?.cpu ?? base.vcpu,
      memoryMb: resources?.memoryMb ?? base.memoryMb,
      storageGb: resources?.diskGb ?? base.storageGb,
    };
  }
  if (input.provider === "lambda") {
    return MICROVM_SPECS;
  }
  if (input.provider === "cloudflare") {
    return CLOUDFLARE_INSTANCE_TYPES[input.size ?? DEFAULT_SIZE].specs;
  }
  if (input.size) {
    return SANDBOX_SIZES[input.size];
  }
  const options = input.options ?? {};

  return {
    vcpu: positiveNumber(options.cpu) ?? base.vcpu,
    memoryMb:
      positiveNumber(options.memoryMb) ?? input.memoryLimit ?? base.memoryMb,
    storageGb: positiveNumber(options.diskGb) ?? base.storageGb,
  };
}

/**
 * Workdir create-time resources for a config, used by the workdir executor to size
 * the VM and by resolveSandboxSpecs to bill it. A pinned size seeds the dimensions
 * (vcpu clamped to workdir's allowed set); explicit cpu/memoryMb/diskGb options and
 * `memoryLimit` still win over the size defaults.
 * @returns the cpu/memoryMb/diskGb to request, or undefined when none is set.
 */
export function workdirResources(input: {
  size?: SandboxSize;
  options?: Record<string, unknown>;
  memoryLimit?: number;
}): { cpu?: number; memoryMb?: number; diskGb?: number } | undefined {
  const options = input.options ?? {};
  const sized = input.size ? workdirSizeResources(input.size) : undefined;
  const cpu = positiveNumber(options.cpu) ?? sized?.cpu;
  const memoryMb =
    positiveNumber(options.memoryMb) ?? input.memoryLimit ?? sized?.memoryMb;
  const diskGb = positiveNumber(options.diskGb) ?? sized?.diskGb;
  if (cpu === undefined && memoryMb === undefined && diskGb === undefined)
    return undefined;

  return {
    ...(cpu !== undefined ? { cpu: cpu } : {}),
    ...(memoryMb !== undefined ? { memoryMb: memoryMb } : {}),
    ...(diskGb !== undefined ? { diskGb: diskGb } : {}),
  };
}

/**
 * Workdir create-time resources for a pinned size, clamping vcpu up to the nearest
 * value workdir accepts.
 * @param size the pinned sandbox size.
 * @returns the cpu/memoryMb/diskGb to request from workdir.
 */
export function workdirSizeResources(size: SandboxSize): {
  cpu: number;
  memoryMb: number;
  diskGb: number;
} {
  const specs = SANDBOX_SIZES[size];
  const cpu =
    WORKDIR_CPU_CHOICES.find((choice) => choice >= specs.vcpu) ??
    WORKDIR_CPU_CHOICES[WORKDIR_CPU_CHOICES.length - 1]!;

  return { cpu: cpu, memoryMb: specs.memoryMb, diskGb: specs.storageGb };
}

// Zero or negative reads as unset, so a bad option can neither bill nothing nor
// ask a provider for no resources.
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

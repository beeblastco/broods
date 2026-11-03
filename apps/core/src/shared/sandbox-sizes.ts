import type {
  SandboxNetworkMode,
  SandboxPermissionMode,
  SandboxProvider,
} from "./domain/sandbox-config.ts";

export type SandboxSize = "tiny" | "xsmall" | "small" | "medium" | "large";

export interface SandboxSpecs {
  vcpu: number;
  memoryMb: number;
  storageGb?: number;
}

// Mirrored to the dashboard: never a secret.
export interface SandboxRunMetadata {
  traceId?: string;
  taskId?: string;
  agentId?: string;
  conversationKey?: string;
  workspaceName?: string;
  workspaceId?: string;
}

export interface SandboxControlPlane {
  accountId: string;
  projectId?: string;
  stageId?: string;
  sandboxConfigId?: string;
  name: string;
  specs: SandboxSpecs;
  snapshotId?: string;
  egress?: SandboxNetworkMode;
  permissionMode?: SandboxPermissionMode;
  ownCredentials?: true;
  releaseAfterIdleSeconds?: number;
  idleTimeoutSeconds?: number;
}

// Every disk must stay in workdir's allowed set {8, 16, 32, 64}.
export const SANDBOX_SIZES: Record<SandboxSize, Required<SandboxSpecs>> = {
  tiny: { vcpu: 0.25, memoryMb: 512, storageGb: 8 },
  xsmall: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
  small: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
  medium: { vcpu: 2, memoryMb: 4096, storageGb: 16 },
  large: { vcpu: 4, memoryMb: 8192, storageGb: 32 },
};

// A custom Cloudflare type needs a whole vCPU, so the small sizes take `standard-1`.
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

// The images ask AWS for no size: the default is a 2 GB baseline bursting to 4 vCPU / 8 GB.
const MICROVM_SPECS: SandboxSpecs = { vcpu: 4, memoryMb: 8192, storageGb: 8 };

const WORKER_SPECS: SandboxSpecs = { vcpu: 1, memoryMb: 128, storageGb: 0 };

// Keep in step with resolveSandboxSpecs: for these, its specs are the machine's real size.
export const CONFIGURED_SIZE_PROVIDERS: ReadonlySet<SandboxProvider> = new Set([
  "cloudflare",
  "lambda",
  "sandbox",
]);

const DEFAULT_SIZE: SandboxSize = "xsmall";

const WORKDIR_CPU_CHOICES: readonly number[] = [0.5, 1, 2, 4];

// For daytona, e2b and vercel this is a guess: their executors mirror what the provider reports.
export function resolveSandboxSpecs(input: {
  provider?: SandboxProvider;
  size?: SandboxSize;
  options?: Record<string, unknown>;
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
  if (input.provider === "worker") {
    return WORKER_SPECS;
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
    memoryMb: positiveNumber(options.memoryMb) ?? base.memoryMb,
    storageGb: positiveNumber(options.diskGb) ?? base.storageGb,
  };
}

export function workdirResources(input: {
  size?: SandboxSize;
  options?: Record<string, unknown>;
}): { cpu?: number; memoryMb?: number; diskGb?: number } | undefined {
  const options = input.options ?? {};
  const sized = input.size ? workdirSizeResources(input.size) : undefined;
  const cpu = positiveNumber(options.cpu) ?? sized?.cpu;
  const memoryMb = positiveNumber(options.memoryMb) ?? sized?.memoryMb;
  const diskGb = positiveNumber(options.diskGb) ?? sized?.diskGb;
  if (cpu === undefined && memoryMb === undefined && diskGb === undefined)
    return undefined;

  return {
    ...(cpu !== undefined ? { cpu: cpu } : {}),
    ...(memoryMb !== undefined ? { memoryMb: memoryMb } : {}),
    ...(diskGb !== undefined ? { diskGb: diskGb } : {}),
  };
}

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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

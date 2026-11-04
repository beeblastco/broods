// A leaf on purpose: schema.ts imports it without the rules' import graph.

export const SANDBOX_PROVIDERS = [
  "sandbox",
  "lambda",
  "e2b",
  "daytona",
  "vercel",
  "cloudflare",
  "worker",
  "machine",
  "custom",
] as const;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

export const STATELESS_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["machine", "custom"]);

export const PLATFORM_WORKER_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["cloudflare", "worker"]);

export const SNAPSHOT_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda", "daytona", "e2b", "vercel"]);

const ALWAYS_S3_MOUNT_PROVIDERS: ReadonlySet<string> = new Set<SandboxProvider>(
  ["lambda", "sandbox", "vercel"],
);
// Opt-in only: the Daytona snapshot must ship mount-s3.
const OPT_IN_S3_MOUNT_PROVIDERS: ReadonlySet<string> = new Set<SandboxProvider>(
  ["daytona"],
);
// daytona reads it to opt in, the workdir sandbox to mount even with no workspace named.
export const MOUNT_FLAG_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["daytona", "sandbox"]);
export const S3_MOUNT_PROVIDER_HINT = `${[...ALWAYS_S3_MOUNT_PROVIDERS].join("/")}, or ${[...OPT_IN_S3_MOUNT_PROVIDERS].join(" or ")} with options.mountAwsS3Buckets: true`;

// A mount-s3 FUSE workspace has no rename or append.
export const S3_MOUNT_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["daytona", "lambda", "sandbox", "vercel"]);

export function supportsS3WorkspaceMount(
  provider: string,
  options: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (ALWAYS_S3_MOUNT_PROVIDERS.has(provider)) return true;

  return (
    OPT_IN_S3_MOUNT_PROVIDERS.has(provider) &&
    options?.mountAwsS3Buckets === true
  );
}

// The Worker keeps one R2 disk per sandbox id, so a persistent one is a disk per workspace folder.
export const DISK_WORKSPACE_HINT =
  'a "disk" workspace lives on its sandbox\'s own disk: give it a worker sandbox with persistent: true';

/** Whether this sandbox can back a workspace on `storage` ("s3" mounts, "disk" is its own disk). */
export function sandboxHoldsWorkspace(
  storage: string | undefined,
  sandbox: {
    provider: string;
    persistent?: unknown;
    options?: Readonly<Record<string, unknown>> | undefined;
  },
): boolean {
  if (storage === "disk")
    return sandbox.provider === "worker" && sandbox.persistent === true;

  return supportsS3WorkspaceMount(sandbox.provider, sandbox.options);
}

// just-bash: builtins only, so no `node` and no `sync`; the file tools compute in core there.
export const SHELL_ONLY_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["worker"]);

export const SUSPEND_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda"]);

export const LIVE_TERMINAL_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda", "cloudflare"]);

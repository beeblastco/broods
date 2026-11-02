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

export const SUSPEND_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda"]);

export const LIVE_TERMINAL_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda", "cloudflare"]);

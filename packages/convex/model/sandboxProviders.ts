/**
 * The sandbox provider list: the one list the schema validator, the config
 * rules, core's executor registry and the SDK derive from. A leaf on purpose,
 * so `schema.ts` can read it without pulling the rules' import graph.
 */

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

// Providers Broods never reserves, sizes or snapshots: a machine is the user's
// computer and a custom server is one POST per run. Neither backs a workspace
// or can be a fallback, since what reaches them lives outside the config.
export const STATELESS_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["machine", "custom"]);

// Providers the platform runs on its own Cloudflare account, so a config
// carries no credentials for them and only the options every provider shares.
// Their egress is on or off: `restricted` has nothing to enforce it.
export const PLATFORM_WORKER_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["cloudflare", "worker"]);

// Providers whose `snapshot` names what a sandbox boots from, in the provider's
// own format: sandbox a workdir image, lambda a MicroVM image ARN, daytona a
// Daytona snapshot, e2b an E2B template or snapshot, vercel a Vercel image or a
// `snap_` snapshot id. Their executors implement `snapshot()`, which the
// Snapshot action captures with. A snapshot boots only on the provider that made it.
export const SNAPSHOT_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda", "daytona", "e2b", "vercel"]);

// Providers whose workspace is a mount-s3 FUSE mount, which has no rename or append.
export const S3_MOUNT_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["daytona", "lambda", "sandbox"]);

// Providers core can suspend and resume: their executors implement `suspend()`
// and `resume()`. The rest stop after their idle window or on Terminate.
export const SUSPEND_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda"]);

// Providers core opens a live PTY for: workdir (`sandbox`) over its in-guest
// WebSocket, AWS MicroVM (`lambda`) over its shell endpoint, and the
// Cloudflare bridge in its Container. The rest keep the bounded `exec` runner.
export const LIVE_TERMINAL_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["sandbox", "lambda", "cloudflare"]);

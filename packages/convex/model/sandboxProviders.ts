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
  "machine",
  "custom",
] as const;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

// Providers Broods never reserves, sizes or snapshots: a machine is the user's
// computer and a custom server is one POST per run. Neither backs a workspace
// or can be a fallback, since what reaches them lives outside the config.
export const STATELESS_SANDBOX_PROVIDERS: ReadonlySet<SandboxProvider> =
  new Set<SandboxProvider>(["machine", "custom"]);

// Providers whose `snapshot` names what a sandbox boots from, in the provider's
// own format (workdir image, MicroVM image ARN, Daytona snapshot, E2B template,
// Vercel image or snapshot id), and whose running instance the Snapshot action
// captures into one. A snapshot boots only on the provider that made it.
export const SNAPSHOT_SANDBOX_PROVIDERS: ReadonlySet<string> =
  new Set<SandboxProvider>(["sandbox", "lambda", "daytona", "e2b", "vercel"]);

/**
 * Canonical CLI manifest wire types, the single source of truth shared by the
 * backend (cliSync.ts, cliHttp.ts) and the SDK/CLI (packages/broods).
 *
 * This file is intentionally type-only with no runtime imports so the SDK can
 * import it without pulling the Convex server module graph into its typecheck.
 */

export type CliManifestResource = {
  kind:
    | "agent"
    | "workspace"
    | "sandbox"
    | "cron"
    | "skill"
    | "hook"
    | "mcp"
    | "policy"
    | "channelRecord";
  name: string;
  description?: string;
  config: unknown;
};

export type GeneratedIds = {
  agents: Record<string, string>;
  workspaces: Record<string, string>;
  sandboxes: Record<string, string>;
  crons: Record<string, string>;
  skills: Record<string, string>;
  hooks: Record<string, string>;
  mcp: Record<string, string>;
  policies: Record<string, string>;
  channelRecords: Record<string, string>;
};

/** Where a Production stage runs. */
export type DeploymentRegion = "ap-southeast-1" | "eu-west-1" | "us-east-1";

export type CliManifest = {
  version: 1;
  project: string;
  stage: string;
  /**
   * Production only: the region its first deploy pins (eu-west-1 when unset).
   * A later deploy naming another region is refused.
   */
  region?: DeploymentRegion;
  resources: CliManifestResource[];
};

// CLI manifest wire types shared with packages/broods. No runtime imports, so the SDK
// typecheck never pulls in the Convex server module graph.

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

export const DEPLOYMENT_REGIONS = [
  "ap-southeast-1",
  "eu-west-1",
  "us-east-1",
] as const;
export type DeploymentRegion = (typeof DEPLOYMENT_REGIONS)[number];
/** The first is the default. */
export const LIVE_DEPLOYMENT_REGIONS: readonly DeploymentRegion[] = [
  "eu-west-1",
];

export type CliManifest = {
  version: 1;
  project: string;
  stage: string;
  /** Production only: pinned by the first deploy; a later deploy naming another is refused. */
  region?: DeploymentRegion;
  resources: CliManifestResource[];
};

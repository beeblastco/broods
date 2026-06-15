/**
 * Canonical CLI manifest wire types — the single source of truth shared by the
 * backend (cliSync.ts, cliHttp.ts) and the SDK/CLI (packages/filthy-panty).
 *
 * This file is intentionally type-only with no runtime imports so the SDK can
 * import it without pulling the Convex server module graph into its typecheck.
 */

export type CliManifestResource = {
    kind: "agent" | "workspace" | "sandbox" | "cron" | "skill" | "tool";
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
    tools: Record<string, string>;
};

export type CliManifest = {
    version: 1;
    project: string;
    environment: string;
    resources: CliManifestResource[];
};

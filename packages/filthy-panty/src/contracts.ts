/**
 * Type contracts inherited from Convex and core storage/runtime modules.
 * Keep this file type-only so the public SDK does not bundle backend code.
 */

import type { Doc, Id } from "../../convex/_generated/dataModel";
import type {
  AgentConfig,
  AgentWorkspaceRef,
  CreateCronJobInput,
  SandboxConfig,
  WorkspaceConfig,
} from "../../../apps/core/functions/_shared/storage/index.ts";

export type {
  AgentConfig,
  AgentWorkspaceRef,
  CreateCronJobInput,
  Doc,
  Id,
  SandboxConfig,
  WorkspaceConfig,
};

export type ProjectDoc = Doc<"projects">;
export type EnvironmentDoc = Doc<"environments">;
export type AgentConfigDoc = Doc<"agentConfigs">;
export type WorkspaceConfigDoc = Doc<"workspaceConfigs">;
export type SandboxConfigDoc = Doc<"sandboxConfigs">;
export type CronJobDoc = Doc<"cronJobs">;

export type CliResourceKind = "agent" | "workspace" | "sandbox" | "cronJob";

export interface CliManifestResource {
  kind: CliResourceKind;
  name: string;
  description?: string;
  config: unknown;
}

export interface CliManifest {
  version: 1;
  project: string;
  environment: string;
  resources: CliManifestResource[];
}

export interface GeneratedIds {
  agents: Record<string, string>;
  workspaces: Record<string, string>;
  sandboxes: Record<string, string>;
  cronJobs: Record<string, string>;
}

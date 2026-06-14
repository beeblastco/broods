/**
 * Resource definition helpers for the code-first `filthypanty/` project folder.
 */

import type {
  AgentConfig,
  CreateCronJobInput,
  SandboxConfig,
  WorkspaceConfig,
} from "./contracts.ts";

const RESOURCE_MARKER = Symbol.for("filthy-panty.resource");
const CONFIG_MARKER = Symbol.for("filthy-panty.config");

export interface EnvRef<Name extends string = string> {
  readonly __beeblastEnv: true;
  readonly name: Name;
}

export interface FilthyPantyProjectConfig {
  project?: string;
  environments?: {
    dev?: string;
    deploy?: string;
    [name: string]: string | undefined;
  };
  dashboardUrl?: string;
}

export interface FilthyPantyConfigDefinition {
  readonly [CONFIG_MARKER]: true;
  readonly config: FilthyPantyProjectConfig;
}

export type ResourceKind = "agent" | "workspace" | "sandbox" | "cronJob" | "skill" | "tool";

export interface ResourceDefinition<
  Kind extends ResourceKind,
  Name extends string,
  Config,
> {
  readonly [RESOURCE_MARKER]: true;
  readonly kind: Kind;
  readonly name: Name;
  readonly description?: string;
  readonly config: Config;
}

export type WorkspaceResource<Name extends string = string> = ResourceDefinition<"workspace", Name, WorkspaceConfig>;
export type SandboxResource<Name extends string = string> = ResourceDefinition<"sandbox", Name, SandboxConfig>;
export type SkillResource<Name extends string = string> = ResourceDefinition<"skill", Name, SkillDefinitionConfig>;
export type ToolResource<Name extends string = string> = ResourceDefinition<"tool", Name, ToolDefinitionConfig>;

export interface SkillDefinitionConfig {
  /**
   * Folder containing SKILL.md plus optional scripts/assets. Relative paths are
   * resolved from the `filthypanty/` project directory.
   */
  path: string;
}

export interface ToolDefinitionConfig {
  /**
   * JavaScript module file exporting the custom tool bundle. Relative paths are
   * resolved from the `filthypanty/` project directory.
   */
  path: string;
  description: string;
  inputSchema: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
}

/**
 * Per-agent workspace mount with an optional sandbox override. A bare
 * `defineWorkspace(...)` inherits the agent-level sandbox; the object form lets
 * a single workspace pin its own sandbox, or set `sandbox: null` to force the
 * workspace read-only (no compute attached).
 */
export interface AgentWorkspaceRefInput {
  workspace: WorkspaceResource | string;
  sandbox?: SandboxResource | string | null;
}

export type AgentWorkspaceInput = WorkspaceResource | AgentWorkspaceRefInput;

/**
 * `subagent` block where `allowed` may reference other `defineAgent(...)`
 * resources directly; the compiler rewrites them to agent names and the backend
 * resolves those to deploy-time agent ids.
 */
export type AgentSubagentDefinitionConfig = Omit<NonNullable<AgentConfig["subagent"]>, "allowed"> & {
  allowed?: readonly (AgentResource | string)[];
};

export type AgentSkillsDefinitionConfig = Omit<NonNullable<AgentConfig["skills"]>, "allowed"> & {
  allowed?: readonly (SkillResource | string)[];
};

/**
 * Code-first agent config surface. Built from an explicit `Pick` of `AgentConfig`
 * (not `Omit`) so the SDK input type does NOT inherit `AgentConfig`'s
 * `[key: string]: unknown` index signature — which would otherwise disable
 * TypeScript's excess-property checks and silently accept typos like
 * `workspace:` instead of `workspaces:`. Add a key here when core's `AgentConfig`
 * gains a new top-level field that should be code-definable.
 */
export type AgentDefinitionConfig =
  & Pick<AgentConfig, "agent" | "model" | "provider" | "session" | "hooks" | "channels" | "tools">
  & {
    sandbox?: SandboxResource | string;
    workspaces?: readonly AgentWorkspaceInput[];
    subagent?: AgentSubagentDefinitionConfig;
    skills?: AgentSkillsDefinitionConfig;
  };

export type AgentResource<Name extends string = string> = ResourceDefinition<"agent", Name, AgentDefinitionConfig>;

export type CronJobDefinitionConfig = Omit<CreateCronJobInput, "agentId" | "name"> & {
  agent: AgentResource | string;
};

export type CronJobResource<Name extends string = string> = ResourceDefinition<"cronJob", Name, CronJobDefinitionConfig>;

export type AnyResource =
  | AgentResource
  | WorkspaceResource
  | SandboxResource
  | CronJobResource
  | SkillResource
  | ToolResource;

export function defineFilthyPanty(config: FilthyPantyProjectConfig): FilthyPantyConfigDefinition {
  return { [CONFIG_MARKER]: true, config: config };
}

export function defineWorkspace<const Name extends string>(
  name: Name,
  config: WorkspaceConfig,
  options: { description?: string } = {},
): WorkspaceResource<Name> {
  return defineResource("workspace", name, config, options);
}

export function defineSandbox<const Name extends string>(
  name: Name,
  config: SandboxConfig,
  options: { description?: string } = {},
): SandboxResource<Name> {
  return defineResource("sandbox", name, config, options);
}

export function defineSkill<const Name extends string>(
  name: Name,
  config: SkillDefinitionConfig,
  options: { description?: string } = {},
): SkillResource<Name> {
  return defineResource("skill", name, config, options);
}

export function defineTool<const Name extends string>(
  name: Name,
  config: ToolDefinitionConfig,
  options: { description?: string } = {},
): ToolResource<Name> {
  return defineResource("tool", name, config, options);
}

export function defineAgent<const Name extends string>(
  name: Name,
  config: AgentDefinitionConfig,
  options: { description?: string } = {},
): AgentResource<Name> {
  return defineResource("agent", name, config, options);
}

export function defineCronJob<const Name extends string>(
  name: Name,
  config: CronJobDefinitionConfig,
  options: { description?: string } = {},
): CronJobResource<Name> {
  return defineResource("cronJob", name, config, options);
}

export function env<const Name extends string>(name: Name): EnvRef<Name> {
  return { __beeblastEnv: true, name: name };
}

export function isResource(value: unknown): value is AnyResource {
  return Boolean(value && typeof value === "object" && (value as { [RESOURCE_MARKER]?: boolean })[RESOURCE_MARKER]);
}

export function isFilthyPantyConfig(value: unknown): value is FilthyPantyConfigDefinition {
  return Boolean(value && typeof value === "object" && (value as { [CONFIG_MARKER]?: boolean })[CONFIG_MARKER]);
}

function defineResource<const Kind extends ResourceKind, const Name extends string, Config>(
  kind: Kind,
  name: Name,
  config: Config,
  options: { description?: string },
): ResourceDefinition<Kind, Name, Config> {
  return {
    [RESOURCE_MARKER]: true,
    kind: kind,
    name: name,
    ...(options.description ? { description: options.description } : {}),
    config: config,
  };
}

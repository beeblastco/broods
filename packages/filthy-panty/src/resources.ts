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
  project: string;
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

export type ResourceKind = "agent" | "workspace" | "sandbox" | "cronJob";

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

export type AgentDefinitionConfig = Omit<AgentConfig, "sandbox" | "workspaces"> & {
  sandbox?: SandboxResource | string;
  workspaces?: readonly WorkspaceResource[];
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
  | CronJobResource;

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

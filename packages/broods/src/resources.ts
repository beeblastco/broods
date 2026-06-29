/**
 * Resource definition helpers for the code-first `broods/` project folder.
 *
 * Layout: markers, then types (env refs, project config, resource primitives,
 * per-kind config surfaces, per-kind resource aliases), then the env runtime
 * value, the resource constructors, and the type guards. Every runtime function
 * here is synchronous.
 */

import type {
  AgentConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentSlackChannelConfig,
  AgentTelegramChannelConfig,
  CreateCronInput,
  SandboxConfig,
  WorkspaceConfig,
} from "./contracts.ts";

const RESOURCE_MARKER = Symbol.for("broods.resource");
const CONFIG_MARKER = Symbol.for("broods.config");
const CHANNEL_MARKER = Symbol.for("broods.channel");

export interface EnvRef<Name extends string = string> {
  readonly __beeblastEnv: true;
  readonly name: Name;
}

/** Callable + property-access accessor for {@link env}. */
export interface EnvAccessor {
  <const Name extends string>(name: Name): EnvRef<Name>;
  readonly [name: string]: EnvRef;
}

export type EnvRefString<T> =
  T extends string ? T | EnvRef :
  T extends readonly (infer Item)[] ? readonly EnvRefString<Item>[] :
  T extends (infer Item)[] ? EnvRefString<Item>[] :
  T extends object ? { [Key in keyof T]: EnvRefString<T[Key]> } :
  T;

export interface BroodsProjectConfig {
  project?: string;
  environments?: {
    dev?: string;
    deploy?: string;
    [name: string]: string | undefined;
  };
  dashboardUrl?: string;
}

export interface BroodsConfigDefinition {
  readonly [CONFIG_MARKER]: true;
  readonly config: BroodsProjectConfig;
}

export type ResourceKind = "agent" | "workspace" | "sandbox" | "cron" | "skill" | "tool";

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

export interface ResourceDefinitionInput<Name extends string, Config> {
  name: Name;
  description?: string;
  config: Config;
}

/**
 * Code-first sandbox config surface. Mirrors core's `SandboxConfig` but lets
 * `envVars` values be `env.NAME` references (compiled to `${NAME}` placeholders
 * at sync time, exactly like provider `apiKey`). Add overrides here if more
 * sandbox fields should accept env refs.
 */
export type SandboxDefinitionConfig = Omit<SandboxConfig, "envVars"> & {
  envVars?: Record<string, string | EnvRef | undefined>;
};

export interface SkillDefinitionConfig {
  /**
   * Folder containing SKILL.md plus optional scripts/assets. Relative paths are
   * resolved from the `broods/` project directory.
   */
  path: string;
}

export interface ToolDefinitionConfig {
  /**
   * JavaScript module file exporting the custom tool bundle. Relative paths are
   * resolved from the `broods/` project directory.
   */
  path: string;
  description: string;
  inputSchema: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
}

export type ChannelType = "telegram" | "github" | "slack" | "discord" | "pancake" | "zalo";

export interface ChannelDefinition<Type extends ChannelType, Config> {
  readonly [CHANNEL_MARKER]: true;
  readonly kind: "channel";
  readonly type: Type;
  readonly config: Config;
}

type RequiredChannelKeys<Config, Keys extends keyof Config> =
  & Required<Pick<Config, Keys>>
  & Omit<Config, Keys>;
type ChannelSecret = string | EnvRef | undefined;

export type TelegramChannelInput = EnvRefString<RequiredChannelKeys<
  Pick<AgentTelegramChannelConfig, "apiUrl" | "botToken" | "webhookSecret" | "allowedChatIds" | "reactionEmoji">,
  "botToken" | "webhookSecret" | "allowedChatIds"
>>;

export type GitHubChannelInput = EnvRefString<RequiredChannelKeys<
  Pick<AgentGitHubChannelConfig, "apiUrl" | "webhookSecret" | "appId" | "privateKey" | "allowedRepos">,
  "webhookSecret" | "appId" | "privateKey"
>>;

export type SlackChannelInput = EnvRefString<RequiredChannelKeys<
  Pick<AgentSlackChannelConfig, "apiUrl" | "botToken" | "signingSecret" | "allowedChannelIds" | "reactionEmoji">,
  "botToken" | "signingSecret"
>>;

export type DiscordChannelInput = EnvRefString<RequiredChannelKeys<
  Pick<AgentDiscordChannelConfig, "apiUrl" | "botToken" | "publicKey" | "allowedGuildIds">,
  "botToken" | "publicKey"
>>;
export interface PancakeChannelInput {
  pageId: ChannelSecret;
  pageAccessToken: ChannelSecret;
  webhookSecret: ChannelSecret;
  senderId?: string | EnvRef;
  ignoreTagIds?: readonly (string | EnvRef)[];
}

type PancakeChannelDefinitionConfig = Omit<PancakeChannelInput, "ignoreTagIds"> & {
  options?: { ignoreTagIds?: readonly (string | EnvRef)[] };
};
export interface ZaloChannelInput {
  botToken: ChannelSecret;
  webhookSecret: ChannelSecret;
  allowedUserIds: readonly (string | EnvRef)[];
}

export type TelegramChannelDefinition = ChannelDefinition<"telegram", TelegramChannelInput>;
export type GitHubChannelDefinition = ChannelDefinition<"github", GitHubChannelInput>;
export type SlackChannelDefinition = ChannelDefinition<"slack", SlackChannelInput>;
export type DiscordChannelDefinition = ChannelDefinition<"discord", DiscordChannelInput>;
export type PancakeChannelDefinition = ChannelDefinition<"pancake", PancakeChannelDefinitionConfig>;
export type ZaloChannelDefinition = ChannelDefinition<"zalo", ZaloChannelInput>;
export type AnyChannelDefinition =
  | TelegramChannelDefinition
  | GitHubChannelDefinition
  | SlackChannelDefinition
  | DiscordChannelDefinition
  | PancakeChannelDefinition
  | ZaloChannelDefinition;

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
  & EnvRefString<Pick<AgentConfig, "agent" | "model" | "provider" | "session" | "hooks" | "tools">>
  & {
    channels?: readonly AnyChannelDefinition[];
    sandbox?: SandboxResource | string;
    workspaces?: readonly AgentWorkspaceInput[];
    subagent?: AgentSubagentDefinitionConfig;
    skills?: AgentSkillsDefinitionConfig;
    /**
     * Opt the agent into the public runtime endpoint (SSE/WebSocket via the
     * environment runtime key). Off by default — secured: when unset the public
     * endpoint refuses requests for this agent. Reach a private agent through an
     * internal endpoint or a channel webhook. See issue #65.
     */
    publicAccess?: boolean;
  };

export type CronDefinitionConfig = Omit<CreateCronInput, "agentId" | "name"> & {
  agent: AgentResource | string;
};

export type AgentResource<Name extends string = string> = ResourceDefinition<"agent", Name, AgentDefinitionConfig>;
export type WorkspaceResource<Name extends string = string> = ResourceDefinition<"workspace", Name, WorkspaceConfig>;
export type SandboxResource<Name extends string = string> = ResourceDefinition<"sandbox", Name, SandboxDefinitionConfig>;
export type SkillResource<Name extends string = string> = ResourceDefinition<"skill", Name, SkillDefinitionConfig>;
export type ToolResource<Name extends string = string> = ResourceDefinition<"tool", Name, ToolDefinitionConfig>;
export type CronResource<Name extends string = string> = ResourceDefinition<"cron", Name, CronDefinitionConfig>;

export type AnyResource =
  | AgentResource
  | WorkspaceResource
  | SandboxResource
  | CronResource
  | SkillResource
  | ToolResource;

/**
 * References an account/environment variable resolved on the SERVER at runtime —
 * set it with `broods env set <NAME>` or in the dashboard (the Convex-style
 * `convex env set` model). It is a deferred reference, never read from your local
 * environment and never baked into the deployed config. Use either form:
 *
 *   apiKey: env.OPENAI_API_KEY     // property access (reads like process.env)
 *   apiKey: env("OPENAI_API_KEY")  // call form (equivalent)
 *
 * Both compile to a `${NAME}` placeholder the harness fills in at run time. This is
 * NOT `process.env`: agent configs are compiled locally, so `process.env.NAME` would
 * bake the literal local value into the deployed config instead of deferring it.
 */
export const env: EnvAccessor = new Proxy(
  function env(name: string) {
    return { __beeblastEnv: true, name };
  } as unknown as EnvAccessor,
  {
    get(target, property, receiver) {
      if (typeof property === "string") return { __beeblastEnv: true, name: property };
      return Reflect.get(target, property, receiver);
    },
  },
);

/**
 * Shared builder behind every `define*` helper below. The public helpers are
 * thin, per-kind typed front doors into this one function: each pins its `kind`
 * (the discriminant the sync/codegen pipeline switches on) and constrains
 * `config` to that resource's shape so callers get autocomplete and typo checks.
 */
function defineResource<const Kind extends ResourceKind, const Name extends string, Config>(
  kind: Kind,
  input: ResourceDefinitionInput<Name, Config>,
): ResourceDefinition<Kind, Name, Config> {
  if (input.config === undefined) {
    throw new Error(`Resource "${input.name}" must include config`);
  }

  return {
    [RESOURCE_MARKER]: true,
    kind,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    config: input.config,
  };
}

function defineChannel<const Type extends ChannelType, Config>(
  type: Type,
  config: Config,
): ChannelDefinition<Type, Config> {
  return {
    [CHANNEL_MARKER]: true,
    kind: "channel",
    type,
    config,
  };
}

export function defineTelegramChannel(config: TelegramChannelInput): TelegramChannelDefinition {
  return defineChannel("telegram", config);
}

export function defineGitHubChannel(config: GitHubChannelInput): GitHubChannelDefinition {
  return defineChannel("github", config);
}

export function defineSlackChannel(config: SlackChannelInput): SlackChannelDefinition {
  return defineChannel("slack", config);
}

export function defineDiscordChannel(config: DiscordChannelInput): DiscordChannelDefinition {
  return defineChannel("discord", config);
}

export function definePancakeChannel(config: PancakeChannelInput): PancakeChannelDefinition {
  const { ignoreTagIds, ...channelConfig } = config;
  return defineChannel("pancake", {
    ...channelConfig,
    ...(ignoreTagIds === undefined ? {} : { options: { ignoreTagIds } }),
  });
}

export function defineZaloChannel(config: ZaloChannelInput): ZaloChannelDefinition {
  return defineChannel("zalo", config);
}

export function defineBroods(config: BroodsProjectConfig): BroodsConfigDefinition {
  return { [CONFIG_MARKER]: true, config };
}

export function defineAgent<const Name extends string>(
  input: ResourceDefinitionInput<Name, AgentDefinitionConfig>,
): AgentResource<Name> {
  return defineResource("agent", input);
}

export function defineWorkspace<const Name extends string>(
  input: ResourceDefinitionInput<Name, WorkspaceConfig>,
): WorkspaceResource<Name> {
  return defineResource("workspace", input);
}

export function defineSandbox<const Name extends string>(
  input: ResourceDefinitionInput<Name, SandboxDefinitionConfig>,
): SandboxResource<Name> {
  return defineResource("sandbox", input);
}

export function defineSkill<const Name extends string>(
  input: ResourceDefinitionInput<Name, SkillDefinitionConfig>,
): SkillResource<Name> {
  return defineResource("skill", input);
}

export function defineTool<const Name extends string>(
  input: ResourceDefinitionInput<Name, ToolDefinitionConfig>,
): ToolResource<Name> {
  return defineResource("tool", input);
}

export function defineCron<const Name extends string>(
  input: ResourceDefinitionInput<Name, CronDefinitionConfig>,
): CronResource<Name> {
  return defineResource("cron", input);
}

export function isResource(value: unknown): value is AnyResource {
  return Boolean(value && typeof value === "object" && (value as { [RESOURCE_MARKER]?: boolean })[RESOURCE_MARKER]);
}

export function isChannelDefinition(value: unknown): value is AnyChannelDefinition {
  return Boolean(value && typeof value === "object" && (value as { [CHANNEL_MARKER]?: boolean })[CHANNEL_MARKER]);
}

export function isBroodsConfig(value: unknown): value is BroodsConfigDefinition {
  return Boolean(value && typeof value === "object" && (value as { [CONFIG_MARKER]?: boolean })[CONFIG_MARKER]);
}

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
  ChannelPartition,
  ChannelReplyIn,
  PolicyDocument,
  AgentWebhookHookConfig,
  CreateCronInput,
  SandboxConfig,
  WorkspaceConfig,
  TelegramSource,
  GitHubSource,
  SlackSource,
  DiscordSource,
  PancakeSource,
  ZaloSource,
} from "./contracts.ts";

export type { ChannelPartition };

const RESOURCE_MARKER = Symbol.for("broods.resource");
const CONFIG_MARKER = Symbol.for("broods.config");
const CONNECTION_MARKER = Symbol.for("broods.connection");
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface EnvRef<Name extends string = string> {
  readonly __beeblastEnv: true;
  readonly name: Name;
}

/** Callable accessor for {@link env}. */
export interface EnvAccessor {
  <const Name extends string>(name: Name): EnvRef<Name>;
}

export type EnvRefString<T> = T extends string
  ? T | EnvRef
  : T extends readonly (infer Item)[]
    ? readonly EnvRefString<Item>[]
    : T extends (infer Item)[]
      ? EnvRefString<Item>[]
      : T extends object
        ? { [Key in keyof T]: EnvRefString<T[Key]> }
        : T;

export interface BroodsProjectConfig {
  project?: string;
  stages?: {
    dev?: string;
    deploy?: string;
    [name: string]: string | undefined;
  };
  dashboardUrl?: string;
  /** Convex control-plane base URL for sync/env calls; defaults to the URL discovered at login. */
  baseUrl?: string;
}

export interface BroodsConfigDefinition {
  readonly [CONFIG_MARKER]: true;
  readonly config: BroodsProjectConfig;
}

export type ResourceKind =
  | "agent"
  | "workspace"
  | "sandbox"
  | "cron"
  | "skill"
  | "mcp"
  | "policy"
  | "channelRecord";

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

/**
 * Authoring shape for every resource helper: the resource's own `name` (plus an
 * optional human `description`) sits inline with that resource's config keys.
 */
export type ResourceInput<Name extends string, Config> = {
  name: Name;
  description?: string;
} & Config;

/**
 * Provider-specific sandbox knobs. `reservationKey` names the reserved machine a
 * `persistent` sandbox reconnects to when no workspace is mounted; unset, each
 * agent gets its own, and pinning one string on two sandboxes shares a machine.
 * Keys are scoped to the account, so they cannot reach another account's machine.
 */
export type SandboxDefinitionOptions = Record<string, unknown> & {
  reservationKey?: string;
};

/**
 * Code-first sandbox config surface. Mirrors core's `SandboxConfig` but lets
 * `envVars` values be `env("NAME")` references (compiled to `${NAME}` placeholders
 * at sync time, exactly like provider `apiKey`). Add overrides here if more
 * sandbox fields should accept env refs.
 */
export type SandboxDefinitionConfig = Omit<
  SandboxConfig,
  "envVars" | "options"
> & {
  envVars?: Record<string, string | EnvRef | undefined>;
  options?: SandboxDefinitionOptions;
};

export type HarnessType = NonNullable<AgentConfig["harness"]>["type"];

export type HarnessDefinition = Omit<
  NonNullable<AgentConfig["harness"]>,
  "type"
> & {
  type: HarnessType;
  sandbox: SandboxResource | string;
};

export interface SkillDefinitionConfig {
  /**
   * Folder containing SKILL.md plus optional scripts/assets. Relative paths are
   * resolved from the `broods/` project directory.
   */
  path: string;
}

export type PolicyDefinitionConfig = Omit<PolicyDocument, "version"> & {
  version?: PolicyDocument["version"];
};

/**
 * Fetch-style MCP handler for a hosted server: what
 * `createMcpHandler(...)` from @modelcontextprotocol/server returns —
 * either the request function itself or an object exposing it as `fetch`.
 */
export type McpHandler =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

/**
 * MCP server registration (#331) — external (`url`) or hosted (`handler`).
 * Either way the server's tools are offered as `<name>__<tool>`; an external
 * row is dialed over the stateless HTTP transport (spec 2026-07-28) at agent
 * registration time. The name namespaces those tools, so it must be 1-32
 * lowercase letters, digits, or hyphens, starting with a letter.
 */
export interface McpDefinitionConfig {
  /** External server's MCP endpoint; http(s), no embedded credentials. */
  url?: string;
  /**
   * Hosted alternative to `url`: declare the server inline —
   * `handler: createMcpHandler(...)` from @modelcontextprotocol/server,
   * right next to the `defineMcp` call. The CLI bundles the defining module
   * and the tool-runner Lambda hosts it, one invoke per request.
   */
  handler?: McpHandler;
  /**
   * Extra request headers. Credential-bearing headers (Authorization,
   * X-Api-Key, ...) must reference an account env var — e.g.
   * `Bearer ${env("TOKEN")}` — never carry an inline secret.
   */
  headers?: Record<string, string>;
  /** Tool names agents may use from this server; omit to allow all. */
  allowedTools?: string[];
}

export type ChannelType =
  | "telegram"
  | "github"
  | "slack"
  | "discord"
  | "pancake"
  | "zalo";

/**
 * A connection is one app install: the credentials an agent needs before a
 * provider can reach it at all. Channels point at a connection; a connection
 * never points back, which is what keeps the reference graph acyclic.
 */
export interface ConnectionDefinition<Type extends ChannelType, Config> {
  readonly [CONNECTION_MARKER]: true;
  readonly kind: "connection";
  readonly type: Type;
  readonly partition?: ChannelPartition;
  /** `partition` is lifted out of the authored input, so it is not in here. */
  readonly config: Omit<Config, "partition">;
}

/**
 * An agent bound to a channel. Every bound agent runs when a message arrives;
 * `reply: false` runs it with a silenced channel, so it can work without
 * speaking in the room.
 */
export type ChannelAgentInput =
  | AgentResource
  | { agent: AgentResource; reply?: boolean };

type RequiredChannelKeys<Config, Keys extends keyof Config> = Required<
  Pick<Config, Keys>
> &
  Omit<Config, Keys>;
type ChannelSecret = string | EnvRef | undefined;
type ConnectionIdentityInput = {
  /** Include the dashboard trace link in channel replies. Off by default. */
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  /**
   * Rooms this connection answers in, on top of every channel declared against
   * it. Use `["*"]` to answer everywhere instead, which is the only reason to
   * name rooms here at all: a room with rules belongs in a channel resource.
   */
  allowedChannelIds?: readonly string[];
  /** Provider user ids allowed to trigger the agent. `["*"]` or omitted is everyone. */
  allowedUserIds?: readonly string[];
};

export type TelegramConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentTelegramChannelConfig,
      "apiUrl" | "botToken" | "webhookSecret" | "botUsername" | "reactionEmoji"
    >,
    "botToken" | "webhookSecret"
  >
> &
  ConnectionIdentityInput;

export type GitHubConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentGitHubChannelConfig,
      | "apiUrl"
      | "webhookSecret"
      | "appId"
      | "privateKey"
      | "botUserName"
      | "botUserId"
      | "triggerOnIssueOpen"
      | "triggerOnPROpen"
    >,
    "webhookSecret" | "appId" | "privateKey"
  >
> &
  ConnectionIdentityInput;

export type SlackConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentSlackChannelConfig,
      "apiUrl" | "botToken" | "signingSecret" | "reactionEmoji"
    >,
    "botToken" | "signingSecret"
  >
> &
  ConnectionIdentityInput;

export type DiscordConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentDiscordChannelConfig,
      "apiUrl" | "botToken" | "publicKey" | "botUserId" | "mentionRoleIds"
    >,
    "botToken" | "publicKey"
  >
> &
  ConnectionIdentityInput;

export interface PancakeConnectionInput extends ConnectionIdentityInput {
  pageId: ChannelSecret;
  pageAccessToken: ChannelSecret;
  webhookSecret: ChannelSecret;
  senderId?: string | EnvRef;
}

export interface ZaloConnectionInput extends ConnectionIdentityInput {
  botToken: ChannelSecret;
  webhookSecret: ChannelSecret;
}

export type TelegramConnectionDefinition = ConnectionDefinition<
  "telegram",
  TelegramConnectionInput
>;
export type GitHubConnectionDefinition = ConnectionDefinition<
  "github",
  GitHubConnectionInput
>;
export type SlackConnectionDefinition = ConnectionDefinition<
  "slack",
  SlackConnectionInput
>;
export type DiscordConnectionDefinition = ConnectionDefinition<
  "discord",
  DiscordConnectionInput
>;
export type PancakeConnectionDefinition = ConnectionDefinition<
  "pancake",
  PancakeConnectionInput
>;
export type ZaloConnectionDefinition = ConnectionDefinition<
  "zalo",
  ZaloConnectionInput
>;
export type AnyConnectionDefinition =
  | TelegramConnectionDefinition
  | GitHubConnectionDefinition
  | SlackConnectionDefinition
  | DiscordConnectionDefinition
  | PancakeConnectionDefinition
  | ZaloConnectionDefinition;

/**
 * One real place a team talks: a Slack channel, a Discord channel, a repo. It
 * narrows and adds — instructions append, policies union, tools and workspaces
 * only narrow — and never grants what a bound agent lacks. It names the
 * connection it belongs to, so `platform` is never written by hand.
 */
export type ChannelDefinitionConfig = {
  connection: AnyConnectionDefinition;
  /**
   * Provider id of the place, from the per-platform field on the input. A list
   * fans out to one record per id at deploy time.
   */
  externalId: string | readonly string[];
  /** Team, guild or repo owner the place sits in, when the provider has one. */
  workspaceRef?: string;
  /** Every one of these runs. Omit and the connection's own agent answers. */
  agents?: readonly ChannelAgentInput[];
  /** Appended after each agent's own system prompt, never replacing it. */
  instructions?: string;
  /** Selects from what the agent already attaches; anything else is dropped. */
  workspaces?: readonly AgentWorkspaceInput[];
  /** Added to whatever the agent already carries. Each policy holds its own mode. */
  policies?: readonly (PolicyResource | string)[];
  denyTools?: readonly string[];
  /** Where the reply lands. Slack only. */
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
  sandboxImages?: readonly string[];
  tagRoles?: readonly { roleId: string; userIds: readonly string[] }[];
};

/** Rules shared by every channel, whatever the provider calls its rooms. */
type ChannelRulesInput = Omit<
  ChannelDefinitionConfig,
  "connection" | "externalId" | "workspaceRef" | "replyIn"
>;

export type SlackChannelInput = ChannelRulesInput & {
  connection: SlackConnectionDefinition;
  /** Slack channel id, e.g. "C0123ABCD". */
  channelId: string;
  /** Slack team id the channel sits in. */
  teamId?: string;
  /** Where the reply lands. Slack is the only provider with a choice. */
  replyIn?: ChannelReplyIn;
};

export type DiscordChannelInput = ChannelRulesInput & {
  connection: DiscordConnectionDefinition;
  /** Discord channel id (a snowflake). */
  channelId: string;
  /** Guild the channel sits in. */
  guildId?: string;
};

export type GitHubChannelInput = ChannelRulesInput & {
  connection: GitHubConnectionDefinition;
  /** Repository full name, e.g. "beeblast/api". */
  repo: string;
};

export type TelegramChannelInput = ChannelRulesInput & {
  connection: TelegramConnectionDefinition;
  /** Telegram chat id, e.g. "-1001234567". */
  chatId: string;
};

export type ZaloChannelInput = ChannelRulesInput & {
  connection: ZaloConnectionDefinition;
  /** Zalo user or group chat id, or several that share one set of rules. */
  chatId: string | readonly string[];
};

export type PancakeChannelInput = ChannelRulesInput & {
  connection: PancakeConnectionDefinition;
  /** Pancake conversation id. */
  conversationId: string;
};

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
export type AgentSubagentDefinitionConfig = Omit<
  NonNullable<AgentConfig["subagent"]>,
  "allowed"
> & {
  allowed?: readonly (AgentResource | string)[];
};

export type AgentSkillsDefinitionConfig = Omit<
  NonNullable<AgentConfig["skills"]>,
  "allowed"
> & {
  allowed?: readonly (SkillResource | string)[];
};

export interface HookContext {
  fetch: typeof fetch;
  config: Record<string, unknown>;
  /**
   * Mutable per-request scratchpad shared across this agent request's hooks.
   * Seed it in an early hook (e.g. `onStart`) and read or modify it later —
   * every loop hook, `onSubagentFinish`, and the reply's `onMessageSending`
   * see the same state. Keep it JSON-serializable. `onMessageReceived`,
   * delayed background replies, and each subagent's own run get fresh state.
   */
  state: Record<string, unknown>;
}

type Handler<Event, Result> = (
  ctx: HookContext,
  event: Event,
) => Result | void | Promise<Result | void>;

/**
 * Channel-specific routing data attached to an inbound message. Inherited from
 * the core channel adapters (via contracts.ts) so an `onMessageReceived` hook
 * that narrows on `event.channel` always sees exactly what core emits (e.g.
 * Pancake `tagIds`).
 */
export type TelegramMessageSource = TelegramSource;
export type GitHubMessageSource = GitHubSource;
export type SlackMessageSource = SlackSource;
export type DiscordMessageSource = DiscordSource;
export type PancakeMessageSource = PancakeSource;
export type ZaloMessageSource = ZaloSource;

/**
 * Inbound channel message passed to `onMessageReceived`, discriminated on
 * `channel` so each variant exposes its channel's strongly-typed `source`.
 */
export type ChannelMessageReceived =
  | { channel: "telegram"; text: string; source: TelegramMessageSource }
  | { channel: "github"; text: string; source: GitHubMessageSource }
  | { channel: "slack"; text: string; source: SlackMessageSource }
  | { channel: "discord"; text: string; source: DiscordMessageSource }
  | { channel: "pancake"; text: string; source: PancakeMessageSource }
  | { channel: "zalo"; text: string; source: ZaloMessageSource };

/**
 * Inline agent hook callbacks. Handlers are serialized with `.toString()`,
 * bundled into one account hook, and run in a fresh V8 isolate. Keep them
 * self-contained: use only `ctx`, `event`, and JavaScript globals. Do not rely
 * on imports or closure variables. Arrow functions and function expressions are
 * preferred so the serialized source is valid as an object-literal value.
 *
 * Subagent runs fire hooks too: a registered subagent runs its own hooks, a
 * prompt-only (virtual) subagent inherits this bundle — always with fresh
 * `ctx.state`. `onSubagentFinish` fires on the parent with the parent's state.
 */
export interface AgentHooks {
  // User messages in `messages` carry `createdAt` plus any `metadata` an
  // onMessageReceived hook returned, for reading identity without text parsing.
  onStart?: Handler<
    { system: string; messages: unknown[] },
    { system?: string; messages?: unknown[] }
  >;
  onStepFinish?: Handler<
    { stepNumber: number; finishReason: string; toolCallCount: number },
    void
  >;
  onToolCall?: Handler<
    { toolName: string; input: unknown },
    {
      decision?: "allow" | "deny";
      args?: Record<string, unknown>;
      denyReason?: string;
    }
  >;
  onToolResult?: Handler<
    { toolName: string; output: unknown },
    { output?: unknown }
  >;
  onFinish?: Handler<
    { finishReason: string; response: unknown },
    { output?: unknown }
  >;
  onApproval?: Handler<{ approvals: unknown }, { approve?: boolean }>;
  onError?: Handler<{ error: string }, void>;
  onSubagentFinish?: Handler<
    { taskId: string; result: unknown },
    { visibleResult?: unknown }
  >;
  // Returned `metadata` (opaque JSON) persists with the stored message and
  // resurfaces on onStart's messages — the receive→run channel ctx.state lacks.
  onMessageReceived?: Handler<
    ChannelMessageReceived,
    { drop?: boolean; text?: string; metadata?: unknown }
  >;
  onMessageSending?: Handler<
    { channel: ChannelType; text: string },
    { drop?: boolean; text?: string }
  >;
}

/**
 * Code-first agent config surface. Built from an explicit `Pick` of `AgentConfig`
 * (not `Omit`) so the SDK input type does NOT inherit `AgentConfig`'s
 * `[key: string]: unknown` index signature — which would otherwise disable
 * TypeScript's excess-property checks and silently accept typos like
 * `workspace:` instead of `workspaces:`. Add a key here when core's `AgentConfig`
 * gains a new top-level field that should be code-definable.
 */
/**
 * SDK-facing model-provider constructor settings. Open by design: everything a
 * provider's Vercel AI SDK factory accepts is forwarded verbatim, so there is no
 * key list to keep in sync. Only the keys broods reads itself are named (and so
 * typo-checked at run time by `validateProviderConfig`); every string field also
 * accepts an `env("NAME")` reference.
 */
export interface ProviderSettingsInput {
  apiKey?: string | EnvRef;
  base_url?: string | EnvRef;
  baseURL?: string | EnvRef;
  headers?: Record<string, string | EnvRef>;
  [key: string]: unknown;
}

/** Per-provider settings; provider names stay synced with core's `AgentConfig`. */
export type ProviderConfigInput = Partial<
  Record<keyof NonNullable<AgentConfig["provider"]>, ProviderSettingsInput>
>;

export type AgentDefinitionConfig = EnvRefString<
  Pick<
    AgentConfig,
    "agent" | "model" | "scheduler" | "session" | "tools" | "mcp"
  >
> & { provider?: ProviderConfigInput } & {
  harness?: HarnessDefinition;
  hooks?: AgentHooks & {
    webhooks?: readonly EnvRefString<AgentWebhookHookConfig>[];
  };
  connections?: readonly AnyConnectionDefinition[];
  sandbox?: SandboxResource | string;
  workspaces?: readonly AgentWorkspaceInput[];
  subagent?: AgentSubagentDefinitionConfig;
  skills?: AgentSkillsDefinitionConfig;
  /** Policies that gate this agent. Each one carries its own enforcement mode. */
  policies?: readonly (PolicyResource | string)[];
  /**
   * Opt the agent into the public runtime endpoint (SSE/WebSocket via the
   * stage runtime key). Off by default — secured: when unset the public
   * endpoint refuses requests for this agent. Reach a private agent through an
   * internal endpoint or a channel webhook. See issue #65.
   */
  publicAccess?: boolean;
};

export type CronDefinitionConfig = Omit<CreateCronInput, "agentId" | "name"> & {
  agent: AgentResource | string;
};

export type AgentResource<Name extends string = string> = ResourceDefinition<
  "agent",
  Name,
  AgentDefinitionConfig
>;
/**
 * Code-first workspace config. Says `partitioned` where storage says
 * `isolation`: the flag permits a split, it does not perform one — a channel's
 * `partition` decides which folder a run actually mounts.
 */
export type WorkspaceDefinitionConfig = Omit<WorkspaceConfig, "isolation"> & {
  /** Allow this workspace to be split into per-conversation folders. */
  partitioned?: boolean;
};

export type WorkspaceResource<Name extends string = string> =
  ResourceDefinition<"workspace", Name, WorkspaceDefinitionConfig>;
export type SandboxResource<Name extends string = string> = ResourceDefinition<
  "sandbox",
  Name,
  SandboxDefinitionConfig
>;
export type SkillResource<Name extends string = string> = ResourceDefinition<
  "skill",
  Name,
  SkillDefinitionConfig
>;
export type McpResource<Name extends string = string> = ResourceDefinition<
  "mcp",
  Name,
  McpDefinitionConfig
>;
export type PolicyResource<Name extends string = string> = ResourceDefinition<
  "policy",
  Name,
  PolicyDefinitionConfig
>;
export type CronResource<Name extends string = string> = ResourceDefinition<
  "cron",
  Name,
  CronDefinitionConfig
>;

export type ChannelResource<Name extends string = string> = ResourceDefinition<
  "channelRecord",
  Name,
  ChannelDefinitionConfig
>;

export type AnyResource =
  | AgentResource
  | WorkspaceResource
  | SandboxResource
  | CronResource
  | SkillResource
  | McpResource
  | PolicyResource
  | ChannelResource;

/**
 * References an account/environment variable resolved on the SERVER at runtime —
 * set it with `broods env set <NAME>` or in the dashboard (the Convex-style
 * `convex env set` model). It is a deferred reference, never read from your local
 * environment and never baked into the deployed config:
 *
 *   apiKey: env("OPENAI_API_KEY")
 *
 * It compiles to a `${NAME}` placeholder the harness fills in at run time. This is
 * NOT `process.env`: agent configs are compiled locally, so `process.env.NAME` would
 * bake the literal local value into the deployed config instead of deferring it.
 *
 * The reference must resolve: syncing a manifest whose `env("NAME")` has no value
 * stored for the stage is rejected outright, so an unset or misspelled name fails
 * the sync instead of reaching the runtime as a literal `${NAME}`. `broods dev`
 * pushes matching `.env.local` values first, so a local value is enough there.
 */
export const env: EnvAccessor = new Proxy(
  <const Name extends string>(name: Name): EnvRef<Name> => {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        "env name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters.",
      );
    }

    return { __beeblastEnv: true, name: name };
  },
  {
    get: function (target, property, receiver) {
      if (typeof property === "string" && ENV_NAME_PATTERN.test(property)) {
        throw new Error(
          `env.${property} is not supported; use env("${property}")`,
        );
      }

      return Reflect.get(target, property, receiver);
    },
  },
);

/**
 * Shared builder behind every `define*` helper below. The public helpers are
 * thin, per-kind typed front doors: each pins its `kind` (the discriminant the
 * sync/codegen pipeline switches on) and splits the flat authoring input back
 * into the `{ name, description?, config }` shape the manifest wire format uses.
 */
function defineResource<
  const Kind extends ResourceKind,
  const Name extends string,
  Config,
>(
  kind: Kind,
  name: Name,
  description: string | undefined,
  config: Config,
): ResourceDefinition<Kind, Name, Config> {
  return {
    [RESOURCE_MARKER]: true,
    kind: kind,
    name: name,
    ...(description ? { description: description } : {}),
    config: config,
  };
}

function defineConnection<const Type extends ChannelType, Config>(
  type: Type,
  config: Config & ConnectionIdentityInput,
): ConnectionDefinition<Type, Config> {
  const { partition, ...rest } = config;

  return {
    [CONNECTION_MARKER]: true,
    kind: "connection",
    type: type,
    ...(partition ? { partition: partition } : {}),
    config: rest,
  };
}

// The per-platform id field is named for what the provider calls it, so the
// value you paste is the value the field asks for. All of them normalize to the
// `externalId` the backend stores, one row per id, and `platform` comes off the
// connection.
function defineChannelResource<const Name extends string>(
  name: Name,
  description: string | undefined,
  externalId: string | readonly string[],
  workspaceRef: string | undefined,
  rules: Omit<ChannelDefinitionConfig, "externalId" | "workspaceRef">,
): ChannelResource<Name> {
  return defineResource("channelRecord", name, description, {
    ...rules,
    externalId: externalId,
    ...(workspaceRef ? { workspaceRef: workspaceRef } : {}),
  });
}

export function defineDiscordConnection(
  config: DiscordConnectionInput,
): DiscordConnectionDefinition {
  return defineConnection("discord", config);
}

export function defineGitHubConnection(
  config: GitHubConnectionInput,
): GitHubConnectionDefinition {
  return defineConnection("github", config);
}

export function definePancakeConnection(
  config: PancakeConnectionInput,
): PancakeConnectionDefinition {
  return defineConnection("pancake", config);
}

export function defineSlackConnection(
  config: SlackConnectionInput,
): SlackConnectionDefinition {
  return defineConnection("slack", config);
}

export function defineTelegramConnection(
  config: TelegramConnectionInput,
): TelegramConnectionDefinition {
  return defineConnection("telegram", config);
}

export function defineZaloConnection(
  config: ZaloConnectionInput,
): ZaloConnectionDefinition {
  return defineConnection("zalo", config);
}

export function defineDiscordChannel<const Name extends string>(
  input: ResourceInput<Name, DiscordChannelInput>,
): ChannelResource<Name> {
  const { name, description, channelId, guildId, ...rules } = input;

  return defineChannelResource(name, description, channelId, guildId, rules);
}

export function defineGitHubChannel<const Name extends string>(
  input: ResourceInput<Name, GitHubChannelInput>,
): ChannelResource<Name> {
  const { name, description, repo, ...rules } = input;
  // The owner half becomes the workspace ref, so a repo missing it would store
  // the whole string as an owner that does not exist.
  const [owner, ...rest] = repo.split("/");
  if (!owner || rest.length !== 1 || !rest[0]) {
    throw new Error(
      `Channel "${name}" repo must be "owner/name", not "${repo}"`,
    );
  }

  return defineChannelResource(name, description, repo, owner, rules);
}

export function definePancakeChannel<const Name extends string>(
  input: ResourceInput<Name, PancakeChannelInput>,
): ChannelResource<Name> {
  const { name, description, conversationId, ...rules } = input;

  return defineChannelResource(
    name,
    description,
    conversationId,
    undefined,
    rules,
  );
}

export function defineSlackChannel<const Name extends string>(
  input: ResourceInput<Name, SlackChannelInput>,
): ChannelResource<Name> {
  const { name, description, channelId, teamId, ...rules } = input;

  return defineChannelResource(name, description, channelId, teamId, rules);
}

export function defineTelegramChannel<const Name extends string>(
  input: ResourceInput<Name, TelegramChannelInput>,
): ChannelResource<Name> {
  const { name, description, chatId, ...rules } = input;

  return defineChannelResource(name, description, chatId, undefined, rules);
}

export function defineZaloChannel<const Name extends string>(
  input: ResourceInput<Name, ZaloChannelInput>,
): ChannelResource<Name> {
  const { name, description, chatId, ...rules } = input;

  return defineChannelResource(name, description, chatId, undefined, rules);
}

export function defineBroods(
  config: BroodsProjectConfig,
): BroodsConfigDefinition {
  return { [CONFIG_MARKER]: true, config: config };
}

export function defineAgent<const Name extends string>(
  input: ResourceInput<Name, AgentDefinitionConfig>,
): AgentResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "agent",
    name,
    description,
    config as AgentDefinitionConfig,
  );
}

export function defineHarness<const Definition extends HarnessDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export function defineWorkspace<const Name extends string>(
  input: ResourceInput<Name, WorkspaceDefinitionConfig>,
): WorkspaceResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "workspace",
    name,
    description,
    config as WorkspaceDefinitionConfig,
  );
}

export function defineSandbox<const Name extends string>(
  input: ResourceInput<Name, SandboxDefinitionConfig>,
): SandboxResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "sandbox",
    name,
    description,
    config as SandboxDefinitionConfig,
  );
}

export function defineSkill<const Name extends string>(
  input: ResourceInput<Name, SkillDefinitionConfig>,
): SkillResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "skill",
    name,
    description,
    config as SkillDefinitionConfig,
  );
}

export function defineMcp<const Name extends string>(
  input: ResourceInput<Name, McpDefinitionConfig>,
): McpResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "mcp",
    name,
    description,
    config as McpDefinitionConfig,
  );
}

export function definePolicy<const Name extends string>(
  input: ResourceInput<Name, PolicyDefinitionConfig>,
): PolicyResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "policy",
    name,
    description,
    config as PolicyDefinitionConfig,
  );
}

export function defineCron<const Name extends string>(
  input: ResourceInput<Name, CronDefinitionConfig>,
): CronResource<Name> {
  const { name, description, ...config } = input;

  return defineResource(
    "cron",
    name,
    description,
    config as CronDefinitionConfig,
  );
}

export function isResource(value: unknown): value is AnyResource {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [RESOURCE_MARKER]?: boolean })[RESOURCE_MARKER],
  );
}

export function isConnectionDefinition(
  value: unknown,
): value is AnyConnectionDefinition {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [CONNECTION_MARKER]?: boolean })[CONNECTION_MARKER],
  );
}

export function isBroodsConfig(
  value: unknown,
): value is BroodsConfigDefinition {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [CONFIG_MARKER]?: boolean })[CONFIG_MARKER],
  );
}

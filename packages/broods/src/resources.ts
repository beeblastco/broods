import type {
  AgentConfig,
  HookAgentConfig,
  AgentDiscordChannelConfig,
  AgentGitHubChannelConfig,
  AgentGoogleChatChannelConfig,
  AgentInstagramChannelConfig,
  AgentLinearChannelConfig,
  AgentMatrixChannelConfig,
  AgentMessengerChannelConfig,
  AgentSlackChannelConfig,
  AgentTeamsChannelConfig,
  AgentTelegramChannelConfig,
  AgentTwilioChannelConfig,
  AgentWhatsAppChannelConfig,
  ChannelPartition,
  ChannelReplyIn,
  PolicyDocument,
  AgentWebhookHookConfig,
  CreateCronInput,
  SandboxConfig,
  WorkspaceConfig,
  WorkspaceIsolation,
  TelegramSource,
  GoogleChatSource,
  GitHubSource,
  LinearSource,
  SlackSource,
  DiscordSource,
  MatrixSource,
  PancakeSource,
  TeamsSource,
  TwilioSource,
  ZaloSource,
  InstagramSource,
  MessengerSource,
  WhatsAppSource,
} from "./contracts.ts";
import type { McpRuntime } from "./account.ts";

export type { ChannelPartition };

const RESOURCE_MARKER = Symbol.for("broods.resource");
const CONFIG_MARKER = Symbol.for("broods.config");
const CONNECTION_MARKER = Symbol.for("broods.connection");
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface EnvRef<Name extends string = string> {
  readonly __beeblastEnv: true;
  readonly name: Name;
}

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

export type ResourceInput<Name extends string, Config> = {
  name: Name;
  description?: string;
} & Config;

export type SandboxDefinitionOptions = Record<string, unknown> & {
  /** The machine a `persistent` sandbox reconnects to; one key on two sandboxes shares it. */
  reservationKey?: string;
  /** daytona: mount workspaces (snapshot needs mount-s3); sandbox: mount even without one. */
  mountAwsS3Buckets?: boolean;
  /** `custom` sandbox: its https server, with a bearer `token` and `env()` credential headers. */
  endpoint?: string;
  token?: string | EnvRef;
  headers?: Record<string, string | EnvRef>;
};

export type SandboxDefinitionConfig = Omit<
  SandboxConfig,
  "envVars" | "options"
> & {
  envVars?: Record<string, string | EnvRef | undefined>;
  options?: SandboxDefinitionOptions;
};

export type HarnessType = NonNullable<AgentConfig["harness"]>["type"];

export type HarnessDefinition = NonNullable<AgentConfig["harness"]>;

export interface SkillDefinitionConfig {
  /** Folder holding SKILL.md, relative to the `broods/` project directory. */
  path: string;
}

export type PolicyDefinitionConfig = Omit<PolicyDocument, "version"> & {
  version?: PolicyDocument["version"];
};

export type McpHandler =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

/** Tools are offered as `<name>__<tool>`: the name is 1-32 of a-z, 0-9, "-", letter first. */
export interface McpDefinitionConfig {
  url?: string;
  /** A machine sandbox runs its `--mcp` file's entry of this name; a lambda one runs `command`. */
  sandbox?: SandboxResource | string;
  command?: string[];
  /** Hosted: `createMcpHandler(factory, { legacy: "reject" })`; MCP 2026-07-28 only. */
  handler?: McpHandler;
  /** "auto" runs on Workers when the bundle builds for them; "lambda" ships the Node build. */
  runtime?: McpRuntime;
  /** A credential header names an env var in a plain string, `"Bearer ${TOKEN}"`, never `env()`. */
  headers?: Record<string, string>;
  /** The runtime sends the bearer itself: set no Authorization header. Secrets are `env()`. */
  oauth?: {
    clientId: string | EnvRef;
    clientSecret: string | EnvRef;
    refreshToken: string | EnvRef;
    tokenUrl?: string;
  };
  allowedTools?: string[];
}

export type ChannelType =
  | "telegram"
  | "gchat"
  | "github"
  | "linear"
  | "slack"
  | "discord"
  | "matrix"
  | "pancake"
  | "teams"
  | "twilio"
  | "zalo"
  | "whatsapp"
  | "instagram"
  | "messenger";

/** One app install. Channels point at it and it never points back, so references stay acyclic. */
export interface ConnectionDefinition<Type extends ChannelType, Config> {
  readonly [CONNECTION_MARKER]: true;
  readonly kind: "connection";
  readonly type: Type;
  readonly partition?: ChannelPartition;
  readonly config: Omit<Config, "partition">;
}

/** Every bound agent runs; `reply: false` runs it without speaking in the room. */
export type ChannelAgentInput =
  | AgentResource
  | { agent: AgentResource; reply?: boolean };

type RequiredChannelKeys<Config, Keys extends keyof Config> = Required<
  Pick<Config, Keys>
> &
  Omit<Config, Keys>;
type ChannelSecret = string | EnvRef | undefined;
type ConnectionIdentityInput = {
  trace?: "enabled" | "disabled";
  partition?: ChannelPartition;
  /** Rooms beyond its channels'; `["*"]` answers everywhere. A room with rules is a channel. */
  allowedChannelIds?: readonly string[];
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

export type GoogleChatConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentGoogleChatChannelConfig,
      | "credentials"
      | "endpointUrl"
      | "googleChatProjectNumber"
      | "userName"
      | "workspaceAddOnServiceAccountEmail"
    >,
    "credentials"
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

export type LinearConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentLinearChannelConfig,
      "apiKey" | "apiUrl" | "userName" | "webhookSecret"
    >,
    "apiKey" | "userName" | "webhookSecret"
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

export type MatrixConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentMatrixChannelConfig,
      "apiUrl" | "botToken" | "botName" | "mentionText"
    >,
    "apiUrl" | "botToken"
  >
> &
  ConnectionIdentityInput;

export type TeamsConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentTeamsChannelConfig,
      | "apiUrl"
      | "appId"
      | "appPassword"
      | "appTenantId"
      | "appType"
      | "userName"
    >,
    "appId" | "appPassword"
  >
> &
  ConnectionIdentityInput;

export type WhatsAppConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentWhatsAppChannelConfig,
      | "accessToken"
      | "apiUrl"
      | "apiVersion"
      | "appSecret"
      | "phoneNumberId"
      | "userName"
      | "verifyToken"
    >,
    "accessToken" | "appSecret" | "phoneNumberId" | "verifyToken"
  >
> &
  ConnectionIdentityInput;

export interface PancakeConnectionInput extends ConnectionIdentityInput {
  pageId: ChannelSecret;
  pageAccessToken: ChannelSecret;
  webhookSecret: ChannelSecret;
  senderId?: string | EnvRef;
}

export type TwilioConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentTwilioChannelConfig,
      | "accountSid"
      | "apiUrl"
      | "authToken"
      | "messagingServiceSid"
      | "phoneNumber"
      | "statusCallbackUrl"
      | "userName"
      | "webhookUrl"
    >,
    "accountSid" | "authToken"
  >
> &
  ConnectionIdentityInput;

export interface ZaloConnectionInput extends ConnectionIdentityInput {
  botToken: ChannelSecret;
  webhookSecret: ChannelSecret;
}

export type InstagramConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentInstagramChannelConfig,
      | "accessToken"
      | "accountId"
      | "apiVersion"
      | "appSecret"
      | "userName"
      | "verifyToken"
    >,
    "accessToken" | "accountId" | "appSecret" | "verifyToken"
  >
> &
  ConnectionIdentityInput;

export type MessengerConnectionInput = EnvRefString<
  RequiredChannelKeys<
    Pick<
      AgentMessengerChannelConfig,
      | "apiVersion"
      | "appSecret"
      | "pageAccessToken"
      | "userName"
      | "verifyToken"
    >,
    "appSecret" | "pageAccessToken" | "verifyToken"
  >
> &
  ConnectionIdentityInput;

export type TelegramConnectionDefinition = ConnectionDefinition<
  "telegram",
  TelegramConnectionInput
>;
export type GoogleChatConnectionDefinition = ConnectionDefinition<
  "gchat",
  GoogleChatConnectionInput
>;
export type GitHubConnectionDefinition = ConnectionDefinition<
  "github",
  GitHubConnectionInput
>;
export type LinearConnectionDefinition = ConnectionDefinition<
  "linear",
  LinearConnectionInput
>;
export type SlackConnectionDefinition = ConnectionDefinition<
  "slack",
  SlackConnectionInput
>;
export type DiscordConnectionDefinition = ConnectionDefinition<
  "discord",
  DiscordConnectionInput
>;
export type MatrixConnectionDefinition = ConnectionDefinition<
  "matrix",
  MatrixConnectionInput
>;
export type PancakeConnectionDefinition = ConnectionDefinition<
  "pancake",
  PancakeConnectionInput
>;
export type TeamsConnectionDefinition = ConnectionDefinition<
  "teams",
  TeamsConnectionInput
>;
export type TwilioConnectionDefinition = ConnectionDefinition<
  "twilio",
  TwilioConnectionInput
>;
export type ZaloConnectionDefinition = ConnectionDefinition<
  "zalo",
  ZaloConnectionInput
>;
export type InstagramConnectionDefinition = ConnectionDefinition<
  "instagram",
  InstagramConnectionInput
>;
export type MessengerConnectionDefinition = ConnectionDefinition<
  "messenger",
  MessengerConnectionInput
>;
export type WhatsAppConnectionDefinition = ConnectionDefinition<
  "whatsapp",
  WhatsAppConnectionInput
>;
export type AnyConnectionDefinition =
  | TelegramConnectionDefinition
  | GoogleChatConnectionDefinition
  | GitHubConnectionDefinition
  | LinearConnectionDefinition
  | SlackConnectionDefinition
  | DiscordConnectionDefinition
  | MatrixConnectionDefinition
  | PancakeConnectionDefinition
  | TeamsConnectionDefinition
  | TwilioConnectionDefinition
  | ZaloConnectionDefinition
  | WhatsAppConnectionDefinition
  | InstagramConnectionDefinition
  | MessengerConnectionDefinition;

/** Never grants what a bound agent lacks: instructions append, policies union, the rest narrows. */
export type ChannelDefinitionConfig = {
  connection: AnyConnectionDefinition;
  externalId: string | readonly string[];
  workspaceRef?: string;
  /** Omit and the connection's own agent answers. */
  agents?: readonly ChannelAgentInput[];
  instructions?: string;
  workspaces?: readonly AgentWorkspaceInput[];
  policies?: readonly (PolicyResource | string)[];
  denyTools?: readonly string[];
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
  sandboxImages?: readonly string[];
  tagRoles?: readonly { roleId: string; userIds: readonly string[] }[];
};

type ChannelRulesInput = Omit<
  ChannelDefinitionConfig,
  "connection" | "externalId" | "workspaceRef" | "replyIn"
>;

export type SlackChannelInput = ChannelRulesInput & {
  connection: SlackConnectionDefinition;
  /** e.g. "C0123ABCD". */
  channelId: string;
  teamId?: string;
  replyIn?: ChannelReplyIn;
};

export type DiscordChannelInput = ChannelRulesInput & {
  connection: DiscordConnectionDefinition;
  channelId: string;
  guildId?: string;
};

export type MatrixChannelInput = ChannelRulesInput & {
  connection: MatrixConnectionDefinition;
  /** Room id, e.g. "!abc123:matrix.org". */
  channelId: string;
};

export type GoogleChatChannelInput = ChannelRulesInput & {
  connection: GoogleChatConnectionDefinition;
  /** e.g. "spaces/AAAAxxxx". */
  spaceName: string;
};

export type GitHubChannelInput = ChannelRulesInput & {
  connection: GitHubConnectionDefinition;
  /** "owner/name". */
  repo: string;
};

export type LinearChannelInput = ChannelRulesInput & {
  connection: LinearConnectionDefinition;
  /** Team key, e.g. "ENG". */
  team: string | readonly string[];
};

export type TeamsChannelInput = ChannelRulesInput & {
  connection: TeamsConnectionDefinition;
  /** Channel or chat conversation id, e.g. "19:abc@thread.tacv2". */
  channelId: string;
  teamId?: string;
};

export type TelegramChannelInput = ChannelRulesInput & {
  connection: TelegramConnectionDefinition;
  chatId: string;
};

export type TwilioChannelInput = ChannelRulesInput & {
  connection: TwilioConnectionDefinition;
  /** Sender's number in E.164, e.g. "+15551234567". */
  from: string | readonly string[];
};

export type ZaloChannelInput = ChannelRulesInput & {
  connection: ZaloConnectionDefinition;
  chatId: string | readonly string[];
};

export type InstagramChannelInput = ChannelRulesInput & {
  connection: InstagramConnectionDefinition;
  igsid: string | readonly string[];
};

export type MessengerChannelInput = ChannelRulesInput & {
  connection: MessengerConnectionDefinition;
  psid: string | readonly string[];
};

export type WhatsAppChannelInput = ChannelRulesInput & {
  connection: WhatsAppConnectionDefinition;
  /** The number with country code and no "+". */
  waId: string | readonly string[];
};

export type PancakeChannelInput = ChannelRulesInput & {
  connection: PancakeConnectionDefinition;
  conversationId: string;
};

export interface AgentWorkspaceRefInput {
  workspace: WorkspaceResource | string;
  /** Omit for the agent's first sandbox; `null` mounts it read-only, with no compute. */
  sandbox?: SandboxResource | string | null;
}

export type AgentWorkspaceInput = WorkspaceResource | AgentWorkspaceRefInput;

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
  /** The model and the agent's tool, server, channel, skill and subagent names; no credentials. */
  config: HookAgentConfig;
  /**
   * Shared by one request's hooks; keep it JSON-serializable. `onMessageReceived`, delayed
   * replies and each subagent's own run start fresh.
   */
  state: Record<string, unknown>;
}

type Handler<Event, Result> = (
  ctx: HookContext,
  event: Event,
) => Result | void | Promise<Result | void>;

export type TelegramMessageSource = TelegramSource;
export type GoogleChatMessageSource = GoogleChatSource;
export type GitHubMessageSource = GitHubSource;
export type LinearMessageSource = LinearSource;
export type SlackMessageSource = SlackSource;
export type DiscordMessageSource = DiscordSource;
export type MatrixMessageSource = MatrixSource;
export type PancakeMessageSource = PancakeSource;
export type TeamsMessageSource = TeamsSource;
export type TwilioMessageSource = TwilioSource;
export type ZaloMessageSource = ZaloSource;
export type InstagramMessageSource = InstagramSource;
export type MessengerMessageSource = MessengerSource;
export type WhatsAppMessageSource = WhatsAppSource;

export type ChannelMessageReceived =
  | { channel: "telegram"; text: string; source: TelegramMessageSource }
  | { channel: "gchat"; text: string; source: GoogleChatMessageSource }
  | { channel: "github"; text: string; source: GitHubMessageSource }
  | { channel: "linear"; text: string; source: LinearMessageSource }
  | { channel: "slack"; text: string; source: SlackMessageSource }
  | { channel: "discord"; text: string; source: DiscordMessageSource }
  | { channel: "matrix"; text: string; source: MatrixMessageSource }
  | { channel: "pancake"; text: string; source: PancakeMessageSource }
  | { channel: "teams"; text: string; source: TeamsMessageSource }
  | { channel: "twilio"; text: string; source: TwilioMessageSource }
  | { channel: "zalo"; text: string; source: ZaloMessageSource }
  | { channel: "whatsapp"; text: string; source: WhatsAppMessageSource }
  | { channel: "instagram"; text: string; source: InstagramMessageSource }
  | { channel: "messenger"; text: string; source: MessengerMessageSource };

/**
 * Serialized with `.toString()` into a fresh V8 isolate: use only `ctx`, `event` and JS globals,
 * no imports or closures, and prefer arrow functions. A registered subagent runs its own hooks,
 * a prompt-only one inherits these; `onSubagentFinish` fires on the parent with its state.
 */
export interface AgentHooks {
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
  /** Returned `metadata` (opaque JSON) is stored and resurfaces on `onStart`'s messages. */
  onMessageReceived?: Handler<
    ChannelMessageReceived,
    { drop?: boolean; text?: string; metadata?: unknown }
  >;
  onMessageSending?: Handler<
    { channel: ChannelType; text: string },
    { drop?: boolean; text?: string }
  >;
}

/** Forwarded verbatim to the provider's AI SDK factory; only the named keys are checked. */
export interface ProviderSettingsInput {
  apiKey?: string | EnvRef;
  base_url?: string | EnvRef;
  baseURL?: string | EnvRef;
  gatewayId?: string;
  headers?: Record<string, string | EnvRef>;
  [key: string]: unknown;
}

export type ProviderConfigInput = Partial<
  Record<keyof NonNullable<AgentConfig["provider"]>, ProviderSettingsInput>
>;

// `Pick`, not `Omit`: AgentConfig's index signature would turn off excess-property checks.
export type AgentDefinitionConfig = EnvRefString<
  Pick<
    AgentConfig,
    "agent" | "model" | "scheduler" | "browser" | "session" | "tools" | "mcp"
  >
> & { provider?: ProviderConfigInput } & {
  harness?: HarnessDefinition;
  hooks?: AgentHooks & {
    webhooks?: readonly EnvRefString<AgentWebhookHookConfig>[];
  };
  connections?: readonly AnyConnectionDefinition[];
  /** The first runs the harness, bash and any workspace without its own sandbox. */
  sandboxes?: readonly (SandboxResource | string)[];
  workspaces?: readonly AgentWorkspaceInput[];
  subagent?: AgentSubagentDefinitionConfig;
  skills?: AgentSkillsDefinitionConfig;
  policies?: readonly (PolicyResource | string)[];
  /** Serve this agent on the public runtime endpoint. Off by default. */
  publicAccess?: boolean;
  /** Accept `system` and `model` run overrides; off answers `403 run_overrides_disabled`. */
  allowRunOverrides?: boolean;
};

export type CronDefinitionConfig = Omit<CreateCronInput, "agentId" | "name"> & {
  agent: AgentResource | string;
};

export type AgentResource<Name extends string = string> = ResourceDefinition<
  "agent",
  Name,
  AgentDefinitionConfig
>;
export type WorkspaceDefinitionConfig = Omit<
  WorkspaceConfig,
  "isolation" | "storage"
> & {
  storage?: WorkspaceStorageDefinition;
  /** "conversation" lets a channel's `partition` split it; "agent" splits it per agent. */
  partitioned?: WorkspaceIsolation;
};

type WorkspaceStorageAuthConfig = NonNullable<
  WorkspaceConfig["storage"]["auth"]
>;
type WorkspaceR2Auth = Extract<WorkspaceStorageAuthConfig, { type: "r2" }>;

export type WorkspaceStorageDefinition = Omit<
  WorkspaceConfig["storage"],
  "auth"
> & {
  auth?:
    | Exclude<WorkspaceStorageAuthConfig, { type: "r2" }>
    | (Omit<WorkspaceR2Auth, "accessKeyId" | "secretAccessKey"> & {
        accessKeyId: string | EnvRef;
        secretAccessKey: string | EnvRef;
      });
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
 * A stage env var (`broods env set NAME`) the server fills in at run time, e.g.
 * `apiKey: env("OPENAI_API_KEY")`. Not `process.env`, which bakes the local value into the config.
 * A sync is refused while a referenced name has no stored value; `broods dev` pushes `.env.local`.
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
    get: function (target, property, receiver): unknown {
      if (typeof property === "string" && ENV_NAME_PATTERN.test(property)) {
        throw new Error(
          `env.${property} is not supported; use env("${property}")`,
        );
      }

      return Reflect.get(target, property, receiver);
    },
  },
);

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

export function defineBroods(
  config: BroodsProjectConfig,
): BroodsConfigDefinition {
  return { [CONFIG_MARKER]: true, config: config };
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

export function defineHarness<const Definition extends HarnessDefinition>(
  definition: Definition,
): Definition {
  return definition;
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

export function defineGoogleChatConnection(
  config: GoogleChatConnectionInput,
): GoogleChatConnectionDefinition {
  return defineConnection("gchat", config);
}

export function defineInstagramConnection(
  config: InstagramConnectionInput,
): InstagramConnectionDefinition {
  return defineConnection("instagram", config);
}

export function defineLinearConnection(
  config: LinearConnectionInput,
): LinearConnectionDefinition {
  return defineConnection("linear", config);
}

export function defineMatrixConnection(
  config: MatrixConnectionInput,
): MatrixConnectionDefinition {
  return defineConnection("matrix", config);
}

export function defineMessengerConnection(
  config: MessengerConnectionInput,
): MessengerConnectionDefinition {
  return defineConnection("messenger", config);
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

export function defineTeamsConnection(
  config: TeamsConnectionInput,
): TeamsConnectionDefinition {
  return defineConnection("teams", config);
}

export function defineTelegramConnection(
  config: TelegramConnectionInput,
): TelegramConnectionDefinition {
  return defineConnection("telegram", config);
}

export function defineTwilioConnection(
  config: TwilioConnectionInput,
): TwilioConnectionDefinition {
  return defineConnection("twilio", config);
}

export function defineWhatsAppConnection(
  config: WhatsAppConnectionInput,
): WhatsAppConnectionDefinition {
  return defineConnection("whatsapp", config);
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
  const [owner, ...rest] = repo.split("/");
  if (!owner || rest.length !== 1 || !rest[0]) {
    throw new Error(
      `Channel "${name}" repo must be "owner/name", not "${repo}"`,
    );
  }

  return defineChannelResource(name, description, repo, owner, rules);
}

export function defineGoogleChatChannel<const Name extends string>(
  input: ResourceInput<Name, GoogleChatChannelInput>,
): ChannelResource<Name> {
  const { name, description, spaceName, ...rules } = input;

  return defineChannelResource(name, description, spaceName, undefined, rules);
}

export function defineInstagramChannel<const Name extends string>(
  input: ResourceInput<Name, InstagramChannelInput>,
): ChannelResource<Name> {
  const { name, description, igsid, ...rules } = input;

  return defineChannelResource(name, description, igsid, undefined, rules);
}

export function defineLinearChannel<const Name extends string>(
  input: ResourceInput<Name, LinearChannelInput>,
): ChannelResource<Name> {
  const { name, description, team, ...rules } = input;

  return defineChannelResource(name, description, team, undefined, rules);
}

export function defineMatrixChannel<const Name extends string>(
  input: ResourceInput<Name, MatrixChannelInput>,
): ChannelResource<Name> {
  const { name, description, channelId, ...rules } = input;

  return defineChannelResource(name, description, channelId, undefined, rules);
}

export function defineMessengerChannel<const Name extends string>(
  input: ResourceInput<Name, MessengerChannelInput>,
): ChannelResource<Name> {
  const { name, description, psid, ...rules } = input;

  return defineChannelResource(name, description, psid, undefined, rules);
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

export function defineTeamsChannel<const Name extends string>(
  input: ResourceInput<Name, TeamsChannelInput>,
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

export function defineTwilioChannel<const Name extends string>(
  input: ResourceInput<Name, TwilioChannelInput>,
): ChannelResource<Name> {
  const { name, description, from, ...rules } = input;

  return defineChannelResource(name, description, from, undefined, rules);
}

export function defineWhatsAppChannel<const Name extends string>(
  input: ResourceInput<Name, WhatsAppChannelInput>,
): ChannelResource<Name> {
  const { name, description, waId, ...rules } = input;

  return defineChannelResource(name, description, waId, undefined, rules);
}

export function defineZaloChannel<const Name extends string>(
  input: ResourceInput<Name, ZaloChannelInput>,
): ChannelResource<Name> {
  const { name, description, chatId, ...rules } = input;

  return defineChannelResource(name, description, chatId, undefined, rules);
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

export function isConnectionDefinition(
  value: unknown,
): value is AnyConnectionDefinition {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [CONNECTION_MARKER]?: boolean })[CONNECTION_MARKER],
  );
}

export function isResource(value: unknown): value is AnyResource {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { [RESOURCE_MARKER]?: boolean })[RESOURCE_MARKER],
  );
}

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

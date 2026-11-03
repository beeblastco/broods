import { describe, expect, test } from "bun:test";
import { z } from "zod/mini";
import { AGENT_HOOK_EVENT_NAMES } from "@broods/convex/model/accountHooks";
import { SANDBOX_REMOVED_MESSAGE } from "@broods/convex/model/agentConfigCodec";
import {
  AGENT_CONFIG as SHARED_AGENT_CONFIG,
  AGENT_HARNESS_DEBUG_LEVELS,
  AGENT_HARNESS_PERMISSION_MODES,
  AGENT_HARNESS_TYPES,
  AGENT_LIFECYCLE_EVENT_NAMES,
  MODEL_CONFIG_SETTING_KEYS,
  assertAgentRuntimeRefs,
  isPrivateHostname,
  isProviderToolName,
  normalizeAgentConfig,
  type AgentConfigCheckOptions,
} from "@broods/convex/model/agentRules";
import { ClientError } from "@broods/convex/model/clientError";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  PROVIDER_ENDPOINT_SETTING,
} from "@broods/convex/model/modelProviders";
import { workspaceOnLaterSandbox } from "@broods/convex/model/sandboxMounts";
import { MAX_CONFIGURED_SKILLS } from "@broods/convex/model/skillLimits";
import { stringValues } from "@broods/convex/model/storedJson";
import { COMPILED_AGENT_CONFIG } from "../src/shared/domain/agent-config.ts";
import corpus from "./agent-config-corpus.json" with { type: "json" };

// Reference: AGENT_CONFIG, normalizeAgentConfig and the inputSchema helpers as of d5bbc0b7.
const nonEmptyString = z.string({ error: "must be a non-empty string" }).check(
  z.refine((value): boolean => value.trim().length > 0, {
    error: "must be a non-empty string",
  }),
);

const nonEmptyStrings = wholeValue(
  z.array(nonEmptyString),
  "must be an array of non-empty strings",
);

const AGENT_HARNESS_STARTUP_TIMEOUT_LIMIT = 10 * 60 * 1_000;
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 10_000_000;
const AI_GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const CHANNEL_PARTITION_MODES = ["shared", "conversation"] as const;

const RETIRED_PARTITION_KEYS = [
  "workspaceIsolationScope",
  "workspaceScope",
] as const;

const RETIRED_REACH_KEYS = [
  ["allowedChatIds", "allowedChannelIds"],
  ["allowedGroupIds", "allowedChannelIds"],
  ["allowedGuildIds", "allowedChannelIds"],
  ["allowedRepos", "allowedChannelIds"],
] as const;
const MODEL_TIMEOUT_KEYS = [
  "totalMs",
  "stepMs",
  "firstChunkMs",
  "chunkMs",
  "toolMs",
  "tools",
] as const;
const MAX_TIMER_MS = 2_147_483_647;

const AI_GATEWAY_ID_ERROR =
  "must be an AI Gateway id (letters, digits, - and _)";
const CHANNEL_TRACE_MODES = ["enabled", "disabled"] as const;
const SYSTEM_MESSAGE_ERROR =
  "must be a string, SystemModelMessage, or SystemModelMessage[]: invalid system message";
const optionalString = z.optional(z.string());
const optionalBoolean = z.optional(z.boolean());
const timerMs = positiveInteger(MAX_TIMER_MS);
const publicHttpsUrl = z.string().check(
  z.superRefine((value, ctx): void => {
    const problem = publicHttpsUrlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
);
const convexDocumentId = (error: string): z.ZodMiniString =>
  z
    .string({ error: error })
    .check(z.refine(isNativeConvexDocumentId, { error: error }));
const eventList = (events: readonly string[]): z.ZodMiniType<string[]> =>
  wholeValue(
    z.array(z.enum(events)),
    `must be an array of: ${events.join(", ")}`,
  );
const patternString = (pattern: RegExp, error: string): z.ZodMiniString =>
  z.string().check(z.regex(pattern, { error: error }));
const graphApiVersion = patternString(/^v\d+\.\d+$/, 'must look like "v21.0"');
const workspaceName = nonEmptyString.check(
  z.regex(/^[A-Za-z0-9._-]+$/, {
    error: "must use only letters, numbers, dots, underscores, or hyphens",
  }),
);

const SYSTEM_MESSAGE = z.looseObject({
  role: z.literal("system"),
  content: z.string(),
  providerOptions: z.optional(
    z.record(z.string(), z.record(z.string(), z.unknown())),
  ),
});

const AGENT_BEHAVIOR = z.looseObject({
  maxTurn: z.optional(
    z
      .number({ error: "must be a non-negative integer (0 lifts the cap)" })
      .check(
        z.refine(
          (value): boolean => Number.isSafeInteger(value) && value >= 0,
          {
            error: "must be a non-negative integer (0 lifts the cap)",
          },
        ),
      ),
  ),
  system: z.optional(
    wholeValue(
      z.union([z.string(), SYSTEM_MESSAGE, z.array(SYSTEM_MESSAGE)]),
      SYSTEM_MESSAGE_ERROR,
    ),
  ),
});

const HARNESS = z
  .strictObject({
    type: z.enum(AGENT_HARNESS_TYPES),
    permissionMode: z.optional(z.enum(AGENT_HARNESS_PERMISSION_MODES)),
    startupTimeoutMs: z.optional(
      positiveInteger(AGENT_HARNESS_STARTUP_TIMEOUT_LIMIT),
    ),
    webSearch: optionalBoolean,
    activeTools: z.optional(nonEmptyStrings),
    inactiveTools: z.optional(nonEmptyStrings),
    debug: z.optional(
      z.strictObject({
        enabled: optionalBoolean,
        level: z.optional(z.enum(AGENT_HARNESS_DEBUG_LEVELS)),
        subsystems: z.optional(nonEmptyStrings),
      }),
    ),
  })
  .check(
    z.superRefine((harness, ctx): void => {
      if (
        harness.activeTools !== undefined &&
        harness.inactiveTools !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "must use either activeTools or inactiveTools, not both",
        });
      if (
        harness.type === "codex" &&
        harness.permissionMode !== undefined &&
        harness.permissionMode !== "allow-all"
      )
        ctx.addIssue({
          code: "custom",
          path: ["permissionMode"],
          message: "must be allow-all for the codex harness",
        });
      if (harness.type !== "codex" && harness.webSearch !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["webSearch"],
          message: "is only supported by the codex harness",
        });
      if (harness.type === "pi" && harness.startupTimeoutMs !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["startupTimeoutMs"],
          message: "is not supported by the pi harness",
        });
    }),
  );

const MODEL_TIMEOUT = z.union(
  [
    timerMs,
    z
      .looseObject({
        totalMs: z.optional(timerMs),
        stepMs: z.optional(timerMs),
        firstChunkMs: z.optional(timerMs),
        chunkMs: z.optional(timerMs),
        toolMs: z.optional(timerMs),
        tools: z.optional(
          z.record(
            z.string().check(
              z.regex(/^.+Ms$/, {
                error: "must be named {toolName}Ms, like bashMs",
              }),
            ),
            z.optional(timerMs),
            {
              error: (issue): string | undefined =>
                issue.code === "invalid_type"
                  ? "must be an object of {toolName}Ms limits"
                  : undefined,
            },
          ),
        ),
      })
      .check(
        z.superRefine((timeout, ctx): void => {
          for (const key of Object.keys(timeout)) {
            if (!(MODEL_TIMEOUT_KEYS as readonly string[]).includes(key))
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `is not supported; use one of: ${MODEL_TIMEOUT_KEYS.join(", ")}`,
              });
          }
        }),
      ),
  ],
  {
    error: `must be a number of milliseconds or an object with ${MODEL_TIMEOUT_KEYS.join(", ")}`,
  },
);

const MODEL_OUTPUT = z.discriminatedUnion(
  "type",
  [
    z.looseObject({
      type: z.literal("text"),
      name: optionalString,
      description: optionalString,
    }),
    z.looseObject({
      type: z.literal("object"),
      name: optionalString,
      description: optionalString,
      schema: z.record(z.string(), z.unknown()),
    }),
    z.looseObject({
      type: z.literal("array"),
      name: optionalString,
      description: optionalString,
      element: z.record(z.string(), z.unknown()),
    }),
    z.looseObject({
      type: z.literal("choice"),
      name: optionalString,
      description: optionalString,
      options: wholeValue(
        z.array(z.string()).check(z.minLength(1)),
        "must be a non-empty array of strings",
      ),
    }),
    z.looseObject({
      type: z.literal("json"),
      name: optionalString,
      description: optionalString,
    }),
  ],
  {
    error: (issue): string | undefined =>
      issue.code === "invalid_union"
        ? "must be one of: text, object, array, choice, json"
        : undefined,
  },
);

const MODEL = z
  .looseObject({
    provider: z.optional(z.enum(ACCOUNT_MODEL_PROVIDER_NAMES)),
    modelId: optionalString,
    transcriptionModelId: optionalString,
    reasoning: z.optional(
      z.enum([
        "provider-default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ),
    providerOptions: z.optional(z.record(z.string(), z.unknown())),
    timeout: z.optional(MODEL_TIMEOUT),
    output: z.optional(MODEL_OUTPUT),
  })
  .check(
    z.superRefine((model, ctx): void => {
      for (const key of Object.keys(model)) {
        if (!(MODEL_CONFIG_SETTING_KEYS as readonly string[]).includes(key))
          ctx.addIssue({
            code: "custom",
            path: [key],
            message:
              "is not supported; use {parent}.providerOptions for provider-specific settings",
          });
      }
    }),
  );

const PROVIDER_SETTINGS = z.pipe(
  z
    .looseObject({
      apiKey: optionalString,
      gatewayId: z.optional(
        z
          .string({ error: AI_GATEWAY_ID_ERROR })
          .check(
            z.regex(AI_GATEWAY_ID_PATTERN, { error: AI_GATEWAY_ID_ERROR }),
          ),
      ),
      base_url: optionalString,
      baseURL: optionalString,
      headers: z.optional(stringRecord("must be an object with string values")),
    })
    .check(
      z.superRefine((settings, ctx): void => {
        const baseURL = providerBaseURL(settings);
        if (baseURL) {
          const problem = publicHttpsUrlProblem(baseURL);
          const label =
            typeof settings.base_url === "string" ? "base_url" : "baseURL";
          if (problem)
            ctx.addIssue({ code: "custom", path: [label], message: problem });
        }
        for (const [key, endpoint] of Object.entries(settings)) {
          if (key === "baseURL" || (key === "base_url" && baseURL)) continue;
          if (!PROVIDER_ENDPOINT_SETTING.test(key) || endpoint === undefined)
            continue;
          if (typeof endpoint !== "string") {
            ctx.addIssue({
              code: "custom",
              path: [key],
              message: "must be a string",
            });
            continue;
          }
          const problem = endpoint.trim()
            ? publicHttpsUrlProblem(endpoint.trim())
            : undefined;
          if (problem)
            ctx.addIssue({ code: "custom", path: [key], message: problem });
        }
      }),
    ),
  z.transform((settings) => {
    const baseURL = providerBaseURL(settings);
    if (!baseURL) return settings;
    const { base_url: _baseUrl, ...rest } = settings;

    return { ...rest, baseURL: baseURL };
  }),
);

const PROVIDERS = refusingProtoKey(
  z
    .partialRecord(
      z.pipe(
        z.string(),
        z.enum(ACCOUNT_MODEL_PROVIDER_NAMES, {
          error: "is not a supported provider",
        }),
      ),
      PROVIDER_SETTINGS,
    )
    .check(
      z.superRefine((providers, ctx): void => {
        const custom = providers.custom;
        if (!custom || providerBaseURL(custom)) return;
        ctx.addIssue({
          code: "custom",
          path: ["custom", "base_url"],
          message: `is required${custom.baseUrl !== undefined ? ` (found "baseUrl", use "base_url" or "baseURL")` : ""}`,
        });
      }),
    ),
  "is not a supported provider",
);

const WORKSPACE_REF = z.looseObject({
  name: workspaceName,
  workspaceId: z
    .string({
      error: (issue): string =>
        issue.input === undefined
          ? "must be a non-empty string"
          : "must be a string",
    })
    .check(
      z.refine((value): boolean => value.trim().length > 0, {
        error: "must be a non-empty string",
      }),
    ),
  sandbox: z.nullish(
    z.string({ error: "must be a non-empty string or null" }).check(
      z.refine((value): boolean => value.trim().length > 0, {
        error: "must be a non-empty string or null",
      }),
    ),
  ),
});

const WORKSPACE_REFS = z.array(WORKSPACE_REF).check(
  z.superRefine((refs, ctx): void => {
    const seen = new Set<string>();
    refs.forEach((ref, index): void => {
      if (seen.has(ref.name))
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `"${ref.name}" is used more than once`,
        });
      seen.add(ref.name);
    });
  }),
);

const WEBHOOK_HOOK = z
  .looseObject({
    enabled: optionalBoolean,
    url: z.optional(nonEmptyString),
    secret: z.optional(nonEmptyString),
    events: z.optional(eventList(AGENT_LIFECYCLE_EVENT_NAMES)),
  })
  .check(
    z.superRefine((hook, ctx): void => {
      if (hook.enabled === true) {
        for (const key of ["url", "secret"] as const) {
          if (hook[key] === undefined)
            ctx.addIssue({
              code: "custom",
              path: [key],
              message: "is required when {parent}.enabled is true",
            });
        }
      }
      const problem = hook.url ? publicHttpsUrlProblem(hook.url) : undefined;
      if (problem)
        ctx.addIssue({ code: "custom", path: ["url"], message: problem });
    }),
  );

const CODE_HOOK = z.looseObject({
  hookId: convexDocumentId("must be a native Convex document id"),
  enabled: optionalBoolean,
  events: z.optional(eventList(AGENT_HOOK_EVENT_NAMES)),
});

const HOOKS = z.looseObject({
  webhooks: z.optional(z.array(WEBHOOK_HOOK)),
  code: z.optional(z.array(CODE_HOOK)),
});

const PARTITION = z
  .looseObject({
    by: z.enum(CHANNEL_PARTITION_MODES),
    alias: z.optional(z.unknown()),
  })
  .check(
    z.superRefine((partition, ctx): void => {
      const { alias } = partition;
      if (partition.by === "shared") {
        if (alias !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["alias"],
            message: "is only supported when {parent}.by is conversation",
          });

        return;
      }
      const message =
        typeof alias !== "string" || !alias.trim()
          ? "must be a non-empty string"
          : /^[A-Za-z0-9._-]+$/.test(alias)
            ? undefined
            : "must use only letters, numbers, dots, underscores, or hyphens";
      if (message)
        ctx.addIssue({ code: "custom", path: ["alias"], message: message });
    }),
  );

const RETIRED_CHANNEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ...RETIRED_REACH_KEYS,
  ...RETIRED_PARTITION_KEYS.map((retired): readonly [string, string] => [
    retired,
    "partition",
  ]),
];

const CHANNEL_IDENTITY = {
  id: nonEmptyString,
  trace: z.optional(z.enum(CHANNEL_TRACE_MODES)),
  allowedChannelIds: z.optional(nonEmptyStrings),
  allowedUserIds: z.optional(nonEmptyStrings),
  partition: z.optional(PARTITION),
};
const RETIRED_CHANNEL_KEY_CHECK = z.superRefine(
  (channel: Record<string, unknown>, ctx): void => {
    for (const [retired, replacement] of RETIRED_CHANNEL_KEYS) {
      if (channel[retired] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [retired],
          message: `is no longer supported; use {parent}.${replacement}`,
        });
    }
  },
);

const TELEGRAM = channelSchema({
  apiUrl: z.optional(publicHttpsUrl),
  botToken: optionalString,
  webhookSecret: optionalString,
  botUsername: optionalString,
  reactionEmoji: optionalString,
});
const GCHAT = channelSchema({
  credentials: optionalString,
  endpointUrl: z.optional(publicHttpsUrl),
  googleChatProjectNumber: z.optional(
    patternString(/^\d+$/, "must be the numeric project number"),
  ),
  workspaceAddOnServiceAccountEmail: optionalString,
  userName: optionalString,
});
const GITHUB = channelSchema({
  apiUrl: z.optional(publicHttpsUrl),
  webhookSecret: optionalString,
  appId: optionalString,
  privateKey: optionalString,
  botUserName: optionalString,
  botUserId: z.optional(positiveInteger(Number.MAX_SAFE_INTEGER)),
});
const LINEAR = channelSchema({
  apiKey: optionalString,
  apiUrl: z.optional(publicHttpsUrl),
  userName: optionalString,
  webhookSecret: optionalString,
});
const SLACK = channelSchema({
  apiUrl: z.optional(publicHttpsUrl),
  botToken: optionalString,
  signingSecret: optionalString,
  reactionEmoji: optionalString,
});
const DISCORD = channelSchema({
  apiUrl: z.optional(publicHttpsUrl),
  botToken: optionalString,
  publicKey: optionalString,
  botUserId: optionalString,
  mentionRoleIds: z.optional(nonEmptyStrings),
});
const PANCAKE = channelSchema({
  pageId: optionalString,
  pageAccessToken: optionalString,
  webhookSecret: optionalString,
  senderId: optionalString,
});
const TEAMS = channelSchema({
  apiUrl: z.optional(publicHttpsUrl),
  appId: optionalString,
  appPassword: optionalString,
  appTenantId: optionalString,
  appType: z.optional(z.enum(["MultiTenant", "SingleTenant"])),
  userName: optionalString,
});
const TWILIO = channelSchema({
  accountSid: optionalString,
  authToken: optionalString,
  apiUrl: z.optional(publicHttpsUrl),
  statusCallbackUrl: z.optional(publicHttpsUrl),
  webhookUrl: z.optional(publicHttpsUrl),
  messagingServiceSid: z.optional(
    patternString(
      /^MG[0-9a-fA-F]{32}$/,
      'must be a Messaging Service sid ("MG" and 32 hex digits)',
    ),
  ),
  phoneNumber: z.optional(
    patternString(
      /^\+[1-9]\d{1,14}$/,
      'must be an E.164 number, e.g. "+15551234567"',
    ),
  ),
  userName: optionalString,
});
const ZALO = channelSchema({
  botToken: optionalString,
  webhookSecret: z.optional(
    z
      .string()
      .check(
        z.refine(
          (secret): boolean => secret.length >= 8 && secret.length <= 256,
          { error: "must be 8 to 256 characters" },
        ),
      ),
  ),
});
const INSTAGRAM = channelSchema({
  accessToken: optionalString,
  accountId: z.optional(
    patternString(/^\d+$/, "must be the numeric Instagram account id"),
  ),
  apiVersion: z.optional(graphApiVersion),
  appSecret: optionalString,
  userName: optionalString,
  verifyToken: optionalString,
});
const MESSENGER = channelSchema({
  apiVersion: z.optional(graphApiVersion),
  appSecret: optionalString,
  pageAccessToken: optionalString,
  userName: optionalString,
  verifyToken: optionalString,
});
const WHATSAPP = channelSchema({
  accessToken: optionalString,
  apiUrl: z.optional(publicHttpsUrl),
  apiVersion: z.optional(
    patternString(/^v\d+\.\d+$/, 'must look like "v25.0"'),
  ),
  appSecret: optionalString,
  phoneNumberId: z.optional(
    patternString(/^\d+$/, "must be the number's digits-only ID"),
  ),
  userName: optionalString,
  verifyToken: optionalString,
});

const CHANNELS = z.looseObject({
  telegram: z.nullish(TELEGRAM),
  gchat: z.nullish(GCHAT),
  github: z.nullish(GITHUB),
  linear: z.nullish(LINEAR),
  slack: z.nullish(SLACK),
  discord: z.nullish(DISCORD),
  pancake: z.nullish(PANCAKE),
  teams: z.nullish(TEAMS),
  twilio: z.nullish(TWILIO),
  zalo: z.nullish(ZALO),
  instagram: z.nullish(INSTAGRAM),
  messenger: z.nullish(MESSENGER),
  whatsapp: z.nullish(WHATSAPP),
});

const TOOLS = z.record(
  z
    .string()
    .check(z.refine(isProviderToolName, { error: "is not a supported tool" })),
  z.looseObject({
    enabled: optionalBoolean,
    needsApproval: optionalBoolean,
    config: z.optional(z.record(z.string(), z.unknown())),
  }),
);

const MCP = refusingProtoKey(
  z.record(
    convexDocumentId("must be keyed by an MCP server id"),
    z.looseObject({
      enabled: optionalBoolean,
      needsApproval: optionalBoolean,
      headers: z.optional(stringRecord("must be an object of string values")),
      oauth: z.optional(stringRecord("must be an object of string values")),
    }),
  ),
  "must be keyed by an MCP server id",
);

const SKILLS = z
  .looseObject({
    enabled: optionalBoolean,
    allowed: z.optional(nonEmptyStrings),
  })
  .check(
    z.superRefine((skills, ctx): void => {
      if (new Set(skills.allowed).size > MAX_CONFIGURED_SKILLS)
        ctx.addIssue({
          code: "custom",
          path: ["allowed"],
          message: `must list at most ${MAX_CONFIGURED_SKILLS} skills`,
        });
    }),
  );

const SUBAGENT = z.looseObject({
  enabled: optionalBoolean,
  stream: optionalBoolean,
  allowed: z.optional(nonEmptyStrings),
  context: z.optional(z.enum(["new", "inherited"])),
  mode: z.optional(z.enum(["ephemeral", "persistent"])),
  visibility: z.optional(z.enum(["full", "result", "none"])),
  model: z.nullish(MODEL),
});

const ENABLED_SWITCH = z.looseObject({ enabled: optionalBoolean });

const AGENT_CONFIG = z.looseObject({
  agent: z.nullish(AGENT_BEHAVIOR),
  harness: z.nullish(HARNESS),
  model: z.nullish(MODEL),
  provider: z.nullish(PROVIDERS),
  workspaces: z.nullish(WORKSPACE_REFS),
  sandboxes: z.optional(nonEmptyStrings),
  session: z.nullish(
    z
      .looseObject({
        pruning: z.nullish(z.looseObject({ enabled: optionalBoolean })),
        autoCompaction: z.nullish(
          z.looseObject({
            enabled: optionalBoolean,
            maxContextLength: z.optional(
              positiveInteger(SESSION_MAX_CONTEXT_LENGTH_LIMIT),
            ),
          }),
        ),
      })
      .check(
        z.superRefine((session, ctx): void => {
          if (session.compaction !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["compaction"],
              message:
                "was renamed to {parent}.autoCompaction, and maxContextLength now counts input tokens",
            });
        }),
      ),
  ),
  hooks: z.nullish(HOOKS),
  channels: z.nullish(CHANNELS),
  tools: z.nullish(TOOLS),
  mcp: z.nullish(MCP),
  denyTools: z.optional(nonEmptyStrings),
  skills: z.nullish(SKILLS),
  subagent: z.nullish(SUBAGENT),
  scheduler: z.nullish(ENABLED_SWITCH),
  browser: z.nullish(ENABLED_SWITCH),
  policies: z.nullish(nonEmptyStrings),
  publicAccess: optionalBoolean,
  allowRunOverrides: optionalBoolean,
});

const AGENT_RUNTIME_REFS = z.looseObject({
  harness: z.optional(z.unknown()),
  workspaces: z.nullish(WORKSPACE_REFS),
  sandboxes: z.optional(nonEmptyStrings),
});
const HARNESS_TYPE = z.looseObject({ type: z.optional(z.unknown()) });

type Issue = z.core.$ZodIssue;
type RawIssue = z.core.$ZodRawIssue;
type AgentConfig = z.output<typeof AGENT_CONFIG>;
type AgentChannelsConfig = z.output<typeof CHANNELS>;
type AgentRuntimeRefs = Pick<
  z.output<typeof AGENT_RUNTIME_REFS>,
  "sandboxes" | "workspaces"
> & { harness?: unknown; sandbox?: unknown };

// End of reference schemas; the reference functions sit with the helpers below.

const GENERATED_CASES = 12_000;
const SEED = 0x5eed_c0de;
const ANY_KEY = "*";
const CONVEX_ID = "k57a1b2c3d4e5f6g7h8j9k0m";

type ConfigValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue };
type ConfigObject = { [key: string]: ConfigValue };
type Outcome =
  | { ok: true; output: unknown; json: string; inputKept: boolean }
  | { ok: false; error: string; inputKept: boolean };
type Path = readonly (string | number)[];
type Random = () => number;
type Slot = { path: readonly string[]; options: readonly ConfigValue[] };
type Mismatch = {
  input: string;
  patch: boolean;
  check: string;
  outcomes: Outcome[];
};
type Mutation = (
  random: Random,
  config: ConfigValue,
  seeds: readonly ConfigValue[],
  slots: readonly Slot[],
) => ConfigValue;

// Captured from every normalizeAgentConfig call the convex and core test suites make.
const CORPUS: readonly { patch: boolean; value: ConfigValue }[] = corpus;

const FULL_CONFIGS: readonly ConfigValue[] = [
  {
    agent: {
      system: [
        {
          role: "system",
          content: "Answer in one paragraph.",
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
      maxTurn: 0,
    },
    model: {
      provider: "openai",
      modelId: "gpt-5",
      transcriptionModelId: "whisper-1",
      reasoning: "low",
      providerOptions: { openai: { store: false } },
      temperature: 0.3,
      maxOutputTokens: 1024,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0,
      frequencyPenalty: 0,
      stopSequences: ["END"],
      seed: 7,
      maxRetries: 2,
      timeout: {
        totalMs: 60_000,
        stepMs: 30_000,
        firstChunkMs: 5_000,
        chunkMs: 1_000,
        toolMs: 20_000,
        tools: { bashMs: 10_000 },
      },
      output: {
        type: "object",
        name: "Answer",
        description: "The answer",
        schema: { type: "object" },
      },
    },
    provider: {
      openai: {
        apiKey: "sk-test",
        gatewayId: "gw_main-1",
        baseURL: "https://api.openai.com/v1",
        headers: { "x-org": "org_1" },
      },
      custom: {
        apiKey: "key",
        base_url: " https://inference.example.com/v1 ",
        visionUrl: "https://vision.example.com/v1",
      },
    },
    workspaces: [
      { name: "repo", workspaceId: "ws_repo", sandbox: null },
      { name: "docs", workspaceId: "ws_docs", sandbox: "sbx_main" },
    ],
    sandboxes: ["sbx_main", "sbx_gpu"],
    session: {
      pruning: { enabled: true },
      autoCompaction: { enabled: true, maxContextLength: 200_000 },
    },
    hooks: {
      webhooks: [
        {
          enabled: true,
          url: "https://hooks.example.com/agent",
          secret: "whsec",
          events: ["agent.started", "tool.result"],
        },
      ],
      code: [{ hookId: CONVEX_ID, enabled: true, events: ["agent.finished"] }],
    },
    channels: {
      telegram: {
        id: "tg",
        trace: "enabled",
        allowedChannelIds: ["-100"],
        allowedUserIds: ["42"],
        partition: { by: "conversation", alias: "team.a" },
        apiUrl: "https://api.telegram.org",
        botToken: "tg-token",
        webhookSecret: "tg-secret",
        botUsername: "bot",
        reactionEmoji: "eyes",
      },
      gchat: {
        id: "gc",
        credentials: "{}",
        endpointUrl: "https://chat.example.com/hook",
        googleChatProjectNumber: "1234",
        workspaceAddOnServiceAccountEmail: "bot@example.com",
        userName: "bot",
      },
      github: {
        id: "gh",
        apiUrl: "https://api.github.com",
        webhookSecret: "gh-secret",
        appId: "1",
        privateKey: "pem",
        botUserName: "bot",
        botUserId: 42,
      },
      linear: {
        id: "li",
        apiKey: "lin-key",
        apiUrl: "https://api.linear.app",
        userName: "Bot",
        webhookSecret: "li-secret",
      },
      slack: {
        id: "sl",
        apiUrl: "https://slack.com/api",
        botToken: "xoxb",
        signingSecret: "sig",
        reactionEmoji: "eyes",
        partition: { by: "shared" },
      },
      discord: {
        id: "dc",
        apiUrl: "https://discord.com/api",
        botToken: "dc-token",
        publicKey: "pk",
        botUserId: "1",
        mentionRoleIds: ["r1"],
      },
      pancake: {
        id: "pc",
        pageId: "1",
        pageAccessToken: "pat",
        webhookSecret: "pc-secret",
        senderId: "s",
      },
      teams: {
        id: "tm",
        apiUrl: "https://smba.trafficmanager.net",
        appId: "app",
        appPassword: "pw",
        appTenantId: "tenant",
        appType: "SingleTenant",
        userName: "bot",
      },
      twilio: {
        id: "tw",
        accountSid: "AC1",
        authToken: "tw-token",
        apiUrl: "https://api.twilio.com",
        statusCallbackUrl: "https://callbacks.example.com/status",
        webhookUrl: "https://callbacks.example.com/inbound",
        messagingServiceSid: `MG${"0123456789abcdef".repeat(2)}`,
        phoneNumber: "+15551234567",
        userName: "bot",
      },
      zalo: { id: "za", botToken: "za-token", webhookSecret: "12345678" },
      instagram: {
        id: "ig",
        accessToken: "ig-token",
        accountId: "123",
        apiVersion: "v21.0",
        appSecret: "ig-secret",
        userName: "bot",
        verifyToken: "verify",
      },
      messenger: {
        id: "ms",
        apiVersion: "v21.0",
        appSecret: "ms-secret",
        pageAccessToken: "ms-token",
        userName: "bot",
        verifyToken: "verify",
      },
      whatsapp: {
        id: "wa",
        accessToken: "wa-token",
        apiUrl: "https://graph.facebook.com",
        apiVersion: "v25.0",
        appSecret: "wa-secret",
        phoneNumberId: "123",
        userName: "bot",
        verifyToken: "verify",
      },
    },
    tools: {
      googleSearch: { enabled: true, needsApproval: false, config: { max: 5 } },
    },
    mcp: {
      [CONVEX_ID]: {
        enabled: true,
        needsApproval: true,
        headers: { Authorization: "Bearer token" },
        oauth: { clientId: "client" },
      },
    },
    denyTools: ["bash"],
    skills: { enabled: true, allowed: ["triage", "deploy", "triage"] },
    subagent: {
      enabled: true,
      stream: true,
      allowed: ["helper"],
      context: "new",
      mode: "ephemeral",
      visibility: "result",
      model: {
        provider: "anthropic",
        modelId: "claude-haiku-5-5",
        timeout: 30_000,
      },
    },
    scheduler: { enabled: true },
    browser: { enabled: false },
    policies: ["policy_a", "policy_b", "policy_a"],
    publicAccess: true,
    allowRunOverrides: false,
    custom: { kept: true },
  },
  {
    agent: { system: "Be brief.", maxTurn: 25 },
    harness: {
      type: "codex",
      permissionMode: "allow-all",
      webSearch: true,
      startupTimeoutMs: 120_000,
      inactiveTools: ["browse"],
      debug: { enabled: true, level: "debug", subsystems: ["rpc"] },
    },
    model: {
      provider: "custom",
      modelId: "qwen",
      output: { type: "text" },
      timeout: 90_000,
    },
    provider: { custom: { baseURL: "https://inference.example.com/v1" } },
    sandboxes: ["sbx_main"],
    workspaces: [{ name: "repo", workspaceId: "ws_repo" }],
    session: { pruning: null, autoCompaction: { enabled: false } },
    hooks: { webhooks: [{ enabled: false }] },
    channels: {
      slack: { id: "sl", botToken: "xoxb", signingSecret: "sig" },
      teams: { id: "tm", appId: "app", appType: "MultiTenant" },
      zalo: null,
    },
    tools: null,
    skills: { allowed: [] },
    subagent: { model: null },
  },
];

const PROTO_KEYED: ConfigObject = {};
setChild(PROTO_KEYED, "__proto__", { a: 1 });

const VALUE_POOL: readonly ConfigValue[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  1,
  1.5,
  600_001,
  2 ** 31,
  Number.MAX_SAFE_INTEGER + 2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "  ",
  "x",
  "text",
  "codex",
  "allow-all",
  "conversation",
  "https://inference.example.com/v1",
  "http://example.com",
  "https://10.0.0.1",
  "https://localhost:3000",
  "https://[::1]/x",
  "not a url",
  CONVEX_ID,
  "v21.0",
  "+15551234567",
  "1234",
  [],
  [""],
  ["a"],
  ["a", "a"],
  [1],
  [null],
  {},
  { a: 1 },
  { type: "text" },
  { type: "choice", options: [] },
  { enabled: "yes" },
  { role: "system", content: "c" },
  { by: "conversation", alias: "a b" },
  PROTO_KEYED,
];

const EXTRA_KEYS: readonly string[] = [
  "unknownKey",
  "compaction",
  "policy",
  "sandbox",
  "baseUrl",
  "allowedChatIds",
  "allowedGroupIds",
  "allowedGuildIds",
  "allowedRepos",
  "workspaceScope",
  "workspaceIsolationScope",
  "fooMs",
  "bash",
  "tool_x",
  "1abc",
  "__proto__",
  "visionUrl",
  "type",
  "openai",
  "custom",
];

const RENAMES: Readonly<Record<string, string>> = {
  autoCompaction: "compaction",
  base_url: "baseUrl",
  baseURL: "baseUrl",
  allowedChannelIds: "allowedChatIds",
  partition: "workspaceScope",
  policies: "policy",
  sandboxes: "sandbox",
  maxContextLength: "maxContextTokens",
  timeout: "timeoutMs",
};

const RECORD_KEYS: readonly string[] = [
  "custom",
  "openai",
  "googleSearch",
  CONVEX_ID,
  "not a provider",
  "bash",
];

// Weighted: a seed as is, one schema option set, one field replaced, removed, added or renamed,
// or two seeds crossed.
const MUTATIONS: readonly [number, Mutation][] = [
  [0.1, (_random, config): ConfigValue => config],
  [0.3, setSlot],
  [0.2, replaceNode],
  [0.1, deleteNode],
  [0.12, addKey],
  [0.1, renameKey],
  [0.08, crossSeeds],
];

describe("normalizeAgentConfig matches the pre-compile reference", () => {
  test("every config the convex and core suites normalize", () => {
    expect(CORPUS.length).toBeGreaterThan(150);
    const mismatches = CORPUS.flatMap(({ patch, value }) => [
      ...compare(value, patch),
      ...compare(value, !patch),
    ]);

    expect(mismatches).toEqual([]);
  });

  test("the hand-built full configs are valid", () => {
    for (const config of FULL_CONFIGS) {
      expect(() => referenceNormalizeAgentConfig(clone(config))).not.toThrow();
    }

    expect(FULL_CONFIGS.flatMap((config) => compare(config, false))).toEqual(
      [],
    );
  });

  test("core checks with a compiled copy, not the interpreted schema", () => {
    expect(COMPILED_AGENT_CONFIG).not.toBe(SHARED_AGENT_CONFIG);
  });

  test(`${GENERATED_CASES} generated configs, valid and single-field mutations`, () => {
    const random = mulberry32(SEED);
    const slots = schemaSlots(AGENT_CONFIG, [], []);
    const seeds = [
      ...FULL_CONFIGS,
      ...FULL_CONFIGS,
      ...CORPUS.map((entry) => entry.value),
    ];
    const mismatches: Mismatch[] = [];
    let accepted = 0;
    for (let index = 0; index < GENERATED_CASES; index += 1) {
      const input = mutate(random, seeds, slots);
      const patch = random() < 0.15;
      mismatches.push(...compare(input, patch));
      const checked = outcome(input, (value) =>
        normalizeAgentConfig(value, { patch: patch }),
      );
      if (checked.ok) accepted += 1;
    }

    expect(slots.length).toBeGreaterThan(150);
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(accepted).toBeGreaterThan(GENERATED_CASES * 0.15);
    expect(GENERATED_CASES - accepted).toBeGreaterThan(GENERATED_CASES * 0.3);
  });
});

// Reference functions, as of d5bbc0b7.
function referenceNormalizeAgentConfig(
  value: unknown,
  options: AgentConfigCheckOptions = {},
): AgentConfig {
  if (value == null) {
    return {};
  }
  const { policies, ...config } = parseInput(AGENT_CONFIG, value, "config");
  assertRuntimeRefs(config, options);
  if (!options.patch && config.channels)
    assertCompleteChannels(config.channels);
  if (config.policy !== undefined) {
    throw new ClientError(
      "config.policy is no longer supported; use config.policies, and set mode on the policy itself",
    );
  }
  const policyIds = [...new Set(policies ?? [])];
  if (config.harness && policyIds.length > 0) {
    throw new ClientError(
      "config.policies is not supported with config.harness",
    );
  }
  for (const [model, label] of [
    [config.model, "config.model"],
    [config.subagent?.model, "config.subagent.model"],
  ] as const) {
    if (config.harness && model?.output && model.output.type !== "text") {
      throw new ClientError(
        `${label}.output structured output is not supported with config.harness`,
      );
    }
    if (config.harness && model?.providerOptions !== undefined) {
      throw new ClientError(
        `${label}.providerOptions is not supported with config.harness; set ${label}.reasoning`,
      );
    }
  }

  return {
    ...config,
    ...(config.skills?.allowed
      ? {
          skills: {
            ...config.skills,
            allowed: [...new Set(config.skills.allowed)],
          },
        }
      : {}),
    ...(policyIds.length > 0 ? { policies: policyIds } : {}),
  };
}

function referenceAssertAgentRuntimeRefs(
  config: Record<string, unknown>,
  options: AgentConfigCheckOptions = {},
): void {
  assertRuntimeRefs(parseInput(AGENT_RUNTIME_REFS, config, "config"), options);
}

function assertMetaCredentials(
  config: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): void {
  const present = fields.find((field) => config[field] !== undefined);
  if (!present) return;
  const empty = fields.find(
    (field) =>
      typeof config[field] === "string" && config[field].trim().length === 0,
  );
  if (empty)
    throw new ClientError(`${path}.${empty} must be a non-empty string`);
  const missing = fields.find((field) => config[field] === undefined);
  if (missing) {
    throw new ClientError(
      `${path}.${missing} is required when ${path}.${present} is set`,
    );
  }
}

function assertCompleteChannels(channels: AgentChannelsConfig): void {
  const { gchat, linear, teams, instagram, messenger } = channels;
  if (
    gchat?.credentials !== undefined &&
    gchat.endpointUrl === undefined &&
    gchat.googleChatProjectNumber === undefined
  ) {
    throw new ClientError(
      "config.channels.gchat needs endpointUrl or googleChatProjectNumber to verify webhooks",
    );
  }
  if (linear?.apiKey !== undefined) {
    if (!linear.userName?.trim()) {
      throw new ClientError(
        "config.channels.linear.userName is required: the display name of the member the API key belongs to",
      );
    }
    if (!linear.webhookSecret) {
      throw new ClientError(
        "config.channels.linear.webhookSecret is required when config.channels.linear.apiKey is set",
      );
    }
  }
  if (
    teams?.appId !== undefined &&
    teams.appType !== "MultiTenant" &&
    !teams.appTenantId?.trim()
  ) {
    throw new ClientError(
      'config.channels.teams.appTenantId is required unless appType is "MultiTenant"',
    );
  }
  if (instagram)
    assertMetaCredentials(instagram, "config.channels.instagram", [
      "accessToken",
      "accountId",
      "appSecret",
      "verifyToken",
    ]);
  if (messenger)
    assertMetaCredentials(messenger, "config.channels.messenger", [
      "appSecret",
      "pageAccessToken",
      "verifyToken",
    ]);
}

function assertRuntimeRefs(
  config: AgentRuntimeRefs,
  options: AgentConfigCheckOptions,
): void {
  if (config.sandbox !== undefined)
    throw new ClientError(SANDBOX_REMOVED_MESSAGE);
  const sandboxes = config.sandboxes ?? [];
  const seen = new Set<string>();
  sandboxes.forEach((sandboxId, index): void => {
    if (seen.has(sandboxId))
      throw new ClientError(
        `config.sandboxes[${index}] "${sandboxId}" is listed more than once`,
      );
    const mounted = workspaceOnLaterSandbox(
      sandboxes,
      index,
      config.workspaces,
    );
    if (mounted)
      throw new ClientError(
        `config.sandboxes[${index}] "${sandboxId}" also backs workspace "${mounted.name}"; only the first sandbox can back a workspace`,
      );
    seen.add(sandboxId);
  });
  const harness = HARNESS_TYPE.safeParse(config.harness);
  if (!options.patch && harness.success && sandboxes.length === 0)
    throw new ClientError(
      `config.sandboxes needs at least one sandbox for the ${String(harness.data.type)} harness; the first runs it`,
    );
}

function channelSchema<Shape extends z.core.$ZodLooseShape>(
  shape: Shape,
): z.ZodMiniObject<typeof CHANNEL_IDENTITY & Shape, z.core.$loose> {
  return z
    .looseObject({ ...CHANNEL_IDENTITY, ...shape })
    .check(RETIRED_CHANNEL_KEY_CHECK);
}

function isNativeConvexDocumentId(value: string): boolean {
  return /^[a-z0-9]{20,}$/.test(value);
}

function providerBaseURL(config: {
  base_url?: string;
  baseURL?: string;
}): string | undefined {
  const raw =
    typeof config.base_url === "string" ? config.base_url : config.baseURL;

  return raw?.trim() || undefined;
}

function publicHttpsUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (isPrivateHostname(url.hostname))
    return "must not point to a private or internal address";

  return undefined;
}

function parseInput<S extends z.core.$ZodType>(
  schema: S,
  value: unknown,
  root: string,
): z.output<S> {
  const result = z.safeParse(schema, value, { error: defaultMessage });
  if (result.success) return result.data;
  const [issue] = result.error.issues;

  throw new ClientError(issueSentence(issue, root));
}

function positiveInteger(max: number): z.ZodMiniNumber {
  const error = `must be an integer from 1 to ${max}`;

  return z
    .number({ error: error })
    .check(
      z.refine(
        (value): boolean =>
          Number.isSafeInteger(value) && value >= 1 && value <= max,
        { error: error },
      ),
    );
}

function refusingProtoKey<T>(
  schema: z.ZodMiniType<T>,
  error: string,
): z.ZodMiniType<T> {
  return z.pipe(
    z.unknown().check(
      z.superRefine((value, ctx): void => {
        if (
          typeof value === "object" &&
          value !== null &&
          Object.hasOwn(value, "__proto__")
        )
          ctx.addIssue({ code: "custom", path: ["__proto__"], message: error });
      }),
    ),
    schema,
  );
}

function stringRecord(error: string): z.ZodMiniType<Record<string, string>> {
  return wholeValue(stringValues, error);
}

function wholeValue<T>(
  schema: z.ZodMiniType<T>,
  error: string,
): z.ZodMiniType<T> {
  return z.pipe(
    z.unknown(),
    z.transform((value, ctx): T => {
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      ctx.issues.push({ code: "custom", message: error, input: value });

      return z.NEVER;
    }),
  );
}

function defaultMessage(issue: RawIssue): string {
  if (issue.code === "invalid_value")
    return `must be one of: ${issue.values.join(", ")}`;
  if (issue.code === "invalid_key")
    return issue.issues[0]?.message ?? "is invalid";
  if (issue.code === "unrecognized_keys")
    return `has unknown option "${issue.keys[0]}"`;
  if (issue.code !== "invalid_type") return "is invalid";
  if (issue.expected === "object" || issue.expected === "record")
    return "must be an object";
  if (issue.expected === "array") return "must be an array";
  if (issue.expected === "int") return "must be an integer";

  return `must be a ${issue.expected}`;
}

function issueSentence(issue: Issue | undefined, root: string): string {
  if (issue?.code === "invalid_union") {
    const branch = issue.errors.find(
      ([first]) =>
        first && !(first.code === "invalid_type" && !first.path.length),
    );
    const [first] = branch ?? [];
    if (first) {
      return issueSentence(
        { ...first, path: [...issue.path, ...first.path] },
        root,
      );
    }
  }
  const path = issue?.path ?? [];
  const message = (issue?.message ?? "is invalid").replaceAll(
    "{parent}",
    renderPath(root, path.slice(0, -1)),
  );

  return `${renderPath(root, path).trimEnd()} ${message}`.trim();
}

function renderPath(root: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (rendered, key) =>
      typeof key === "number"
        ? `${rendered}[${key}]`
        : rendered && !rendered.endsWith(" ")
          ? `${rendered}.${String(key)}`
          : `${rendered}${String(key)}`,
    root,
  );
}

// The reference, the interpreted check and core's compiled check, each on a fresh copy.
function compare(input: ConfigValue, patch: boolean): Mismatch[] {
  const options = { patch: patch };
  const checks: [string, ((value: ConfigValue) => unknown)[]][] = [
    [
      "normalizeAgentConfig",
      [
        (value): unknown => referenceNormalizeAgentConfig(value, options),
        (value): unknown => normalizeAgentConfig(value, options),
        (value): unknown =>
          normalizeAgentConfig(value, options, COMPILED_AGENT_CONFIG),
      ],
    ],
  ];
  if (objectOf(input))
    checks.push([
      "assertAgentRuntimeRefs",
      [
        (value): void =>
          referenceAssertAgentRuntimeRefs(objectOf(value) ?? {}, options),
        (value): void => assertAgentRuntimeRefs(objectOf(value) ?? {}, options),
      ],
    ]);

  return checks.flatMap(([check, runs]): Mismatch[] => {
    const outcomes = runs.map((run) => outcome(input, run));
    const [reference, ...others] = outcomes;
    if (reference && others.every((other) => sameOutcome(reference, other)))
      return [];

    return [
      {
        input: JSON.stringify(input) ?? "undefined",
        patch: patch,
        check: check,
        outcomes: outcomes,
      },
    ];
  });
}

function mutate(
  random: Random,
  seeds: readonly ConfigValue[],
  slots: readonly Slot[],
): ConfigValue {
  const config = clone(pick(random, seeds));
  let roll = random();
  for (const [weight, mutation] of MUTATIONS) {
    roll -= weight;
    if (roll < 0) return mutation(random, config, seeds, slots);
  }

  return config;
}

function addKey(random: Random, config: ConfigValue): ConfigValue {
  const parent = pick(random, objectPaths(config)) ?? [];
  const key = pick(random, EXTRA_KEYS) ?? "unknownKey";

  return setAt(config, [...parent, key], pick(random, VALUE_POOL));
}

function crossSeeds(
  random: Random,
  config: ConfigValue,
  seeds: readonly ConfigValue[],
): ConfigValue {
  const other = objectOf(clone(pick(random, seeds)));
  if (!other || !objectOf(config)) return config;
  for (const key of Object.keys(other)) {
    if (random() < 0.5) setAt(config, [key], other[key]);
  }

  return config;
}

function deleteNode(random: Random, config: ConfigValue): ConfigValue {
  const path = pick(random, nodePaths(config, [])) ?? [];
  const parent = nodeAt(config, path.slice(0, -1));
  const key = path.at(-1);
  if (key === undefined) return undefined;
  if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
  else delete objectOf(parent)?.[String(key)];

  return config;
}

function renameKey(random: Random, config: ConfigValue): ConfigValue {
  const parent = pick(random, objectPaths(config)) ?? [];
  const node = objectOf(nodeAt(config, parent));
  const key = node ? pick(random, Object.keys(node)) : undefined;
  if (!node || key === undefined) return config;
  const renamed = RENAMES[key] ?? pick(random, EXTRA_KEYS) ?? `${key}X`;
  const value = node[key];
  delete node[key];

  return setAt(config, [...parent, renamed], value);
}

function replaceNode(random: Random, config: ConfigValue): ConfigValue {
  const path = pick(random, nodePaths(config, [])) ?? [];

  return setAt(config, path, pick(random, VALUE_POOL));
}

function setSlot(
  random: Random,
  config: ConfigValue,
  _seeds: readonly ConfigValue[],
  slots: readonly Slot[],
): ConfigValue {
  const slot = pick(random, slots);
  if (!slot) return config;
  const value =
    slot.options.length > 0 && random() < 0.7
      ? pick(random, slot.options)
      : pick(random, VALUE_POOL);

  return setAt(config, concretePath(random, config, slot.path), value);
}

function clone(value: ConfigValue): ConfigValue {
  if (Array.isArray(value)) return value.map(clone);
  const object = objectOf(value);
  if (!object) return value;
  const copy: ConfigObject = {};
  for (const key of Object.keys(object))
    setChild(copy, key, clone(object[key]));

  return copy;
}

// A schema path with `*` for record keys and array items, made real against `config`.
function concretePath(
  random: Random,
  config: ConfigValue,
  path: readonly string[],
): (string | number)[] {
  const concrete: (string | number)[] = [];
  for (const segment of path) {
    const node = nodeAt(config, concrete);
    const keys = Object.keys(objectOf(node) ?? {});
    if (segment !== ANY_KEY) concrete.push(segment);
    else if (Array.isArray(node))
      concrete.push(Math.floor(random() * Math.max(node.length, 1)));
    else if (keys.length > 0 && random() < 0.8)
      concrete.push(pick(random, keys) ?? "custom");
    else concrete.push(pick(random, RECORD_KEYS) ?? "custom");
  }

  return concrete;
}

function errorText(error: unknown): string {
  if (error instanceof ClientError) return `ClientError: ${error.message}`;

  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function mulberry32(seed: number): Random {
  let state = seed >>> 0;

  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function nodeAt(config: ConfigValue, path: Path): ConfigValue {
  let node = config;
  for (const key of path) {
    node = Array.isArray(node)
      ? typeof key === "number"
        ? node[key]
        : undefined
      : objectOf(node)?.[String(key)];
  }

  return node;
}

function nodePaths(node: ConfigValue, path: (string | number)[]): Path[] {
  const object = objectOf(node);
  const children = Array.isArray(node)
    ? node.flatMap((child, index) => nodePaths(child, [...path, index]))
    : object
      ? Object.keys(object).flatMap((key) =>
          nodePaths(object[key], [...path, key]),
        )
      : [];

  return [path, ...children];
}

function objectOf(value: ConfigValue): ConfigObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function objectPaths(config: ConfigValue): Path[] {
  return nodePaths(config, []).filter((path) => objectOf(nodeAt(config, path)));
}

function outcome(
  input: ConfigValue,
  run: (value: ConfigValue) => unknown,
): Outcome {
  const value = clone(input);
  try {
    const output = run(value);

    return {
      ok: true,
      output: output,
      json: JSON.stringify(output) ?? "",
      inputKept: Bun.deepEquals(value, input, true),
    };
  } catch (error) {
    return {
      ok: false,
      error: errorText(error),
      inputKept: Bun.deepEquals(value, input, true),
    };
  }
}

function pick<T>(random: Random, items: readonly T[]): T | undefined {
  return items[Math.floor(random() * items.length)];
}

function sameOutcome(reference: Outcome, other: Outcome): boolean {
  if (!reference.inputKept || !other.inputKept) return false;
  if (reference.ok && other.ok)
    return (
      reference.json === other.json &&
      Bun.deepEquals(reference.output, other.output, true)
    );
  if (!reference.ok && !other.ok) return reference.error === other.error;

  return false;
}

// Every object key AGENT_CONFIG declares, with the enum or literal values it allows.
function schemaSlots(
  schema: z.core.$ZodType,
  path: readonly string[],
  slots: Slot[],
): Slot[] {
  const def = (schema as z.core.$ZodTypes)._zod.def;
  switch (def.type) {
    case "optional":
    case "nullable":
      return schemaSlots(def.innerType, path, slots);
    case "pipe":
      schemaSlots(def.in, path, slots);

      return schemaSlots(def.out, path, slots);
    case "object":
      for (const [key, child] of Object.entries(def.shape)) {
        slots.push({
          path: [...path, key],
          options: [...(child._zod.values ?? [])].filter(
            (value) => typeof value !== "bigint" && typeof value !== "symbol",
          ),
        });
        schemaSlots(child, [...path, key], slots);
      }

      return slots;
    case "record":
      return schemaSlots(def.valueType, [...path, ANY_KEY], slots);
    case "array":
      return schemaSlots(def.element, [...path, ANY_KEY], slots);
    case "union":
      for (const option of def.options) schemaSlots(option, path, slots);

      return slots;
    default:
      return slots;
  }
}

// Sets `value` at `path`, building missing parents; an empty path replaces the whole config.
function setAt(
  config: ConfigValue,
  path: Path,
  value: ConfigValue,
): ConfigValue {
  const key = path.at(-1);
  if (key === undefined) return value;
  let node = config;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    const next = nodeAt(node, [segment]);
    const wantArray = typeof path[index + 1] === "number";
    if (wantArray ? Array.isArray(next) : objectOf(next)) node = next;
    else {
      const fresh: ConfigValue = wantArray ? [] : {};
      if (!setChild(node, segment, fresh)) return config;
      node = fresh;
    }
  }
  setChild(node, key, value);

  return config;
}

// defineProperty, so a `__proto__` key lands as an own property.
function setChild(
  node: ConfigValue,
  key: string | number,
  value: ConfigValue,
): boolean {
  const object = objectOf(node);
  if (Array.isArray(node) && typeof key === "number") node[key] = value;
  else if (object)
    Object.defineProperty(object, String(key), {
      value: value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else return false;

  return true;
}

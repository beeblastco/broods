// The only copy of config validation (Convex on write, core every run): keep it runtime-pure.

import { z } from "zod/mini";

import {
  POLICY_REMOVED_MESSAGE,
  SANDBOX_REMOVED_MESSAGE,
} from "./agentConfigCodec";
import { mergeConfigObjects } from "./configValues";
import { workspaceOnLaterSandbox } from "./sandboxMounts";
import {
  nonEmptyString,
  nonEmptyStrings,
  parseInput,
  positiveInteger,
  refusingProtoKey,
  resourceCreateInput,
  resourceUpdateInput,
  stringRecord,
  wholeValue,
} from "./inputSchema";
import { configObject } from "./storedJson";
import { AGENT_HOOK_EVENT_NAMES } from "./accountHooks";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  PROVIDER_ENDPOINT_SETTING,
} from "./modelProviders";
import { ClientError } from "./clientError";
import { MAX_CONFIGURED_SKILLS } from "./skillLimits";

export type AgentStatus = "active" | "disabled";
export type { AccountModelProviderName } from "./modelProviders";

// patch: a partial config checked before its merge; cross-branch rules wait for the merge.
export type AgentConfigCheckOptions = { patch?: boolean };

const AGENT_HARNESS_STARTUP_TIMEOUT_LIMIT = 10 * 60 * 1_000;
// Input tokens; above every model context window shipped today.
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 10_000_000;
export const AGENT_HARNESS_TYPES = [
  "claude-code",
  "codex",
  "deepagents",
  "opencode",
  "pi",
] as const;
export const AGENT_HARNESS_DEBUG_LEVELS = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;
export const AGENT_HARNESS_PERMISSION_MODES = [
  "allow-reads",
  "allow-edits",
  "allow-all",
] as const;
const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Core puts the gateway id into AI Gateway URL paths, so it stays URL-safe.
const AI_GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Retired account-tool id prefix: neither a Convex id nor a provider tool name.
const DEPRECATED_TOOL_ID_PREFIX = "tool_";

const RESERVED_HARNESS_TOOL_NAMES = new Set([
  "async_status",
  "bash",
  "browse",
  "cancel_schedule",
  "computer",
  "edit",
  "glob",
  "grep",
  "list_schedules",
  "load_skill",
  "memory_save",
  "message-agents",
  "read",
  "run_subagent",
  "schedule",
  "stop_subagent",
  "update_schedule",
  "write",
]);
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
export const MODEL_CONFIG_SETTING_KEYS = [
  "provider",
  "modelId",
  "transcriptionModelId",
  "providerOptions",
  "output",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "reasoning",
  "maxRetries",
  "timeout",
] as const;
// The AI SDK's TimeoutConfiguration (ai 7) object; `tools` holds per-tool `{toolName}Ms`.
const MODEL_TIMEOUT_KEYS = [
  "totalMs",
  "stepMs",
  "firstChunkMs",
  "chunkMs",
  "toolMs",
  "tools",
] as const;
// The longest delay setTimeout takes; a longer one overflows and fires at once.
const MAX_TIMER_MS = 2_147_483_647;
// Webhooks get agent-loop lifecycle events only; code hooks take all AGENT_HOOK_EVENT_NAMES.
export const AGENT_LIFECYCLE_EVENT_NAMES = [
  "agent.started",
  "agent.step.finished",
  "agent.finished",
  "agent.failed",
  "agent.approval.required",
  "tool.call.started",
  "tool.call.finished",
  "tool.result",
  "subagent.task.started",
  "subagent.task.finished",
] as const;

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

// The AI SDK's SystemModelMessage: Convex cannot import `ai`.
const SYSTEM_MESSAGE = z.looseObject({
  role: z.literal("system"),
  content: z.string(),
  providerOptions: z.optional(
    z.record(z.string(), z.record(z.string(), z.unknown())),
  ),
});

const AGENT_BEHAVIOR = z.looseObject({
  // No ceiling: a long tool job can legitimately take hundreds of steps.
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

// The AI SDK's TimeoutConfiguration: a number, or limits by phase plus `tools.{toolName}Ms`.
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

export const MODEL_OUTPUT = z.discriminatedUnion(
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
        for (const key of Object.keys(settings)) {
          if (key === "baseURL" || (key === "base_url" && baseURL)) continue;
          const endpoint = settings[key];
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
  // Store one spelling: a stale base_url (core prefers it) would shadow later baseURL edits.
  z.transform((settings) => {
    const baseURL = providerBaseURL(settings);
    if (baseURL) {
      settings.baseURL = baseURL;
      delete settings.base_url;
    }

    return settings;
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
// Without an audience no Google Chat webhook token can be verified.
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
// Linear has no bots: the agent posts as the key's member, mentioned by userName.
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
  // A sid that does not look like one would be sent as a phone number.
  messagingServiceSid: z.optional(
    patternString(
      /^MG[0-9a-fA-F]{32}$/,
      'must be a Messaging Service sid ("MG" and 32 hex digits)',
    ),
  ),
  // Core matches it to the E.164 `To` Twilio posts; any other spelling ignores every message.
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
  // Spliced into every Graph API path, so a version only, never a path.
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
  // A Graph API path segment, and the SDK refuses to send to any other.
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

// A Broods tool name keys only a provider tool, which core then runs as that Broods tool.
const TOOLS = z
  .record(
    z
      .string()
      .check(
        z.refine(isProviderToolName, { error: "is not a supported tool" }),
      ),
    z.looseObject({
      enabled: optionalBoolean,
      needsApproval: optionalBoolean,
      config: z.optional(z.record(z.string(), z.unknown())),
    }),
  )
  .check(
    z.superRefine((tools, ctx): void => {
      for (const [name, entry] of Object.entries(tools)) {
        if (isHarnessToolName(name) && entry.type !== "provider")
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `is a Broods tool name; it only keys a provider tool such as ${name}: anthropic.tools.bash_20250124({})`,
          });
      }
    }),
  );

/** Keyed by MCP server row id. */
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

export const AGENT_CONFIG = z.looseObject({
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
  /** `browse` runs on the first sandbox: a machine, or lambda "obscura" with allow-all. */
  browser: z.nullish(ENABLED_SWITCH),
  policies: z.nullish(nonEmptyStrings),
  publicAccess: optionalBoolean,
  allowRunOverrides: optionalBoolean,
});

const OPTIONAL_MODEL = z.nullish(MODEL);

// Only what a canvas save checks: an unreadable harness is the full check's to refuse.
const AGENT_RUNTIME_REFS = z.looseObject({
  harness: z.optional(z.unknown()),
  workspaces: z.nullish(WORKSPACE_REFS),
  sandboxes: z.optional(nonEmptyStrings),
});
const HARNESS_TYPE = z.looseObject({ type: z.optional(z.unknown()) });
const HARNESS_CHECKED_MODEL = z.nullish(
  z.looseObject({
    output: z.nullish(z.looseObject({ type: z.optional(z.unknown()) })),
    providerOptions: z.optional(z.unknown()),
  }),
);
// Only what the harness check reads, for saves that skip the full config check.
const HARNESS_CHECKED = z.looseObject({
  harness: z.optional(z.unknown()),
  policies: z.nullish(z.array(z.unknown())),
  model: HARNESS_CHECKED_MODEL,
  subagent: z.nullish(z.looseObject({ model: HARNESS_CHECKED_MODEL })),
});

const UPDATE_AGENT_INPUT = z.extend(resourceUpdateInput, {
  status: z.optional(z.enum(["active", "disabled"])),
});

// Lenient reads of a stored or manifest config: a branch that does not fit is skipped.
export const storedRefList = z.looseObject({ allowed: z.array(z.unknown()) });
export const storedWorkspaceRef = z.looseObject({ workspaceId: z.string() });

export type AgentConfig = z.output<typeof AGENT_CONFIG>;
export type AgentWorkspaceRef = z.output<typeof WORKSPACE_REF>;
export type AgentModelConfig = z.output<typeof MODEL>;
export type AgentWebhookHookConfig = z.output<typeof WEBHOOK_HOOK>;
type AgentChannelsConfig = z.output<typeof CHANNELS>;
type HarnessChecked = z.output<typeof HARNESS_CHECKED>;
type AgentRuntimeRefs = Pick<
  z.output<typeof AGENT_RUNTIME_REFS>,
  "sandboxes" | "workspaces"
> & { harness?: unknown; sandbox?: unknown };

// `schema` is AGENT_CONFIG, or the `z.compile` copy core checks every run with.
export function normalizeAgentConfig(
  value: unknown,
  options: AgentConfigCheckOptions = {},
  schema: typeof AGENT_CONFIG = AGENT_CONFIG,
): AgentConfig {
  if (value == null) {
    return {};
  }
  const config = parseInput(schema, value, "config");
  const policyIds = [...new Set(config.policies ?? [])];
  // The parse built `config`, so it is ours to edit; a non-empty list goes back last.
  delete config.policies;
  assertRuntimeRefs(config, options);
  if (!options.patch && config.channels)
    assertCompleteChannels(config.channels);
  if (config.policy !== undefined) {
    throw new ClientError(POLICY_REMOVED_MESSAGE);
  }
  if (config.harness) assertHarnessSupports(config, policyIds);
  if (config.skills?.allowed)
    config.skills = {
      ...config.skills,
      allowed: [...new Set(config.skills.allowed)],
    };
  if (policyIds.length > 0) config.policies = policyIds;

  return config;
}

export function normalizeAgentConfigPatch(
  value: unknown,
): Record<string, unknown> {
  const patch = parseInput(configObject, value, "config");
  normalizeAgentConfig(removeNullConfigValues(patch), { patch: true });

  return patch;
}

export function mergeAgentConfig(
  existing: AgentConfig,
  patch: Record<string, unknown>,
): AgentConfig {
  return normalizeAgentConfig(mergeConfigObjects(existing, patch));
}

export function normalizeCreateAgentInput(value: unknown): {
  name: string;
  description?: string;
  config: AgentConfig;
} {
  const input = parseInput(resourceCreateInput, value, "");
  const description = input.description?.trim();

  return {
    name: input.name.trim(),
    ...(description ? { description: description } : {}),
    config: normalizeAgentConfig(input.config),
  };
}

export function normalizeUpdateAgentInput(
  existingConfig: AgentConfig,
  value: unknown,
): {
  name?: string;
  description?: string | null;
  status?: AgentStatus;
  config: AgentConfig;
} {
  const input = parseInput(UPDATE_AGENT_INPUT, value, "");
  const config =
    "config" in input
      ? mergeAgentConfig(
          existingConfig,
          normalizeAgentConfigPatch(input.config),
        )
      : existingConfig;

  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : input.description.trim() || undefined,
        }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    config: config,
  };
}

// A canvas save checks only these refs, never branches the dashboard did not validate.
export function assertAgentRuntimeRefs(
  config: Record<string, unknown>,
  options: AgentConfigCheckOptions = {},
): void {
  assertRuntimeRefs(parseInput(AGENT_RUNTIME_REFS, config, "config"), options);
}

// For saves that write a config without `normalizeAgentConfig`: CLI sync and the dashboard.
export function assertAgentHarnessSupport(
  config: Record<string, unknown>,
): void {
  const checked = parseInput(HARNESS_CHECKED, config, "config");
  if (checked.harness != null)
    assertHarnessSupports(checked, checked.policies ?? []);
}

// A config-time string check: it resolves no DNS.
export function assertPublicHttpsUrl(value: string, label: string): URL {
  const problem = publicHttpsUrlProblem(value);
  if (problem) throw new ClientError(`${label} ${problem}`);

  return new URL(value);
}

export function isHarnessToolName(toolName: string): boolean {
  return RESERVED_HARNESS_TOOL_NAMES.has(toolName);
}

// Shape only: core resolves at run time whether the provider ships the tool.
export function isProviderToolName(toolName: string): boolean {
  return (
    PROVIDER_TOOL_NAME_PATTERN.test(toolName) &&
    !toolName.startsWith(DEPRECATED_TOOL_ID_PREFIX)
  );
}

export function defaultSandboxOf(
  config: Record<string, unknown>,
): string | undefined {
  const first: unknown = Array.isArray(config.sandboxes)
    ? config.sandboxes[0]
    : undefined;

  return typeof first === "string" ? first : undefined;
}

// Canvas order first; a stored id it cannot draw is kept, since it cannot mean to remove it.
export function mergeCanvasSandboxes(
  canvas: readonly string[],
  stored: readonly string[],
  canvasSandboxIds: ReadonlySet<string>,
): string[] {
  const hidden = stored.filter((id) => !canvasSandboxIds.has(id));

  return [...new Set([...canvas, ...hidden])];
}

export function normalizeWebhookHookConfig(
  value: unknown,
  path: string,
): AgentWebhookHookConfig {
  return parseInput(WEBHOOK_HOOK, value, path);
}

export function normalizeModelConfig(
  value: unknown,
  label: string,
): AgentModelConfig | null | undefined {
  return parseInput(OPTIONAL_MODEL, value, label);
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  }
  if (host.includes(":")) return isPrivateIpv6(host);

  return false;
}

// A harness runs its own loop: policies, structured output and providerOptions never reach it.
function assertHarnessSupports(
  config: HarnessChecked,
  policyIds: readonly unknown[],
): void {
  if (policyIds.length > 0) {
    throw new ClientError(
      "config.policies is not supported with config.harness",
    );
  }
  for (const [model, label] of [
    [config.model, "config.model"],
    [config.subagent?.model, "config.subagent.model"],
  ] as const) {
    if (model?.output && model.output.type !== "text") {
      throw new ClientError(
        `${label}.output structured output is not supported with config.harness`,
      );
    }
    if (model?.providerOptions !== undefined) {
      throw new ClientError(
        `${label}.providerOptions is not supported with config.harness; set ${label}.reasoning`,
      );
    }
  }
}

// Core builds the adapter only with all of these set, so a partial set would never answer.
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
  // Core runs the channel only with the key, userName and webhook secret together.
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
  // A single-tenant bot signs in against its own tenant, so it cannot work without one.
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
  // Index by index, duplicate first: mixed input must report the same error as core.
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
  if (options.patch || sandboxes.length > 0 || config.harness == null) return;
  const harness = HARNESS_TYPE.safeParse(config.harness);
  if (harness.success)
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

function removeNullConfigValues(value: object): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(value);

  return Object.fromEntries(
    entries.flatMap(([key, entry]): [string, unknown][] => {
      if (entry === null) return [];
      if (typeof entry === "object" && !Array.isArray(entry))
        return [[key, removeNullConfigValues(entry)]];

      return [[key, entry]];
    }),
  );
}

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// host is already lowercased and unbracketed.
function isPrivateIpv6(host: string): boolean {
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    /^f[cd]/.test(host) ||
    /^fe[89ab]/.test(host)
  );
}

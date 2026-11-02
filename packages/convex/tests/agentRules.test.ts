import { describe, expect, it } from "vitest";
import {
  assertAgentRuntimeRefs,
  isProviderToolName,
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  normalizeCreateAgentInput,
  mergeCanvasSandboxes,
  normalizeUpdateAgentInput,
  normalizeWebhookHookConfig,
} from "../model/agentRules";
import { redactConfigSecrets } from "../model/configValues";
import {
  collectEnvPlaceholderNames,
  substituteAccountEnvPlaceholders,
} from "../model/agentConfigCodec";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "../model/modelProviders";

describe("agent rules", () => {
  it("validates the sandboxes list", () => {
    expect(
      normalizeAgentConfig({
        sandboxes: ["sb_default", "sb_browser"],
        workspaces: [
          { name: "repo", workspaceId: "ws_1", sandbox: "sb_default" },
        ],
      }),
    ).toEqual({
      sandboxes: ["sb_default", "sb_browser"],
      workspaces: [
        { name: "repo", workspaceId: "ws_1", sandbox: "sb_default" },
      ],
    });
    expect(() => normalizeAgentConfig({ sandbox: "sb_default" })).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
    expect(() => normalizeAgentConfig({ sandboxes: "sb_offline" })).toThrow(
      "config.sandboxes must be an array of non-empty strings",
    );
    expect(() =>
      normalizeAgentConfig({ sandboxes: ["sb_offline", "sb_offline"] }),
    ).toThrow('config.sandboxes[1] "sb_offline" is listed more than once');
    // Only the default mounts workspaces, so a workspace cannot name an extra.
    expect(() =>
      normalizeAgentConfig({
        sandboxes: ["sb_default", "sb_browser"],
        workspaces: [
          { name: "repo", workspaceId: "ws_1", sandbox: "sb_browser" },
        ],
      }),
    ).toThrow(
      'config.sandboxes[1] "sb_browser" also backs workspace "repo"; only the first sandbox can back a workspace',
    );
    // Each index is judged in turn, as in core: the mount at [1] wins over the repeat at [2].
    expect(() =>
      normalizeAgentConfig({
        sandboxes: ["sb_a", "sb_b", "sb_b"],
        workspaces: [{ name: "repo", workspaceId: "ws_1", sandbox: "sb_b" }],
      }),
    ).toThrow(
      'config.sandboxes[1] "sb_b" also backs workspace "repo"; only the first sandbox can back a workspace',
    );
  });

  it("validates config.mcp entries", () => {
    const serverId = "k57mcpserver00000000000000000000";
    expect(
      normalizeAgentConfig({
        mcp: {
          [serverId]: {
            enabled: true,
            needsApproval: true,
            headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
          },
        },
      }),
    ).toEqual({
      mcp: {
        [serverId]: {
          enabled: true,
          needsApproval: true,
          headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
        },
      },
    });
    expect(() => normalizeAgentConfig({ mcp: { "not-an-id": {} } })).toThrow(
      "config.mcp.not-an-id must be keyed by an MCP server id",
    );
    expect(() =>
      normalizeAgentConfig({
        mcp: { [serverId]: { headers: { Authorization: 5 } } },
      }),
    ).toThrow(
      `config.mcp.${serverId}.headers must be an object of string values`,
    );
    expect(() =>
      normalizeAgentConfig({
        mcp: { [serverId]: { oauth: { clientSecret: 5 } } },
      }),
    ).toThrow(
      `config.mcp.${serverId}.oauth must be an object of string values`,
    );
  });

  it("validates channel trace settings", () => {
    expect(
      normalizeAgentConfig({
        channels: { zalo: { id: "support", trace: "disabled" } },
      }),
    ).toEqual({
      channels: { zalo: { id: "support", trace: "disabled" } },
    });
    expect(() =>
      normalizeAgentConfig({
        channels: { zalo: { id: "support", trace: "hidden" } },
      }),
    ).toThrow("config.channels.zalo.trace must be one of: enabled, disabled");
  });

  it("holds Linear to its URL, identity and secret settings", () => {
    expect(() =>
      normalizeAgentConfig({
        channels: {
          linear: { id: "lin", apiUrl: "https://169.254.169.254/graphql" },
        },
      }),
    ).toThrow("must not point to a private or internal address");
    expect(() =>
      normalizeAgentConfig({
        channels: { linear: { id: "lin", apiKey: "lin_api_key" } },
      }),
    ).toThrow("config.channels.linear.userName is required");
    expect(() =>
      normalizeAgentConfig({
        channels: {
          linear: {
            id: "lin",
            apiKey: "lin_api_key",
            userName: " ",
            webhookSecret: "lin-secret",
          },
        },
      }),
    ).toThrow("config.channels.linear.userName is required");
    expect(() =>
      normalizeAgentConfig({
        channels: {
          linear: { id: "lin", apiKey: "lin_api_key", userName: "acme-agent" },
        },
      }),
    ).toThrow(
      "config.channels.linear.webhookSecret is required when config.channels.linear.apiKey is set",
    );
    expect(
      redactConfigSecrets({
        channels: {
          linear: { apiKey: "lin-key", webhookSecret: "lin-secret" },
        },
      }),
    ).toEqual({
      channels: {
        linear: { apiKey: "********", webhookSecret: "********" },
      },
    });
  });

  it("holds Twilio to its URL and identity settings", () => {
    for (const key of ["apiUrl", "statusCallbackUrl", "webhookUrl"]) {
      expect(() =>
        normalizeAgentConfig({
          channels: { twilio: { id: "sms", [key]: "https://169.254.169.254" } },
        }),
      ).toThrow("must not point to a private or internal address");
    }
    expect(() =>
      normalizeAgentConfig({
        channels: { twilio: { id: "sms", messagingServiceSid: "+1555" } },
      }),
    ).toThrow("config.channels.twilio.messagingServiceSid must be");
    expect(() =>
      normalizeAgentConfig({
        channels: { twilio: { id: "sms", phoneNumber: "+1 (555) 000-1111" } },
      }),
    ).toThrow("config.channels.twilio.phoneNumber must be");
    expect(
      redactConfigSecrets({
        channels: {
          twilio: { accountSid: "AC1", authToken: "twilio-token" },
        },
      }),
    ).toEqual({
      channels: {
        twilio: { accountSid: "AC1", authToken: "********" },
      },
    });
  });

  it("validates one reach pair for every provider and rejects the retired keys", () => {
    expect(
      normalizeAgentConfig({
        channels: {
          telegram: { id: "tg", allowedChannelIds: ["*"] },
          github: { id: "gh", allowedUserIds: ["octocat"] },
        },
      }),
    ).toEqual({
      channels: {
        telegram: { id: "tg", allowedChannelIds: ["*"] },
        github: { id: "gh", allowedUserIds: ["octocat"] },
      },
    });
    expect(() =>
      normalizeAgentConfig({
        channels: { discord: { id: "dc", allowedGuildIds: ["G1"] } },
      }),
    ).toThrow(
      "config.channels.discord.allowedGuildIds is no longer supported; use config.channels.discord.allowedChannelIds",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: { slack: { id: "sl", allowedChannelIds: [""] } },
      }),
    ).toThrow(
      "config.channels.slack.allowedChannelIds must be an array of non-empty strings",
    );
  });

  it("validates the Discord mention settings", () => {
    const discord = {
      id: "dc",
      botUserId: "bot-9",
      mentionRoleIds: ["role-oncall"],
    };
    expect(normalizeAgentConfig({ channels: { discord: discord } })).toEqual({
      channels: { discord: discord },
    });
    expect(() =>
      normalizeAgentConfig({
        channels: { discord: { id: "dc", botUserId: 9 } },
      }),
    ).toThrow("config.channels.discord.botUserId must be a string");
    expect(() =>
      normalizeAgentConfig({
        channels: { discord: { id: "dc", mentionRoleIds: "role-oncall" } },
      }),
    ).toThrow(
      "config.channels.discord.mentionRoleIds must be an array of non-empty strings",
    );
  });

  it("requires an http(s) homeserver URL for a Matrix token", () => {
    const matrix = {
      id: "mx",
      apiUrl: "https://matrix.org",
      botToken: "syt_token",
      botName: "Georgi AI",
      mentionText: "@georgi-ai",
    };
    expect(normalizeAgentConfig({ channels: { matrix: matrix } })).toEqual({
      channels: { matrix: matrix },
    });
    expect(() =>
      normalizeAgentConfig({
        channels: { matrix: { id: "mx", botToken: "syt_token" } },
      }),
    ).toThrow(
      "config.channels.matrix.apiUrl is required when config.channels.matrix.botToken is set",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: {
          matrix: {
            id: "mx",
            apiUrl: "http://10.0.0.5:8008",
            botToken: "syt_token",
          },
        },
      }),
    ).toThrow("config.channels.matrix.apiUrl must use https");
    expect(() =>
      normalizeAgentConfig({
        channels: {
          matrix: {
            id: "mx",
            apiUrl: "https://core.internal",
            botToken: "syt_token",
          },
        },
      }),
    ).toThrow("must not point to a private or internal address");
    // Core posts to every channel apiUrl from inside the cluster.
    for (const channel of ["discord", "github", "slack", "telegram"]) {
      expect(() =>
        normalizeAgentConfig({
          channels: { [channel]: { id: "c", apiUrl: "http://10.43.0.1:80#" } },
        }),
      ).toThrow(`config.channels.${channel}.apiUrl must use https`);
    }
    // A patch may rotate the token alone; the merged config still has the URL.
    expect(
      normalizeAgentConfigPatch({
        channels: { matrix: { id: "mx", botToken: "syt_rotated" } },
      }),
    ).toEqual({ channels: { matrix: { id: "mx", botToken: "syt_rotated" } } });
  });

  it("accepts a system prompt as a string or AI SDK system messages", () => {
    const system = [
      {
        role: "system",
        content: "Be brief.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ];
    expect(normalizeAgentConfig({ agent: { system: system } })).toEqual({
      agent: { system: system },
    });
    for (const invalid of [
      { role: "user", content: "Be brief." },
      { role: "system", content: ["Be brief."] },
      { role: "system", content: "Be brief.", providerOptions: "anthropic" },
      {
        role: "system",
        content: "Be brief.",
        providerOptions: { anthropic: true },
      },
    ]) {
      expect(() =>
        normalizeAgentConfig({ agent: { system: invalid } }),
      ).toThrow(
        "config.agent.system must be a string, SystemModelMessage, or SystemModelMessage[]: invalid system message",
      );
    }
  });

  it("normalizes empty configs and rejects non-objects", () => {
    expect(normalizeAgentConfig(null)).toEqual({});
    expect(() => normalizeAgentConfig("bad")).toThrow(
      "config must be an object",
    );
  });

  it("validates representative nested config bounds and enums", () => {
    expect(() => normalizeAgentConfig({ agent: { maxTurn: -1 } })).toThrow(
      "config.agent.maxTurn must be a non-negative integer",
    );
    expect(normalizeAgentConfig({ agent: { maxTurn: 500 } })).toEqual({
      agent: { maxTurn: 500 },
    });
    expect(normalizeAgentConfig({ agent: { maxTurn: 0 } })).toEqual({
      agent: { maxTurn: 0 },
    });
    expect(() =>
      normalizeAgentConfig({
        session: { autoCompaction: { maxContextLength: 10_000_001 } },
      }),
    ).toThrow(
      "config.session.autoCompaction.maxContextLength must be an integer from 1 to 10000000",
    );
    expect(() =>
      normalizeAgentConfig({
        session: { autoCompaction: { enabled: "yes" } },
      }),
    ).toThrow("config.session.autoCompaction.enabled must be a boolean");
    expect(
      normalizeAgentConfig({
        session: {
          autoCompaction: { enabled: false, maxContextLength: 500_000 },
        },
      }),
    ).toEqual({
      session: {
        autoCompaction: { enabled: false, maxContextLength: 500_000 },
      },
    });
    // The old key would otherwise be dropped silently and auto-compaction left on.
    expect(() =>
      normalizeAgentConfig({
        session: { compaction: { enabled: true } },
      }),
    ).toThrow(
      "config.session.compaction was renamed to config.session.autoCompaction",
    );
    expect(() => normalizeAgentConfig({ model: { apiKey: "x" } })).toThrow(
      "config.model.apiKey is not supported; use config.model.providerOptions for provider-specific settings",
    );
    expect(() =>
      normalizeAgentConfig({ model: { provider: "other" } }),
    ).toThrow(
      `config.model.provider must be one of: ${ACCOUNT_MODEL_PROVIDER_NAMES.join(", ")}`,
    );
    expect(() =>
      normalizeAgentConfig({ model: { provider: "deepseek" } }),
    ).not.toThrow();
    expect(() =>
      normalizeAgentConfig({ model: { transcriptionModelId: 42 } }),
    ).toThrow("config.model.transcriptionModelId must be a string");
    expect(() =>
      normalizeAgentConfig({ model: { transcriptionModelId: "whisper-1" } }),
    ).not.toThrow();
    for (const timeout of [
      60_000,
      {},
      { totalMs: 600_000 },
      { stepMs: 120_000, firstChunkMs: 30_000, chunkMs: 10_000 },
      { toolMs: 60_000, tools: { bashMs: 300_000 } },
    ]) {
      expect(
        normalizeAgentConfig({ model: { timeout: timeout } }).model,
      ).toEqual({ timeout: timeout });
    }
    for (const [timeout, message] of [
      [0, "config.model.timeout must be an integer from 1 to 2147483647"],
      [1.5, "config.model.timeout must be an integer from 1 to 2147483647"],
      [
        2_147_483_648,
        "config.model.timeout must be an integer from 1 to 2147483647",
      ],
      [
        "60000",
        "config.model.timeout must be a number of milliseconds or an object with totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools",
      ],
      [
        { firstChunkMS: 30_000 },
        "config.model.timeout.firstChunkMS is not supported; use one of: totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools",
      ],
      [
        { chunkMs: -1 },
        "config.model.timeout.chunkMs must be an integer from 1 to 2147483647",
      ],
      [
        { tools: [] },
        "config.model.timeout.tools must be an object of {toolName}Ms limits",
      ],
      [
        { tools: { bash: 1_000 } },
        "config.model.timeout.tools.bash must be named {toolName}Ms, like bashMs",
      ],
      [
        { tools: { bashMs: "1s" } },
        "config.model.timeout.tools.bashMs must be an integer from 1 to 2147483647",
      ],
    ] as const) {
      expect(() =>
        normalizeAgentConfig({ model: { timeout: timeout } }),
      ).toThrow(message);
    }
    expect(() =>
      normalizeAgentConfig({ subagent: { model: { timeout: { stepMs: 0 } } } }),
    ).toThrow(
      "config.subagent.model.timeout.stepMs must be an integer from 1 to 2147483647",
    );
    // Core puts it into AI Gateway URL paths.
    for (const gatewayId of [7, "gw/../other", "gw?x=1"]) {
      expect(() =>
        normalizeAgentConfig({
          provider: { cloudflare: { gatewayId: gatewayId } },
        }),
      ).toThrow(
        "config.provider.cloudflare.gatewayId must be an AI Gateway id",
      );
    }
    expect(() =>
      normalizeAgentConfig({
        provider: { cloudflare: { gatewayId: "broods-dev_1" } },
      }),
    ).not.toThrow();
    // A literal header holding an upstream key is as secret as an apiKey; an env ref is not.
    expect(
      redactConfigSecrets({
        provider: {
          cloudflare: {
            headers: {
              Authorization: "Bearer sk-live",
              "Proxy-Authorization": "Bearer sk-live${X}",
              "x-api-key": "sk-ant-live",
              "cf-aig-authorization": "Bearer ${CF_AIG_TOKEN}",
              "X-Bot-Authorization": "Bot ${BOT_TOKEN}",
            },
          },
        },
        tools: {
          search: {
            serperApiKey: "sk-serper",
            apiKey: "sk-live ${SUFFIX}",
            apiKeys: ["sk-one", "${KEY_TWO}"],
            credentials: { clientId: "id-1", refreshToken: "sk-refresh" },
          },
        },
        model: {
          output: {
            schema: {
              properties: {
                credentials: { type: "object", required: ["username"] },
              },
            },
          },
        },
      }),
    ).toEqual({
      provider: {
        cloudflare: {
          headers: {
            Authorization: "********",
            "Proxy-Authorization": "********",
            "x-api-key": "********",
            "cf-aig-authorization": "Bearer ${CF_AIG_TOKEN}",
            "X-Bot-Authorization": "Bot ${BOT_TOKEN}",
          },
        },
      },
      tools: {
        search: {
          serperApiKey: "********",
          apiKey: "********",
          apiKeys: "********",
          credentials: { clientId: "id-1", refreshToken: "********" },
        },
      },
      model: {
        output: {
          schema: {
            properties: {
              credentials: { type: "object", required: ["username"] },
            },
          },
        },
      },
    });
    // Inherited Object keys are not provider names, however `in` reads them.
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      expect(() =>
        normalizeAgentConfig({ model: { provider: inherited } }),
      ).toThrow("config.model.provider must be one of:");
      expect(() =>
        normalizeAgentConfig({ provider: { [inherited]: { apiKey: "k" } } }),
      ).toThrow("is not a supported provider");
    }
    expect(() =>
      normalizeAgentConfig({
        provider: { vertex: { apiKey: "k", project: "p", location: "us" } },
      }),
    ).not.toThrow();
  });

  it("validates public provider URLs and output variants", () => {
    expect(() => normalizeAgentConfig({ provider: { custom: {} } })).toThrow(
      "config.provider.custom.base_url is required",
    );
    expect(() =>
      normalizeAgentConfig({
        provider: { custom: { baseUrl: "https://api.example.com" } },
      }),
    ).toThrow(
      `config.provider.custom.base_url is required (found "baseUrl", use "base_url" or "baseURL")`,
    );
    expect(() =>
      normalizeAgentConfig({
        provider: { custom: { base_url: "http://api.example.com" } },
      }),
    ).toThrow("config.provider.custom.base_url must use https");
    expect(() =>
      normalizeAgentConfig({
        provider: { custom: { base_url: "https://localhost" } },
      }),
    ).toThrow(
      "config.provider.custom.base_url must not point to a private or internal address",
    );
    // Every endpoint a factory reads is held to the base URL's rule, not just broods's two.
    expect(() =>
      normalizeAgentConfig({
        provider: {
          openrouter: { apiKey: "sk", baseUrl: "https://169.254.169.254" },
        },
      }),
    ).toThrow(
      "config.provider.openrouter.baseUrl must not point to a private or internal address",
    );
    expect(() =>
      normalizeAgentConfig({
        provider: {
          openrouter: { apiKey: "sk", decisionsBaseURL: "http://example.com" },
        },
      }),
    ).toThrow("config.provider.openrouter.decisionsBaseURL must use https");
    expect(
      normalizeAgentConfig({
        provider: { custom: { base_url: "https://api.example.com" } },
      }).provider,
    ).toEqual({ custom: { baseURL: "https://api.example.com" } });
    expect(
      normalizeAgentConfig({
        provider: {
          custom: {
            base_url: "https://old.example.com",
            baseURL: "https://api.example.com",
          },
        },
      }).provider,
    ).toEqual({ custom: { baseURL: "https://old.example.com" } });
    expect(() =>
      normalizeAgentConfig({ model: { output: { type: "object" } } }),
    ).toThrow("config.model.output.schema must be an object");
    expect(() =>
      normalizeAgentConfig({ model: { output: { type: "array" } } }),
    ).toThrow("config.model.output.element must be an object");
    expect(() =>
      normalizeAgentConfig({
        model: { output: { type: "choice", options: [] } },
      }),
    ).toThrow(
      "config.model.output.options must be a non-empty array of strings",
    );
  });

  it("validates workspace references", () => {
    expect(
      normalizeAgentConfig({
        workspaces: [{ name: "repo", workspaceId: "ws_1", sandbox: null }],
      }).workspaces,
    ).toHaveLength(1);
    expect(() =>
      normalizeAgentConfig({
        workspaces: [{ name: "bad/name", workspaceId: "ws_1" }],
      }),
    ).toThrow(
      "config.workspaces[0].name must use only letters, numbers, dots, underscores, or hyphens",
    );
    expect(() =>
      normalizeAgentConfig({
        workspaces: [
          { name: "repo", workspaceId: "ws_1" },
          { name: "repo", workspaceId: "ws_2" },
        ],
      }),
    ).toThrow('config.workspaces[1].name "repo" is used more than once');
  });

  it("validates skills, subagents, policies, tools, and channels", () => {
    expect(() => normalizeAgentConfig({ skills: { allowed: [1] } })).toThrow(
      "config.skills.allowed must be an array of non-empty strings",
    );
    const repeated = Array.from({ length: 1_000 }, () => "acct/skill");
    expect(
      normalizeAgentConfig({ skills: { allowed: repeated } }).skills?.allowed,
    ).toEqual(["acct/skill"]);
    const distinct = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `acct/skill-${index}`);
    expect(
      normalizeAgentConfig({ skills: { allowed: distinct(32) } }).skills
        ?.allowed,
    ).toHaveLength(32);
    expect(() =>
      normalizeAgentConfig({ skills: { allowed: distinct(33) } }),
    ).toThrow("config.skills.allowed must list at most 32 skills");
    expect(() =>
      normalizeAgentConfig({ subagent: { context: "same" } }),
    ).toThrow("config.subagent.context must be one of: new, inherited");
    expect(normalizeAgentConfig({ policies: [] }).policies).toBeUndefined();
    expect(
      normalizeAgentConfig({ policies: ["policy_a", "policy_a"] }).policies,
    ).toEqual(["policy_a"]);
    expect(() =>
      normalizeAgentConfig({ policy: { policyIds: ["policy_1"] } }),
    ).toThrow("config.policy is no longer supported");
    expect(() => normalizeAgentConfig({ policies: [1] })).toThrow(
      "config.policies must be an array of non-empty strings",
    );
    // Harness-owned names stay rejected; core resolves provider tool names at run time.
    expect(() =>
      normalizeAgentConfig({ tools: { bash: { enabled: true } } }),
    ).toThrow("config.tools.bash is not a supported tool");
    expect(() =>
      normalizeAgentConfig({ tools: { tool_legacy: { enabled: true } } }),
    ).toThrow("config.tools.tool_legacy is not a supported tool");
    expect(
      normalizeAgentConfig({ tools: { googleSearch: { enabled: true } } })
        .tools,
    ).toMatchObject({ googleSearch: { enabled: true } });
    expect(() =>
      normalizeAgentConfig({
        channels: {
          slack: {
            id: "slack",
            partition: { by: "shared", alias: "x" },
          },
        },
      }),
    ).toThrow(
      "config.channels.slack.partition.alias is only supported when config.channels.slack.partition.by is conversation",
    );
    // Channel configs take an index signature: only this rejects retired partition keys.
    expect(() =>
      normalizeAgentConfig({
        channels: {
          slack: { id: "slack", workspaceScope: { level: "channel" } },
        },
      }),
    ).toThrow(
      "config.channels.slack.workspaceScope is no longer supported; use config.channels.slack.partition",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: {
          slack: { id: "slack", workspaceIsolationScope: "channel" },
        },
      }),
    ).toThrow(
      "config.channels.slack.workspaceIsolationScope is no longer supported; use config.channels.slack.partition",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: { zalo: { id: "zalo", webhookSecret: "short" } },
      }),
    ).toThrow("config.channels.zalo.webhookSecret must be 8 to 256 characters");
  });

  it("keeps Messenger and Instagram Graph settings out of the URL path", () => {
    expect(() =>
      normalizeAgentConfig({
        channels: { messenger: { id: "fb", apiVersion: "../me" } },
      }),
    ).toThrow('config.channels.messenger.apiVersion must look like "v21.0"');
    expect(() =>
      normalizeAgentConfig({
        channels: { instagram: { id: "ig", accountId: "1/../me" } },
      }),
    ).toThrow(
      "config.channels.instagram.accountId must be the numeric Instagram account id",
    );
    expect(
      normalizeAgentConfig({
        channels: {
          instagram: {
            id: "ig",
            accessToken: "ig-token",
            accountId: "17841400000000000",
            apiVersion: "v26.0",
            appSecret: "ig-secret",
            verifyToken: "ig-verify",
          },
        },
      }),
    ).toMatchObject({
      channels: { instagram: { accountId: "17841400000000000" } },
    });
  });

  it("refuses Messenger and Instagram credentials core could not run", () => {
    // Core builds no adapter without all of them, so the channel would silently never answer.
    expect(() =>
      normalizeAgentConfig({
        channels: {
          instagram: { id: "ig", accountId: "17841400000000000" },
        },
      }),
    ).toThrow(
      "config.channels.instagram.accessToken is required when config.channels.instagram.accountId is set",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: {
          messenger: { id: "fb", pageAccessToken: "fb-token", appSecret: "s" },
        },
      }),
    ).toThrow(
      "config.channels.messenger.verifyToken is required when config.channels.messenger.appSecret is set",
    );
    // Core treats an empty credential as unset, so it would never answer either.
    expect(() =>
      normalizeAgentConfig({
        channels: {
          messenger: {
            id: "fb",
            appSecret: "  ",
            pageAccessToken: "",
            verifyToken: "",
          },
        },
      }),
    ).toThrow("config.channels.messenger.appSecret must be a non-empty string");
    expect(
      normalizeAgentConfigPatch({
        channels: { messenger: { id: "fb", pageAccessToken: "rotated" } },
      }),
    ).toEqual({
      channels: { messenger: { id: "fb", pageAccessToken: "rotated" } },
    });
  });

  it("holds WhatsApp, Teams and Google Chat to their verification settings", () => {
    expect(() =>
      normalizeAgentConfig({
        channels: {
          whatsapp: { id: "wa", apiUrl: "https://169.254.169.254" },
        },
      }),
    ).toThrow("must not point to a private or internal address");
    expect(() =>
      normalizeAgentConfig({
        channels: { whatsapp: { id: "wa", apiVersion: "../me" } },
      }),
    ).toThrow('config.channels.whatsapp.apiVersion must look like "v25.0"');
    expect(() =>
      normalizeAgentConfig({
        channels: { whatsapp: { id: "wa", phoneNumberId: " 1065403522" } },
      }),
    ).toThrow(
      "config.channels.whatsapp.phoneNumberId must be the number's digits-only ID",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: { teams: { id: "teams", appId: "app", appPassword: "pw" } },
      }),
    ).toThrow(
      'config.channels.teams.appTenantId is required unless appType is "MultiTenant"',
    );
    expect(() =>
      normalizeAgentConfig({
        channels: {
          teams: {
            id: "teams",
            appId: "app",
            appPassword: "pw",
            appTenantId: "  ",
          },
        },
      }),
    ).toThrow(
      'config.channels.teams.appTenantId is required unless appType is "MultiTenant"',
    );
    expect(
      normalizeAgentConfig({
        channels: {
          teams: { id: "teams", appId: "app", appType: "MultiTenant" },
        },
      }),
    ).toMatchObject({ channels: { teams: { appType: "MultiTenant" } } });
    expect(() =>
      normalizeAgentConfig({
        channels: { gchat: { id: "gchat", credentials: "{}" } },
      }),
    ).toThrow(
      "config.channels.gchat needs endpointUrl or googleChatProjectNumber to verify webhooks",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: {
          gchat: { id: "gchat", endpointUrl: "http://example.com/hook" },
        },
      }),
    ).toThrow("config.channels.gchat.endpointUrl must use https");
  });

  it("validates harness configs", () => {
    const harness = {
      activeTools: ["shell", "read"],
      debug: { enabled: true, level: "debug", subsystems: ["bridge"] },
      type: "codex",
      permissionMode: "allow-all",
      startupTimeoutMs: 180_000,
      webSearch: true,
    };
    expect(
      normalizeAgentConfig({ harness: harness, sandboxes: ["sandbox_1"] }),
    ).toEqual({ harness: harness, sandboxes: ["sandbox_1"] });
    expect(() =>
      normalizeAgentConfig({ harness: { type: "default" } }),
    ).toThrow(
      "config.harness.type must be one of: claude-code, codex, deepagents, opencode, pi",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "claude-code", webSearch: true },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.harness.webSearch is only supported by the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "opencode",
          activeTools: ["bash"],
          inactiveTools: ["write"],
        },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.harness must use either activeTools or inactiveTools, not both",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex", debug: { subystems: ["bridge"] } },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow('config.harness.debug has unknown option "subystems"');
    // The harness runs its own loop: broods-side policy and structured output would not apply.
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        model: { output: { type: "object", schema: { type: "object" } } },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.model.output structured output is not supported with config.harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        subagent: {
          model: { output: { type: "object", schema: { type: "object" } } },
        },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.subagent.model.output structured output is not supported with config.harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        policies: ["policy_1"],
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow("config.policies is not supported with config.harness");
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "claude-code", turbo: true },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow('config.harness has unknown option "turbo"');
    expect(() =>
      normalizeAgentConfig({ harness: { type: "claude-code" } }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the claude-code harness; the first runs it",
    );
    expect(() =>
      normalizeAgentConfig({ harness: { type: "codex" }, sandboxes: [] }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the codex harness; the first runs it",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex", permissionMode: "allow-edits" },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.harness.permissionMode must be allow-all for the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "pi", startupTimeoutMs: 1_000 },
        sandboxes: ["sandbox_1"],
      }),
    ).toThrow(
      "config.harness.startupTimeoutMs is not supported by the pi harness",
    );
  });

  it("keeps the scheduler opt-in a boolean on config and patches", () => {
    expect(normalizeAgentConfig({ scheduler: { enabled: true } })).toEqual({
      scheduler: { enabled: true },
    });
    expect(() =>
      normalizeAgentConfigPatch({ scheduler: { enabled: "yes" } }),
    ).toThrow("config.scheduler.enabled must be a boolean");
  });

  it("refuses whitespace-only entries in id lists", () => {
    expect(() =>
      normalizeAgentConfigPatch({ subagent: { allowed: ["  "] } }),
    ).toThrow("config.subagent.allowed must be an array of non-empty strings");
  });

  it("validates subagent visibility and denyTools", () => {
    expect(() =>
      normalizeAgentConfig({ subagent: { visibility: "steps" } }),
    ).toThrow("config.subagent.visibility must be one of: full, result, none");
    expect(() => normalizeAgentConfig({ denyTools: "bash" })).toThrow(
      "config.denyTools must be an array of non-empty strings",
    );
  });

  it("validates the virtual subagent model like config.model", () => {
    expect(
      normalizeAgentConfig({ subagent: { model: { modelId: "o3" } } }).subagent,
    ).toEqual({ model: { modelId: "o3" } });
    expect(() =>
      normalizeAgentConfig({ subagent: { model: { apiKey: "sk" } } }),
    ).toThrow(
      "config.subagent.model.apiKey is not supported; use config.subagent.model.providerOptions for provider-specific settings",
    );
    expect(() =>
      normalizeAgentConfig({ subagent: { model: { provider: "nope" } } }),
    ).toThrow("config.subagent.model.provider must be one of:");
  });

  it("validates subagent event streaming across full, create, update, and patch inputs", () => {
    expect(
      normalizeAgentConfig({ subagent: { stream: true } }).subagent,
    ).toMatchObject({ stream: true });
    expect(
      normalizeCreateAgentInput({
        name: "streamer",
        config: { subagent: { stream: false } },
      }).config.subagent,
    ).toMatchObject({ stream: false });
    for (const normalize of [
      () => normalizeAgentConfig({ subagent: { stream: "yes" } }),
      () =>
        normalizeCreateAgentInput({
          name: "streamer",
          config: { subagent: { stream: "yes" } },
        }),
      () =>
        normalizeUpdateAgentInput(
          {},
          {
            config: { subagent: { stream: "yes" } },
          },
        ),
      () =>
        normalizeAgentConfigPatch({
          subagent: { stream: "yes" },
        }),
    ]) {
      expect(normalize).toThrow("config.subagent.stream must be a boolean");
    }
  });

  it("accepts native Convex hook ids and rejects deprecated public ids", () => {
    const hookId = "k17zwc4z4q5ysxm74fgrhd13s88xxtv";

    expect(
      normalizeAgentConfig({ hooks: { code: [{ hookId: hookId }] } }),
    ).toEqual({ hooks: { code: [{ hookId: hookId }] } });
    expect(() =>
      normalizeAgentConfig({ tools: { tool_legacy: { enabled: true } } }),
    ).toThrow("config.tools.tool_legacy is not a supported tool");
    // Removed custom tools keyed config.tools by row id; a digit-led id names no provider tool.
    expect(() =>
      normalizeAgentConfig({
        tools: { "1s78zwc4z4q5ysxm74fgrhd13s88xxt": { enabled: true } },
      }),
    ).toThrow(
      "config.tools.1s78zwc4z4q5ysxm74fgrhd13s88xxt is not a supported tool",
    );
    expect(() =>
      normalizeAgentConfig({ hooks: { code: [{ hookId: "hook_legacy" }] } }),
    ).toThrow(
      "config.hooks.code[0].hookId must be a native Convex document id",
    );
  });

  it("merges patches and redacts secrets", () => {
    const merged = mergeAgentConfig(
      {
        provider: {
          openai: { apiKey: "secret", baseURL: "https://api.example.com" },
        },
        skills: { allowed: ["acct/old"] },
      },
      {
        provider: { openai: { apiKey: "********", baseURL: null } },
        skills: { allowed: ["acct/new"] },
      },
    );
    expect(merged).toEqual({
      provider: { openai: { apiKey: "secret" } },
      skills: { allowed: ["acct/new"] },
    });
    expect(
      redactConfigSecrets({ provider: { openai: { apiKey: "secret" } } }),
    ).toEqual({ provider: { openai: { apiKey: "********" } } });
    expect(
      redactConfigSecrets({
        provider: { openai: { apiKey: "${OVH_API_KEY}" } },
      }),
    ).toEqual({ provider: { openai: { apiKey: "${OVH_API_KEY}" } } });
    // A secret mixing literal material with a placeholder is still a secret.
    expect(
      redactConfigSecrets({
        provider: { openai: { apiKey: "sk_live_abc${OVH_API_KEY}" } },
      }),
    ).toEqual({ provider: { openai: { apiKey: "********" } } });
  });

  it("drops dangerous keys instead of rewriting the merged prototype", () => {
    // JSON.parse makes "__proto__" an own key; a plain assignment would route it to the
    // setter and hide it from every own-key walk, the normalize after the merge included.
    const patch: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"name":"ok"}',
    );
    const merged = mergeAgentConfig({}, patch);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
  });

  it("collects and substitutes only valid account env placeholders recursively", () => {
    const source = {
      provider: { apiKey: "${OVH_API_KEY}" },
      list: ["prefix-${REGION}", "${lowercase}"],
    };
    expect([...collectEnvPlaceholderNames(source)].sort()).toEqual([
      "OVH_API_KEY",
      "REGION",
    ]);
    expect(
      substituteAccountEnvPlaceholders(source, {
        OVH_API_KEY: "secret",
        REGION: "eu",
      }),
    ).toEqual({
      provider: { apiKey: "secret" },
      list: ["prefix-eu", "${lowercase}"],
    });
    const polluted: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"x": 1}, "safe": "${REGION}"}',
    );
    const substituted = substituteAccountEnvPlaceholders(polluted, {
      REGION: "eu",
    }) as Record<string, unknown>;
    expect(substituted).toEqual({ safe: "eu" });
    expect(Object.getPrototypeOf(substituted)).toBe(Object.prototype);
  });

  it("normalizes create and update inputs", () => {
    expect(
      normalizeCreateAgentInput({
        name: " Main ",
        description: " Agent ",
        config: null,
      }),
    ).toEqual({
      name: "Main",
      description: "Agent",
      config: {},
    });
    expect(
      normalizeUpdateAgentInput(
        { agent: { maxTurn: 3 } },
        {
          name: " Next ",
          description: null,
          status: "disabled",
          config: { agent: { maxTurn: 4 } },
        },
      ),
    ).toEqual({
      name: "Next",
      description: null,
      status: "disabled",
      config: { agent: { maxTurn: 4 } },
    });
    expect(() => normalizeUpdateAgentInput({}, { status: "deleted" })).toThrow(
      "status must be one of: active, disabled",
    );
  });
});

describe("mergeCanvasSandboxes", () => {
  const onCanvas = new Set(["sb_a", "sb_b", "sb_c"]);

  it("stores the canvas order, so reordering changes the default", () => {
    expect(
      mergeCanvasSandboxes(["sb_b", "sb_a"], ["sb_a", "sb_b"], onCanvas),
    ).toEqual(["sb_b", "sb_a"]);
  });

  it("keeps a stored sandbox the canvas has no node for, after the drawn ones", () => {
    expect(
      mergeCanvasSandboxes(["sb_b"], ["sb_hidden", "sb_b"], onCanvas),
    ).toEqual(["sb_b", "sb_hidden"]);
  });

  it("drops a sandbox whose node is on the canvas but no longer wired", () => {
    expect(mergeCanvasSandboxes(["sb_a"], ["sb_a", "sb_c"], onCanvas)).toEqual([
      "sb_a",
    ]);
  });
});

describe("assertAgentRuntimeRefs", () => {
  it("leaves branches a canvas save never touches to their owner", () => {
    expect(() =>
      assertAgentRuntimeRefs({
        provider: { custom: { base_url: "${BASE_URL}" } },
        sandboxes: ["sb_a"],
      }),
    ).not.toThrow();
  });
});

describe("config patch pre-validation", () => {
  it("lets a patch add a harness to an agent that already has sandboxes", () => {
    expect(
      normalizeUpdateAgentInput(
        { sandboxes: ["sb_a"] },
        { config: { harness: { type: "codex" } } },
      ).config,
    ).toEqual({ harness: { type: "codex" }, sandboxes: ["sb_a"] });
  });

  it("still refuses the merged config when no sandbox is stored", () => {
    expect(() =>
      normalizeUpdateAgentInput({}, { config: { harness: { type: "codex" } } }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the codex harness; the first runs it",
    );
  });
});

describe("isProviderToolName", () => {
  it("keeps the subagent tool names for the harness", () => {
    for (const name of [
      "ask_parent",
      "run_subagent",
      "stop_subagent",
      "update_subagent",
    ]) {
      expect(isProviderToolName(name)).toBe(false);
    }
    expect(isProviderToolName("web_search")).toBe(true);
  });
});

describe("normalizeWebhookHookConfig", () => {
  it("holds a webhook row to a public https URL and known events", () => {
    const row = { enabled: true, secret: "s", url: "https://10.0.0.8/hook" };
    expect(() => normalizeWebhookHookConfig(row, "webhook")).toThrow(
      /private or internal/,
    );
    expect(() =>
      normalizeWebhookHookConfig(
        { ...row, url: "https://example.invalid/hook", events: ["nope"] },
        "webhook",
      ),
    ).toThrow(/events must be an array of/);
  });
});

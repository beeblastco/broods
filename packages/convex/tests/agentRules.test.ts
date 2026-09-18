/** Agent config rules, the one copy the config plane and core both run. */

import { describe, expect, it } from "vitest";
import {
  assertAgentRuntimeRefs,
  defaultSandboxOf,
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  normalizeCreateAgentInput,
  mergeCanvasSandboxes,
  normalizeUpdateAgentInput,
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
    // Each index is judged in turn, so the later mount at [1] wins over the
    // repeat at [2], as in core.
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
        session: { compaction: { maxContextLength: 500_001 } },
      }),
    ).toThrow(
      "config.session.compaction.maxContextLength must be an integer from 1 to 500000",
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
    // It reaches the AI SDK as a model id, which is string-only.
    expect(() =>
      normalizeAgentConfig({ model: { transcriptionModelId: 42 } }),
    ).toThrow("config.model.transcriptionModelId must be a string");
    expect(() =>
      normalizeAgentConfig({ model: { transcriptionModelId: "whisper-1" } }),
    ).not.toThrow();
    // Inherited Object keys are not provider names, however `in` reads them.
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      expect(() =>
        normalizeAgentConfig({ model: { provider: inherited } }),
      ).toThrow("config.model.provider must be one of:");
      expect(() =>
        normalizeAgentConfig({ provider: { [inherited]: { apiKey: "k" } } }),
      ).toThrow("is not a supported provider");
    }
    // Settings a provider's AI SDK factory owns pass straight through.
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
    // Harness-owned names stay rejected; free-form provider tool names are
    // resolved against the configured provider by core at run time.
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
    // The channel configs take an index signature, so the retired spellings of
    // partition only fail if this rejects them.
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
    // The harness runs its own loop, so broods-side policy and structured
    // output would silently not apply.
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
    // Custom tools keyed config.tools by row id and are gone. A row id that
    // starts with a digit is no provider tool name, so it is refused.
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
    // JSON.parse makes "__proto__" an own key, so a plain assignment would
    // route it to the setter and hide the value from every own-key walk,
    // including the normalize pass that runs right after the merge.
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
    // Dangerous keys are dropped, not copied, when rebuilding the config.
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

describe("defaultSandboxOf", () => {
  it("reads the first of sandboxes", () => {
    expect(defaultSandboxOf({ sandboxes: ["sb_a", "sb_b"] })).toBe("sb_a");
  });

  it("finds no default without a string first entry", () => {
    expect(defaultSandboxOf({})).toBeUndefined();
    expect(defaultSandboxOf({ sandboxes: [] })).toBeUndefined();
    expect(defaultSandboxOf({ sandboxes: "sb_a" })).toBeUndefined();
    expect(defaultSandboxOf({ sandboxes: [42] })).toBeUndefined();
  });
});

// The rules a canvas save checks before it stores the refs it drew.
describe("assertAgentRuntimeRefs", () => {
  it("refuses a workspace drawn onto a later sandbox", () => {
    expect(() =>
      assertAgentRuntimeRefs({
        sandboxes: ["sb_a", "sb_b"],
        workspaces: [{ name: "repo", workspaceId: "ws_1", sandbox: "sb_b" }],
      }),
    ).toThrow(
      'config.sandboxes[1] "sb_b" also backs workspace "repo"; only the first sandbox can back a workspace',
    );
  });

  it("refuses a harness left without its default", () => {
    expect(() =>
      assertAgentRuntimeRefs({ harness: { type: "codex" } }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the codex harness; the first runs it",
    );
  });

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

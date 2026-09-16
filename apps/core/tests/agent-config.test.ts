import { describe, expect, it } from "bun:test";
import {
  isChannelTraceEnabled,
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  resolveSubagentMode,
  toRuntimeAgentConfig,
} from "../src/shared/domain/agent-config.ts";

describe("agent config validation", () => {
  // toRuntimeAgentConfig rebuilds from an explicit whitelist; a branch missing
  // there silently never reaches the harness.
  it("keeps mcp in the runtime projection", () => {
    const serverId = "k57mcpserver00000000000000000000";
    const runtime = toRuntimeAgentConfig({
      model: { provider: "vertex", modelId: "gemini-3.7-flash" },
      mcp: { [serverId]: { enabled: true } },
    });
    expect(runtime.mcp).toEqual({ [serverId]: { enabled: true } });
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
    // The channel configs take an index signature, so the retired spellings of
    // partition only fail if this rejects them.
    expect(() =>
      normalizeAgentConfig({
        channels: { slack: { id: "sl", workspaceScope: { level: "channel" } } },
      }),
    ).toThrow(
      "config.channels.slack.workspaceScope is no longer supported; use config.channels.slack.partition",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: { slack: { id: "sl", workspaceIsolationScope: "channel" } },
      }),
    ).toThrow(
      "config.channels.slack.workspaceIsolationScope is no longer supported; use config.channels.slack.partition",
    );
    expect(() =>
      normalizeAgentConfig({
        channels: { slack: { id: "sl", allowedChannelIds: [""] } },
      }),
    ).toThrow(
      "config.channels.slack.allowedChannelIds must be an array of non-empty strings",
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
    expect(isChannelTraceEnabled({}, "zalo")).toBe(false);
    expect(
      isChannelTraceEnabled(
        { channels: { zalo: { trace: "enabled" } } },
        "zalo",
      ),
    ).toBe(true);
    expect(
      isChannelTraceEnabled(
        { channels: { zalo: { trace: "disabled" } } },
        "zalo",
      ),
    ).toBe(false);
  });

  it("validates AI SDK Harness selection", () => {
    expect(
      normalizeAgentConfig({
        harness: {
          activeTools: ["shell", "read"],
          debug: {
            enabled: true,
            level: "debug",
            subsystems: ["bridge"],
          },
          type: "codex",
          permissionMode: "allow-all",
          startupTimeoutMs: 180_000,
          webSearch: true,
        },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toEqual({
      harness: {
        activeTools: ["shell", "read"],
        debug: {
          enabled: true,
          level: "debug",
          subsystems: ["bridge"],
        },
        type: "codex",
        permissionMode: "allow-all",
        startupTimeoutMs: 180_000,
        webSearch: true,
      },
      sandboxes: ["persistent-sandbox"],
    });
    expect(() => normalizeAgentConfig({ harness: { type: "other" } })).toThrow(
      "config.harness.type must be one of: claude-code, codex, deepagents, opencode, pi",
    );
    expect(normalizeAgentConfig({})).toEqual({});
    expect(() =>
      normalizeAgentConfig({ harness: { type: "default" } }),
    ).toThrow(
      "config.harness.type must be one of: claude-code, codex, deepagents, opencode, pi",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex", permissionMode: "allow-edits" },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow(
      "config.harness.permissionMode must be allow-all for the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "claude-code", webSearch: true },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow(
      "config.harness.webSearch is only supported by the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        sandboxes: ["persistent-sandbox"],
        model: {
          output: {
            type: "object",
            schema: { type: "object" },
          },
        },
      }),
    ).toThrow(
      "config.model.output structured output is not supported with config.harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        policies: ["policy-1"],
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow("config.policies is not supported with config.harness");
    // The wrapper is gone, so a config still carrying it must say so rather
    // than being dropped and silently leaving the agent ungated.
    expect(() =>
      normalizeAgentConfig({ policy: { policyIds: ["policy-1"] } }),
    ).toThrow("config.policy is no longer supported; use config.policies");
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "opencode",
          activeTools: ["bash"],
          inactiveTools: ["write"],
        },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow(
      "config.harness must use either activeTools or inactiveTools, not both",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "codex",
          webSerch: true,
        },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow('config.harness has unknown option "webSerch"');
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "codex",
          debug: { enabled: true, subystems: ["bridge"] },
        },
        sandboxes: ["persistent-sandbox"],
      }),
    ).toThrow('config.harness.debug has unknown option "subystems"');
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "pi" },
      }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the pi harness; the first runs it",
    );
    expect(() =>
      normalizeAgentConfig({ harness: { type: "pi" }, sandboxes: [] }),
    ).toThrow(
      "config.sandboxes needs at least one sandbox for the pi harness; the first runs it",
    );
  });

  it("validates sandbox references", () => {
    expect(normalizeAgentConfig({ sandboxes: ["sb_1", "sb_browser"] })).toEqual(
      { sandboxes: ["sb_1", "sb_browser"] },
    );
    expect(() => normalizeAgentConfig({ sandbox: "sb_1" })).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
    expect(() => normalizeAgentConfig({ sandboxes: "sb_1" })).toThrow(
      "config.sandboxes must be an array of non-empty strings",
    );
    expect(() => normalizeAgentConfig({ sandboxes: [""] })).toThrow(
      "config.sandboxes must be an array of non-empty strings",
    );
    expect(() => normalizeAgentConfig({ sandboxes: ["sb_a", "sb_a"] })).toThrow(
      'config.sandboxes[1] "sb_a" is listed more than once',
    );
    // The default may back a workspace; an extra never mounts one.
    const workspaces = [{ name: "repo", workspaceId: "ws_1", sandbox: "sb_a" }];
    expect(
      normalizeAgentConfig({ sandboxes: ["sb_a"], workspaces: workspaces }),
    ).toEqual({ sandboxes: ["sb_a"], workspaces: workspaces });
    expect(() =>
      normalizeAgentConfig({
        sandboxes: ["sb_default", "sb_a"],
        workspaces: workspaces,
      }),
    ).toThrow(
      'config.sandboxes[1] "sb_a" also backs workspace "repo"; only the first sandbox can back a workspace',
    );
  });

  it("refuses a stored config that still carries the removed sandbox key", () => {
    // Dropping the key would quietly make sb_b the default.
    const stored = { sandbox: "sb_a", sandboxes: ["sb_b"] };

    expect(() => toRuntimeAgentConfig(stored)).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
  });

  it("checks the harness sandbox rule on the merged config, not the patch", () => {
    // The agent already lists a sandbox, so a patch naming only the harness is valid.
    const patch = normalizeAgentConfigPatch({ harness: { type: "codex" } });

    expect(mergeAgentConfig({ sandboxes: ["sb_1"] }, patch)).toEqual({
      harness: { type: "codex" },
      sandboxes: ["sb_1"],
    });
    expect(() => mergeAgentConfig({}, patch)).toThrow(
      "config.sandboxes needs at least one sandbox for the codex harness; the first runs it",
    );
  });

  it("defaults subagents to persistent and only opts out on explicit ephemeral", () => {
    expect(resolveSubagentMode({})).toBe("persistent");
    expect(resolveSubagentMode({ subagent: { enabled: true } })).toBe(
      "persistent",
    );
    expect(resolveSubagentMode({ subagent: { mode: "persistent" } })).toBe(
      "persistent",
    );
    expect(resolveSubagentMode({ subagent: { mode: "ephemeral" } })).toBe(
      "ephemeral",
    );
  });

  it("keeps subagent event streaming opt-in and validates the flag", () => {
    expect(normalizeAgentConfig({ subagent: { enabled: true } })).toEqual({
      subagent: { enabled: true },
    });
    expect(
      normalizeAgentConfig({
        subagent: { enabled: true, stream: true },
      }),
    ).toEqual({
      subagent: { enabled: true, stream: true },
    });
    expect(
      normalizeAgentConfigPatch({
        subagent: { stream: true },
      }),
    ).toEqual({
      subagent: { stream: true },
    });
    expect(() =>
      normalizeAgentConfig({
        subagent: { stream: "yes" },
      }),
    ).toThrow("config.subagent.stream must be a boolean");
    expect(() =>
      normalizeAgentConfigPatch({
        subagent: { stream: "yes" },
      }),
    ).toThrow("config.subagent.stream must be a boolean");
  });

  it("keeps the scheduler opt-in a boolean on config and patches", () => {
    expect(normalizeAgentConfig({ scheduler: { enabled: true } })).toEqual({
      scheduler: { enabled: true },
    });
    expect(() =>
      normalizeAgentConfig({ scheduler: { enabled: "yes" } }),
    ).toThrow("config.scheduler.enabled must be a boolean");
    expect(() =>
      normalizeAgentConfigPatch({ scheduler: { enabled: "yes" } }),
    ).toThrow("config.scheduler.enabled must be a boolean");
  });

  it("uses one non-empty string-array policy for config and patches", () => {
    expect(() => normalizeAgentConfig({ skills: { allowed: [""] } })).toThrow(
      "config.skills.allowed must be an array of non-empty strings",
    );
    expect(() =>
      normalizeAgentConfigPatch({ subagent: { allowed: ["  "] } }),
    ).toThrow("config.subagent.allowed must be an array of non-empty strings");
    expect(
      normalizeAgentConfigPatch({ skills: { allowed: ["acct_test/review"] } }),
    ).toEqual({ skills: { allowed: ["acct_test/review"] } });
  });

  it("accepts native Convex resource ids and rejects deprecated public ids", () => {
    const toolId = "qs78zwc4z4q5ysxm74fgrhd13s88xxt";
    const hookId = "k17zwc4z4q5ysxm74fgrhd13s88xxtv";

    expect(
      normalizeAgentConfig({
        tools: { [toolId]: { enabled: true } },
        hooks: { code: [{ hookId: hookId }] },
      }),
    ).toMatchObject({
      tools: { [toolId]: { enabled: true } },
      hooks: { code: [{ hookId: hookId }] },
    });
    expect(() =>
      normalizeAgentConfig({ tools: { tool_legacy: { enabled: true } } }),
    ).toThrow("config.tools.tool_legacy is not a supported tool");
    expect(() =>
      normalizeAgentConfig({ hooks: { code: [{ hookId: "hook_legacy" }] } }),
    ).toThrow(
      "config.hooks.code[0].hookId must be a native Convex document id",
    );
  });

  it("rejects harness-reserved tool names but accepts free-form provider tool names", () => {
    // Whether the configured provider actually ships a named tool is resolved
    // at registry build (see tool-registry tests), not at config validation.
    expect(() =>
      normalizeAgentConfig({ tools: { bash: { enabled: true } } }),
    ).toThrow("config.tools.bash is not a supported tool");
    expect(() =>
      normalizeAgentConfig({ tools: { run_subagent: { enabled: true } } }),
    ).toThrow("config.tools.run_subagent is not a supported tool");
    expect(
      normalizeAgentConfig({ tools: { googleSearch: { enabled: true } } }),
    ).toMatchObject({ tools: { googleSearch: { enabled: true } } });
  });
  it("drops dangerous keys instead of rewriting the merged prototype", () => {
    // JSON.parse makes "__proto__" an own key, so a plain assignment would
    // route it to the setter and hide the value from every own-key walk,
    // including the normalize pass that runs right after the merge.
    const patch = JSON.parse('{"__proto__":{"polluted":"yes"},"name":"ok"}');
    const merged = mergeAgentConfig({} as never, patch) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
  });
});

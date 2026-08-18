import { describe, expect, it } from "bun:test";
import {
  isChannelTraceEnabled,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  resolveSubagentMode,
} from "../src/shared/domain/agent-config.ts";

describe("agent config validation", () => {
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
        sandbox: "persistent-sandbox",
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
      sandbox: "persistent-sandbox",
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
        sandbox: "persistent-sandbox",
      }),
    ).toThrow(
      "config.harness.permissionMode must be allow-all for the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "claude-code", webSearch: true },
        sandbox: "persistent-sandbox",
      }),
    ).toThrow(
      "config.harness.webSearch is only supported by the codex harness",
    );
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "codex" },
        sandbox: "persistent-sandbox",
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
        policy: { policyIds: ["policy-1"] },
        sandbox: "persistent-sandbox",
      }),
    ).toThrow("config.policy is not supported with config.harness");
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "opencode",
          activeTools: ["bash"],
          inactiveTools: ["write"],
        },
        sandbox: "persistent-sandbox",
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
        sandbox: "persistent-sandbox",
      }),
    ).toThrow('config.harness has unknown option "webSerch"');
    expect(() =>
      normalizeAgentConfig({
        harness: {
          type: "codex",
          debug: { enabled: true, subystems: ["bridge"] },
        },
        sandbox: "persistent-sandbox",
      }),
    ).toThrow('config.harness.debug has unknown option "subystems"');
    expect(() =>
      normalizeAgentConfig({
        harness: { type: "pi" },
      }),
    ).toThrow("config.sandbox is required for the pi harness");
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
});

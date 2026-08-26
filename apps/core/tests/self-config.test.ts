/**
 * Self-config toolset tests (ticket 21): the owner-session gate (including
 * the spoof case), the secrets-free sanitizer, proposal round-trips with the
 * config-change allowlist, and the health check naming the broken part.
 */

import { describe, expect, it } from "bun:test";
import type { Session } from "../src/harness/session.ts";
import type { ToolContext } from "../src/harness/tools/index.ts";
import { createTools } from "../src/harness/tools/index.ts";
import { createSelfConfigTools } from "../src/harness/tools/self-config.tool.ts";
import { Session as RealSession } from "../src/harness/session.ts";
import {
  directOwnerSession,
  OWNER_SESSION_HEADER,
} from "../src/harness/owner-session.ts";
import {
  isAllowedConfigChangePatch,
  sanitizeConfigForSelfInspection,
} from "../src/shared/domain/self-config.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

const MARKER = { [OWNER_SESSION_HEADER]: "1" };

const SELF_CONFIG_TOOL_NAMES = [
  "read_own_config",
  "list_skill_library",
  "list_connectors",
  "read_recent_failures",
  "run_health_check",
  "propose_skill",
  "propose_config_change",
  "propose_connector",
  "request_credential",
  "propose_context_folder",
];

function toolContext(session?: Partial<Session>): Omit<ToolContext, "config"> {
  return {
    accountId: "acct_test",
    conversationKey: "chat-owner",
    modelProviderName: "google",
    modelProvider: { tools: {} },
    ...(session ? { session: session as Session } : {}),
  };
}

describe("directOwnerSession (the load-bearing gate)", () => {
  it("honors the marker only for account auth", () => {
    expect(directOwnerSession("account", MARKER)).toBe(true);
  });

  it("SPOOF: a deployment-key caller sending the marker gets nothing", () => {
    expect(directOwnerSession("deployment", MARKER)).toBe(false);
  });

  it("admin and unauthenticated callers never get it either", () => {
    expect(directOwnerSession("admin", MARKER)).toBe(false);
    expect(directOwnerSession(undefined, MARKER)).toBe(false);
  });

  it("account auth without the marker (or with a wrong value) is not an owner session", () => {
    expect(directOwnerSession("account", {})).toBe(false);
    expect(
      directOwnerSession("account", { [OWNER_SESSION_HEADER]: "true" }),
    ).toBe(false);
    expect(directOwnerSession("account", { [OWNER_SESSION_HEADER]: "0" })).toBe(
      false,
    );
  });
});

describe("createTools owner-session gating", () => {
  it("registers the self-config tools only on an owner session", async () => {
    const tools = await createTools(
      toolContext({ ownerSession: true, agentId: "agent-1" }),
      {},
    );
    for (const name of SELF_CONFIG_TOOL_NAMES) {
      expect(Object.keys(tools)).toContain(name);
    }
  });

  it("keeps them absent without the marker (public/channel/cron shape)", async () => {
    const withoutMarker = await createTools(
      toolContext({ ownerSession: false, agentId: "agent-1" }),
      {},
    );
    const noSession = await createTools(toolContext(), {});
    for (const name of SELF_CONFIG_TOOL_NAMES) {
      expect(Object.keys(withoutMarker)).not.toContain(name);
      expect(Object.keys(noSession)).not.toContain(name);
    }
  });

  it("Session defaults ownerSession to false; cron construction stays false", () => {
    const plain = new RealSession({
      eventId: "evt",
      conversationKey: "api:x",
    });
    expect(plain.ownerSession).toBe(false);
    // The handler computes `event.ownerSession === true && !event.cronRun`;
    // assert the guard expression itself for the cron case.
    const markerSet = true as boolean;
    const cronRun: { cronId: string; runId: string } | undefined = {
      cronId: "c",
      runId: "r",
    };
    const cronSession = new RealSession({
      eventId: "evt",
      conversationKey: "api:x",
      trigger: "cron",
      ownerSession: markerSet && !cronRun,
    });
    expect(cronSession.ownerSession).toBe(false);
  });
});

describe("sanitizeConfigForSelfInspection", () => {
  const SECRETS = [
    "sk-super-secret-model-key",
    "tg-bot-token-9999",
    "xoxb-slack-secret",
    "ghp_connectortoken",
    "encrypted-blob-abc",
    "webhook-signing-secret",
  ];
  const config: AgentConfig = {
    agent: {
      name: "vertex-key-test",
      description: "test agent",
      system: "Be helpful.",
    },
    model: { provider: "google", modelId: "gemini-2.5-pro" },
    provider: { google: { apiKey: SECRETS[0] } },
    channels: {
      telegram: { botToken: SECRETS[1] },
      slack: { botToken: SECRETS[2], signingSecret: SECRETS[5] },
    } as AgentConfig["channels"],
    skills: { allowed: ["acct/skill-a"] },
    connectors: {
      allowed: [{ provider: "github", connectorId: "c1", enabled: true }],
    },
    workspaces: [{ name: "notes", workspaceId: "ws1" }],
    scheduler: { enabled: true },
    publicAccess: false,
    env: { GITHUB_TOKEN: SECRETS[3] } as never,
  } as AgentConfig;

  it("keeps the shape and drops every secret", () => {
    const view = sanitizeConfigForSelfInspection(config);
    const dumped = JSON.stringify(view);
    for (const secret of SECRETS) {
      expect(dumped).not.toContain(secret);
    }
    expect(view.name).toBe("vertex-key-test");
    expect(view.system).toBe("Be helpful.");
    expect(view.model).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(view.publicAccess).toBe(false);
    expect(view.skills.allowed).toEqual(["acct/skill-a"]);
    expect(view.connectors.allowed).toEqual([
      { provider: "github", connectorId: "c1", enabled: true },
    ]);
    expect(view.workspaces).toEqual([{ name: "notes", workspaceId: "ws1" }]);
    expect(view.channelsConfigured.sort()).toEqual(["slack", "telegram"]);
    expect(view.schedulerEnabled).toBe(true);
  });
});

describe("propose tools", () => {
  const tools = createSelfConfigTools({ accountId: "acct_test" }, {});

  async function run(name: string, input: unknown): Promise<unknown> {
    const tool = tools[name] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };

    return tool.execute(input, { toolCallId: "t", messages: [] });
  }

  it("propose_skill round-trips its payload as pending_user_review", async () => {
    const skillMd = "---\nname: greeter\ndescription: greets\n---\n\nSay hi.";
    expect(
      await run("propose_skill", {
        name: "greeter",
        description: "greets",
        skillMd: skillMd,
      }),
    ).toEqual({
      version: 1,
      status: "pending_user_review",
      proposal: {
        kind: "skill",
        payload: { name: "greeter", description: "greets", skillMd: skillMd },
      },
    });
  });

  it("propose_config_change accepts an allowlisted patch and round-trips it", async () => {
    const patch = { agent: { system: "New brief." }, model: { modelId: "x" } };
    expect(
      await run("propose_config_change", { patch: patch, reason: "why" }),
    ).toEqual({
      version: 1,
      status: "pending_user_review",
      proposal: {
        kind: "config_change",
        payload: { patch: patch, reason: "why" },
      },
    });
  });

  it("propose_config_change rejects a non-allowlisted branch", async () => {
    await expect(
      run("propose_config_change", {
        patch: { publicAccess: true },
        reason: "sneaky",
      }),
    ).rejects.toThrow("outside the allowlist");
    await expect(
      run("propose_config_change", {
        patch: { agent: { system: "ok", name: "also-change-name" } },
        reason: "half-sneaky",
      }),
    ).rejects.toThrow("outside the allowlist");
  });

  it("propose_connector, request_credential, propose_context_folder round-trip", async () => {
    expect(
      await run("propose_connector", {
        kind: "mcp",
        label: "Docs",
        url: "https://mcp.example.com",
      }),
    ).toMatchObject({
      status: "pending_user_review",
      proposal: {
        kind: "connector",
        payload: { kind: "mcp", label: "Docs", url: "https://mcp.example.com" },
      },
    });
    expect(
      await run("request_credential", {
        provider: "github",
        fields: ["token"],
        reason: "to read issues",
      }),
    ).toMatchObject({
      status: "pending_user_review",
      proposal: { kind: "credential_request" },
    });
    expect(
      await run("propose_context_folder", { name: "research" }),
    ).toMatchObject({
      status: "pending_user_review",
      proposal: { kind: "context_folder", payload: { name: "research" } },
    });
  });

  it("isAllowedConfigChangePatch edge cases", () => {
    expect(isAllowedConfigChangePatch({})).toBe(false);
    expect(isAllowedConfigChangePatch(null)).toBe(false);
    expect(isAllowedConfigChangePatch({ workspaces: [] })).toBe(true);
    expect(isAllowedConfigChangePatch({ skills: { allowed: [] } })).toBe(true);
    expect(isAllowedConfigChangePatch({ skills: { extra: 1 } })).toBe(false);
    expect(isAllowedConfigChangePatch({ connectors: { allowed: [] } })).toBe(
      true,
    );
    expect(isAllowedConfigChangePatch({ provider: {} })).toBe(false);
    expect(isAllowedConfigChangePatch({ channels: {} })).toBe(false);
  });
});

describe("run_health_check names the broken part", () => {
  async function healthCheck(config: AgentConfig): Promise<{
    checks: Array<{
      name: string;
      target: string;
      ok: boolean;
      detail: string;
    }>;
  }> {
    const tools = createSelfConfigTools(
      { accountId: "acct_test", agentId: "agent-1" },
      config,
    );
    const tool = tools.run_health_check as {
      execute: (input: unknown, options: unknown) => Promise<never>;
    };

    return tool.execute({}, { toolCallId: "t", messages: [] });
  }

  it("reports an unresolved provider key reference specifically", async () => {
    const result = await healthCheck({
      model: { provider: "google" },
      provider: { google: { apiKey: "${NO_SUCH_KEY}" } },
    });
    const model = result.checks.find((check) => check.name === "model");
    expect(model?.ok).toBe(false);
    expect(model?.target).toBe("config.provider.google.apiKey");
    expect(model?.detail).toContain("${NO_SUCH_KEY}");
  });

  it("reports a healthy resolved key and a missing provider", async () => {
    const healthy = await healthCheck({
      model: { provider: "google" },
      provider: { google: { apiKey: "real-key" } },
    });
    expect(healthy.checks.find((check) => check.name === "model")?.ok).toBe(
      true,
    );

    const missing = await healthCheck({});
    const model = missing.checks.find((check) => check.name === "model");
    expect(model?.ok).toBe(false);
    expect(model?.detail).toContain("No model provider configured");
  });

  it("reports an enabled connector whose row is gone", async () => {
    const originalQuery = runtime.query;
    runtime.query = (async () => []) as typeof runtime.query;
    try {
      const result = await healthCheck({
        model: { provider: "google" },
        provider: { google: { apiKey: "k" } },
        connectors: {
          allowed: [{ provider: "mcp", connectorId: "gone1", enabled: true }],
        },
      });
      const connector = result.checks.find(
        (check) => check.name === "connector",
      );
      expect(connector?.ok).toBe(false);
      expect(connector?.target).toBe("gone1");
      expect(connector?.detail).toContain("no longer exists");
    } finally {
      runtime.query = originalQuery;
    }
  });
});
